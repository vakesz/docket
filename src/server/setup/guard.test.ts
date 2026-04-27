import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  llm: 0,
  oauth: 0,
  sticky: false,
  writes: [] as string[],
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    // Mirror Next.js's redirect-throws-special-error contract just enough
    // for tests to observe the path that was passed.
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("@/server/db", () => ({
  db: {
    llmProvider: { count: async () => state.llm },
    oauthProviderConfig: { count: async () => state.oauth },
    setting: {
      findFirst: async () => (state.sticky ? { id: "x", value: JSON.stringify(true) } : null),
      create: async ({ data }: { data: { value: string } }) => {
        state.writes.push(data.value);
        state.sticky = true;
        return { id: "x", value: data.value };
      },
      update: async ({ data }: { data: { value: string } }) => {
        state.writes.push(data.value);
        return { id: "x", value: data.value };
      },
    },
  },
}));

const { requireSetupComplete } = await import("@/server/setup/guard");

describe("requireSetupComplete", () => {
  beforeEach(() => {
    state.llm = 0;
    state.oauth = 0;
    state.sticky = false;
    state.writes.length = 0;
  });

  it("redirects to /setup-required when nothing is configured", async () => {
    await expect(requireSetupComplete()).rejects.toThrow("REDIRECT:/setup-required");
    expect(state.writes).toEqual([]);
  });

  it("redirects when only LLM is configured (OAuth still required)", async () => {
    state.llm = 1;
    await expect(requireSetupComplete()).rejects.toThrow("REDIRECT:/setup-required");
  });

  it("returns status (and flips sticky bit) when an OAuth row exists, even without an LLM", async () => {
    state.oauth = 1;
    const status = await requireSetupComplete();
    expect(status).toEqual({ complete: true, hasLlm: false, hasOauth: true });
    expect(state.writes).toEqual([JSON.stringify(true)]);
  });

  it("returns status when both halves are configured", async () => {
    state.llm = 1;
    state.oauth = 1;
    const status = await requireSetupComplete();
    expect(status).toEqual({ complete: true, hasLlm: true, hasOauth: true });
    expect(state.writes).toEqual([JSON.stringify(true)]);
  });

  it("returns status without redirecting when sticky bit is already set", async () => {
    state.sticky = true;
    const status = await requireSetupComplete();
    expect(status.complete).toBe(true);
    expect(state.writes).toEqual([]);
  });
});
