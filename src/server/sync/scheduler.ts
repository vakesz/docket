/**
 * Server-side periodic sync scheduler.
 *
 * Runs one incremental sync per project on the cadence configured by the
 * project's `sync.interval-seconds` setting. Replaces the per-tab
 * `useBackgroundSync` hook so N tabs × M users on the same project don't
 * each fire their own sync, and so list refetches don't fan out across
 * every open browser on every tick.
 *
 * Design — kept deliberately small:
 *   - One supervisor `setInterval` walks all non-archived projects every
 *     SUPERVISOR_INTERVAL_MS. Each project that's due (interval elapsed
 *     since `lastFiredAt`) and not already in flight gets a sync.
 *   - State is stashed on `globalThis` so Next.js HMR re-imports don't
 *     leak duplicate timers — same trick `src/server/db.ts` uses for the
 *     Prisma client. Justified exception to invariant #13: the scheduler
 *     is out-of-band by design (timer-driven, not request-driven), so a
 *     module-level singleton is the right shape.
 *   - Sync runs as the project's `ownerUserId` (the canonical actor
 *     `buildProviderForUser` requires).
 *   - `app.read-only` short-circuits the supervisor entirely.
 *
 * Multi-instance: this currently assumes one Node process. Adding a second
 * instance would double-sync until a `pg_try_advisory_lock` is wired into
 * `tickProject`. Cheap to add when needed; deliberately omitted now.
 */

import "server-only";

import type { Project } from "@/db/generated/client";
import { db } from "@/server/db";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { loadGlobalSetting, loadProjectSetting } from "@/server/settings/effective";
import { runIncrementalSync } from "@/server/sync";

const SUPERVISOR_INTERVAL_MS = 30_000;

type SchedulerState = {
  started: boolean;
  inFlight: Set<string>;
  lastFiredAt: Map<string, number>;
  supervisor: NodeJS.Timeout | null;
};

// Stash on globalThis so Next.js HMR re-imports don't leak duplicate timers
// (same trick `src/server/db.ts` uses for the Prisma client). Cast through
// `unknown` so we don't have to declare a global var.
const globalForScheduler = globalThis as unknown as {
  __docketSyncScheduler?: SchedulerState;
};

function getState(): SchedulerState {
  if (!globalForScheduler.__docketSyncScheduler) {
    globalForScheduler.__docketSyncScheduler = {
      started: false,
      inFlight: new Set(),
      lastFiredAt: new Map(),
      supervisor: null,
    };
  }
  return globalForScheduler.__docketSyncScheduler;
}

/**
 * Idempotent — safe to call from `createContext` on every request. The
 * supervisor only spins up on the first call. After that, the boolean
 * flip on the globalThis stash short-circuits.
 */
export function ensureSchedulerRunning(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  // Fire one tick immediately so the first sync doesn't have to wait for
  // the full supervisor interval after a cold boot.
  void supervisorTick();
  state.supervisor = setInterval(() => {
    void supervisorTick();
  }, SUPERVISOR_INTERVAL_MS);
}

type SchedulerProject = Pick<
  Project,
  "id" | "ownerUserId" | "providerKind" | "providerScope" | "name"
>;

async function supervisorTick(): Promise<void> {
  try {
    const readOnly = await loadGlobalSetting(db, "app.read-only");
    if (readOnly) return;
    const projects = await db.project.findMany({
      where: { archivedAt: null },
      select: {
        id: true,
        ownerUserId: true,
        providerKind: true,
        providerScope: true,
        name: true,
      },
    });
    for (const project of projects) {
      void tickProject(project);
    }
  } catch (err) {
    logger.error({ ...errFields(err) }, "sync scheduler: supervisor failed");
  }
}

/**
 * Fire one sync for `project` if its interval has elapsed and no sync is
 * in flight. Errors are logged and swallowed — a failing project must not
 * bring down the supervisor or block other projects' ticks.
 *
 * Exported so tests can drive it directly without spinning up timers.
 */
export async function tickProject(project: SchedulerProject): Promise<void> {
  const state = getState();
  if (state.inFlight.has(project.id)) return;
  const intervalSeconds = await loadProjectSetting(db, project.id, "sync.interval-seconds");
  if (intervalSeconds === 0) return;
  const lastFiredAt = state.lastFiredAt.get(project.id) ?? 0;
  if (Date.now() - lastFiredAt < intervalSeconds * 1000) return;
  state.lastFiredAt.set(project.id, Date.now());
  state.inFlight.add(project.id);
  try {
    await runIncrementalSync(db, project, project.ownerUserId);
  } catch (err) {
    logger.error({ projectId: project.id, ...errFields(err) }, "sync scheduler: tick failed");
  } finally {
    state.inFlight.delete(project.id);
  }
}

/** Test-only: clear the globalThis stash and stop the supervisor. */
export function __resetSchedulerForTests(): void {
  const state = globalForScheduler.__docketSyncScheduler;
  if (state?.supervisor) clearInterval(state.supervisor);
  delete globalForScheduler.__docketSyncScheduler;
}
