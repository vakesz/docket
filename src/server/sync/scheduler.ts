// State is stashed on `globalThis` so Next.js HMR re-imports don't leak
// duplicate timers — same trick `src/server/db.ts` uses for the Prisma
// client. Justified exception to CLAUDE.md invariant #13: the scheduler
// is out-of-band by design.
//
// Multi-instance: assumes one Node process. A second instance would
// double-sync until a `pg_try_advisory_lock` is wired into `tickProject`.

import "server-only";

import { asProjectId, asUserId } from "@/core/types";
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
  // Project rows arrive from Prisma with plain string ids; brand here so
  // the typed sync API doesn't have to widen.
  const projectId = asProjectId(project.id);
  const ownerUserId = asUserId(project.ownerUserId);
  const intervalSeconds = await loadProjectSetting(db, projectId, "sync.interval-seconds");
  if (intervalSeconds === 0) return;
  const lastFiredAt = state.lastFiredAt.get(project.id) ?? 0;
  if (Date.now() - lastFiredAt < intervalSeconds * 1000) return;
  state.lastFiredAt.set(project.id, Date.now());
  state.inFlight.add(project.id);
  try {
    await runIncrementalSync(db, project, ownerUserId);
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
