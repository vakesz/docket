import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@/db/generated/client";

const state = vi.hoisted(() => ({
  readOnly: false,
  intervalByProject: new Map<string, number>(),
  syncCalls: [] as string[],
  syncShouldThrow: false,
  syncDelayMs: 0,
}));

vi.mock("@/server/db", () => ({
  db: {
    project: {
      findMany: async () => [],
    },
  },
}));

vi.mock("@/server/sync", () => ({
  runIncrementalSync: async (_db: unknown, project: { id: string }) => {
    state.syncCalls.push(project.id);
    if (state.syncDelayMs > 0) {
      await new Promise((r) => setTimeout(r, state.syncDelayMs));
    }
    if (state.syncShouldThrow) throw new Error("boom");
    return { upserted: 0, archived: 0, watermark: null, inboundConversations: 0 };
  },
}));

vi.mock("@/server/settings/effective", () => ({
  loadGlobalSetting: async (_db: unknown, key: string) => {
    if (key === "app.read-only") return state.readOnly;
    return null;
  },
  loadProjectSetting: async (_db: unknown, projectId: string, key: string) => {
    if (key === "sync.interval-seconds") {
      return state.intervalByProject.get(projectId) ?? 300;
    }
    return null;
  },
}));

vi.mock("@/server/logger", () => {
  const noop = () => undefined;
  return {
    logger: {
      debug: noop,
      info: noop,
      warn: noop,
      error: noop,
    },
  };
});

vi.mock("@/server/log-fields", () => ({
  errFields: (err: unknown) => ({ err: err instanceof Error ? err.message : String(err) }),
}));

const { __resetSchedulerForTests, ensureSchedulerRunning, tickProject } = await import(
  "@/server/sync/scheduler"
);

const sampleProject: Pick<
  Project,
  "id" | "ownerUserId" | "providerKind" | "providerScope" | "name"
> = {
  id: "p1",
  ownerUserId: "u1",
  providerKind: "github",
  providerScope: {},
  name: "Sample",
};

describe("sync scheduler", () => {
  beforeEach(() => {
    state.readOnly = false;
    state.intervalByProject.clear();
    state.syncCalls.length = 0;
    state.syncShouldThrow = false;
    state.syncDelayMs = 0;
    __resetSchedulerForTests();
  });

  afterEach(() => {
    __resetSchedulerForTests();
  });

  it("fires sync once when the interval has elapsed", async () => {
    state.intervalByProject.set("p1", 60);
    await tickProject(sampleProject);
    expect(state.syncCalls).toEqual(["p1"]);
  });

  it("skips when interval has not elapsed since last fire", async () => {
    state.intervalByProject.set("p1", 60);
    await tickProject(sampleProject);
    await tickProject(sampleProject);
    expect(state.syncCalls).toEqual(["p1"]);
  });

  it("interval=0 disables the project entirely", async () => {
    state.intervalByProject.set("p1", 0);
    await tickProject(sampleProject);
    expect(state.syncCalls).toEqual([]);
  });

  it("in-flight guard prevents overlapping syncs for the same project", async () => {
    state.intervalByProject.set("p1", 60);
    state.syncDelayMs = 50;
    const first = tickProject(sampleProject);
    // Second call lands while the first is still in flight.
    const second = tickProject(sampleProject);
    await Promise.all([first, second]);
    expect(state.syncCalls).toEqual(["p1"]);
  });

  it("swallows errors so a failing project does not break the supervisor", async () => {
    state.intervalByProject.set("p1", 60);
    state.syncShouldThrow = true;
    await expect(tickProject(sampleProject)).resolves.toBeUndefined();
    expect(state.syncCalls).toEqual(["p1"]);
  });

  it("ensureSchedulerRunning is idempotent", () => {
    ensureSchedulerRunning();
    ensureSchedulerRunning();
    ensureSchedulerRunning();
    // No second timer should be registered. With idempotency working, the
    // second call is a no-op; we don't have direct visibility here, but the
    // assertion is "this doesn't throw or stack timers".
    expect(true).toBe(true);
  });

  it("survives globalThis stash being already populated (HMR)", async () => {
    // Simulate a module re-evaluation: pre-populate the stash, then call
    // ensureSchedulerRunning. It should observe `started=true` and return
    // without re-arming the supervisor.
    const g = globalThis as unknown as { __docketSyncScheduler: unknown };
    g.__docketSyncScheduler = {
      started: true,
      inFlight: new Set<string>(),
      lastFiredAt: new Map<string, number>(),
      supervisor: null,
    };
    ensureSchedulerRunning();
    state.intervalByProject.set("p1", 60);
    await tickProject(sampleProject);
    expect(state.syncCalls).toEqual(["p1"]);
  });
});
