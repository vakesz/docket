import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hasLlm: false,
  hasOauth: false,
  sticky: false,
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    // Mirror Next.js's redirect-throws-special-error contract just enough
    // for tests to observe the path that was passed.
    throw new Error(`REDIRECT:${path}`);
  },
}));

vi.mock("@/db", () => ({ db: {} }));

vi.mock("@/server/setup/status", () => ({
  getSetupStatus: async () => ({
    complete: state.sticky || state.hasOauth,
    hasLlm: state.hasLlm,
    hasOauth: state.hasOauth,
  }),
}));

const { requireSetupComplete } = await import("@/server/setup/guard");

describe("requireSetupComplete", () => {
  beforeEach(() => {
    state.hasLlm = false;
    state.hasOauth = false;
    state.sticky = false;
  });

  it("redirects to /setup-required when nothing is configured", async () => {
    await expect(requireSetupComplete()).rejects.toThrow("REDIRECT:/setup-required");
  });

  it("redirects when only LLM is configured (OAuth still required)", async () => {
    state.hasLlm = true;
    await expect(requireSetupComplete()).rejects.toThrow("REDIRECT:/setup-required");
  });

  it("returns status when an OAuth row exists, even without an LLM", async () => {
    state.hasOauth = true;
    const status = await requireSetupComplete();
    expect(status).toEqual({ complete: true, hasLlm: false, hasOauth: true });
  });

  it("returns status when both halves are configured", async () => {
    state.hasLlm = true;
    state.hasOauth = true;
    const status = await requireSetupComplete();
    expect(status).toEqual({ complete: true, hasLlm: true, hasOauth: true });
  });

  it("returns status without redirecting when sticky bit is already set", async () => {
    state.sticky = true;
    const status = await requireSetupComplete();
    expect(status.complete).toBe(true);
  });
});
