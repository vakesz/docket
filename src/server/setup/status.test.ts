import { describe, expect, it } from "vitest";
import type { db as Db } from "@/server/db";
import { getSetupStatus } from "@/server/setup/status";

type Database = typeof Db;

type SettingRow = { id: string; value: string };

type MockState = {
  llmCount: number;
  oauthCount: number;
  setupRow: SettingRow | null;
  writes: Array<{ op: "create" | "update"; value: string }>;
};

function makeMockDb(state: MockState): Database {
  return {
    llmProvider: {
      count: async () => state.llmCount,
    },
    oauthProviderConfig: {
      count: async () => state.oauthCount,
    },
    setting: {
      findFirst: async () => state.setupRow,
      create: async ({ data }: { data: { value: string } }) => {
        state.writes.push({ op: "create", value: data.value });
        state.setupRow = { id: "row-1", value: data.value };
        return state.setupRow;
      },
      update: async ({ data }: { data: { value: string } }) => {
        state.writes.push({ op: "update", value: data.value });
        if (state.setupRow) state.setupRow = { ...state.setupRow, value: data.value };
        return state.setupRow;
      },
    },
  } as unknown as Database;
}

describe("getSetupStatus", () => {
  it("reports incomplete when no OAuth row exists — no write", async () => {
    const state: MockState = { llmCount: 0, oauthCount: 0, setupRow: null, writes: [] };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status).toEqual({ complete: false, hasLlm: false, hasOauth: false });
    expect(state.writes).toEqual([]);
  });

  it("LLM alone is not enough — bit stays unflipped without an OAuth row", async () => {
    const state: MockState = { llmCount: 1, oauthCount: 0, setupRow: null, writes: [] };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status).toEqual({ complete: false, hasLlm: true, hasOauth: false });
    expect(state.writes).toEqual([]);
  });

  it("flips the sticky bit on first observation of an OAuth row, even without an LLM", async () => {
    const state: MockState = { llmCount: 0, oauthCount: 1, setupRow: null, writes: [] };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status).toEqual({ complete: true, hasLlm: false, hasOauth: true });
    expect(state.writes).toEqual([{ op: "create", value: JSON.stringify(true) }]);
  });

  it("flips the sticky bit when both halves exist", async () => {
    const state: MockState = { llmCount: 1, oauthCount: 1, setupRow: null, writes: [] };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status).toEqual({ complete: true, hasLlm: true, hasOauth: true });
    expect(state.writes).toEqual([{ op: "create", value: JSON.stringify(true) }]);
  });

  it("does not re-write the sticky bit once already true", async () => {
    const state: MockState = {
      llmCount: 2,
      oauthCount: 1,
      setupRow: { id: "existing", value: JSON.stringify(true) },
      writes: [],
    };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status.complete).toBe(true);
    expect(state.writes).toEqual([]);
  });

  it("stays complete via sticky bit even when rows have since been removed", async () => {
    const state: MockState = {
      llmCount: 0,
      oauthCount: 0,
      setupRow: { id: "existing", value: JSON.stringify(true) },
      writes: [],
    };
    const status = await getSetupStatus(makeMockDb(state));
    expect(status).toEqual({ complete: true, hasLlm: false, hasOauth: false });
    expect(state.writes).toEqual([]);
  });
});
