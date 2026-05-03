// State is stashed on `globalThis` so Next.js HMR re-imports don't leak
// duplicate timers — same trick `src/server/db.ts` uses for the Prisma
// client. Justified exception to CLAUDE.md invariant #13: the scheduler
// is out-of-band by design.
//
// Multi-instance: the in-process `inFlight` set dedupes ticks within one
// Node process. Across processes, the cross-replica guard lives at the
// data layer: `runIncrementalSync` acquires a lease via the atomic
// `sync.progress` upsert in `src/server/sync/index.ts`. A second
// replica's tick will read `acquired === false` from that upsert,
// surface as `SyncLeaseConflictError`, and exit cleanly without
// double-syncing or paging.

import "server-only";

import { isNull } from "drizzle-orm";
import { db } from "@/db";
import { projects as projectsTable } from "@/db/schema";
import type { Project } from "@/db/schema/types";
import { errFields } from "@/server/log-fields";
import { logger } from "@/server/logger";
import { loadGlobalSetting, loadProjectSetting } from "@/server/settings/effective";
import { runIncrementalSync } from "@/server/sync";

// Fallback used only on the very first tick — once running, the supervisor
// re-reads `sync.supervisor-interval-seconds` from the catalog after every
// tick and adjusts `setTimeout`. The catalog default is the source of truth;
// this constant just covers the gap before the first DB read returns.
const SUPERVISOR_FALLBACK_INTERVAL_MS = 30_000;

type SchedulerState = {
  started: boolean;
  inFlight: Set<string>;
  lastFiredAt: Map<string, number>;
  supervisor: NodeJS.Timeout | null;
};

// Stash on globalThis so Next.js HMR re-imports don't leak duplicate timers
// (same trick `src/db/client.ts` uses for the Drizzle client). Declared via
// `declare global` so the access is fully typed without an `as unknown as`
// escape.
declare global {
  var __docketSyncScheduler: SchedulerState | undefined;
}

function getState(): SchedulerState {
  globalThis.__docketSyncScheduler ??= {
    started: false,
    inFlight: new Set(),
    lastFiredAt: new Map(),
    supervisor: null,
  };
  return globalThis.__docketSyncScheduler;
}

/**
 * Idempotent — safe to call from `createContext` on every request. The
 * supervisor only spins up on the first call. After that, the boolean
 * flip on the globalThis stash short-circuits.
 *
 * The interval is re-read from `sync.supervisor-interval-seconds` after
 * each tick so an operator who bumps the catalog value sees it apply
 * within one cycle, without restarting the process.
 */
export function ensureSchedulerRunning(): void {
  const state = getState();
  if (state.started) return;
  state.started = true;
  const scheduleNext = (delayMs: number): void => {
    state.supervisor = setTimeout(() => {
      void runTickThenReschedule();
    }, delayMs);
  };
  const runTickThenReschedule = async (): Promise<void> => {
    try {
      await supervisorTick();
    } finally {
      const seconds = await loadGlobalSetting(db, "sync.supervisor-interval-seconds").catch(
        () => SUPERVISOR_FALLBACK_INTERVAL_MS / 1000,
      );
      scheduleNext(seconds * 1000);
    }
  };
  // Fire one tick immediately so the first sync doesn't have to wait for
  // the full supervisor interval after a cold boot.
  void runTickThenReschedule();
}

type SchedulerProject = Pick<
  Project,
  "id" | "ownerUserId" | "providerKind" | "providerScope" | "name"
>;

async function supervisorTick(): Promise<void> {
  try {
    const readOnly = await loadGlobalSetting(db, "app.read-only");
    if (readOnly) return;
    const projectRows = await db.query.projects.findMany({
      where: isNull(projectsTable.archivedAt),
      columns: {
        id: true,
        ownerUserId: true,
        providerKind: true,
        providerScope: true,
        name: true,
      },
    });
    for (const project of projectRows) {
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
  const state = globalThis.__docketSyncScheduler;
  if (state?.supervisor) clearTimeout(state.supervisor);
  globalThis.__docketSyncScheduler = undefined;
}
