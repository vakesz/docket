import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sticky: false,
  oauthRows: [] as Record<string, unknown>[],
  llmRows: [] as Record<string, unknown>[],
}));

vi.mock("@/server/secrets/encryption", () => ({
  encryptSecret: (plain: string) => `ENC(${plain})`,
}));

vi.mock("@/server/setup/status", async () => {
  const actual =
    await vi.importActual<typeof import("@/server/setup/status")>("@/server/setup/status");
  return {
    ...actual,
    getSetupStatus: async () => ({
      complete: state.sticky || state.oauthRows.length > 0,
      hasLlm: state.llmRows.length > 0,
      hasOauth: state.oauthRows.length > 0,
    }),
  };
});

import { llmProviders, oauthProviderConfigs } from "@/db/schema";
import { applyBootstrap, BootstrapInput } from "@/server/setup/bootstrap";

type Database = Parameters<typeof applyBootstrap>[0];

function makeDb(): Database {
  // Drizzle-shape stub: covers `db.query.<table>.findFirst`,
  // `db.insert(table).values(data)`, and the chained
  // `db.select({c: count()}).from(table).where(...)` thenable. None of the
  // current tests pre-seed rows that would make findFirst hit, so it
  // always returns undefined; the role-count query always returns 0
  // because each (kind, role) is only inserted once per test.
  const stub = {
    query: {
      oauthProviderConfigs: { findFirst: async () => undefined },
      llmProviders: { findFirst: async () => undefined },
    },
    insert: (table: unknown) => ({
      values: async (data: Record<string, unknown>) => {
        if (table === oauthProviderConfigs) state.oauthRows.push(data);
        if (table === llmProviders) state.llmRows.push(data);
        return undefined;
      },
    }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ c: 0 }]),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal Drizzle stub for unit tests
  return stub as any;
}

beforeEach(() => {
  state.oauthRows = [];
  state.llmRows = [];
  state.sticky = false;
});

describe("applyBootstrap", () => {
  it("creates a GitHub OAuth row + flips setup.complete with no LLM", async () => {
    const result = await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        oauthProviders: [
          {
            typeId: "github",
            label: "GitHub",
            clientId: "Iv1.abc",
            clientSecret: "secret",
          },
        ],
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: false, hasOauth: true });
    expect(state.oauthRows).toHaveLength(1);
    expect(state.oauthRows[0]).toMatchObject({ kind: "github", clientId: "Iv1.abc" });
    expect(state.oauthRows[0]?.["clientSecret"]).toBe("ENC(secret)");
    expect(state.llmRows).toHaveLength(0);
  });

  it("creates GitHub + Azure DevOps + chat LLM in one shot", async () => {
    const result = await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        oauthProviders: [
          {
            typeId: "github",
            label: "GitHub",
            clientId: "Iv1.abc",
            clientSecret: "gh-secret",
          },
          {
            typeId: "azure_devops",
            label: "Azure DevOps",
            clientId: "azdo-app",
            clientSecret: "azdo-secret",
            aux: "00000000-0000-0000-0000-000000000000",
          },
        ],
        llms: [{ role: "chat", apiKey: "sk-test", model: "gpt-5" }],
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: true, hasOauth: true });
    expect(state.oauthRows.map((r) => r["kind"]).sort()).toEqual(["azure_devops", "github"]);
    const azdo = state.oauthRows.find((r) => r["kind"] === "azure_devops");
    expect(azdo?.["metadata"]).toEqual({ tenant: "00000000-0000-0000-0000-000000000000" });
    expect(state.llmRows[0]).toMatchObject({ kind: "openai", role: "chat", isDefault: true });
    expect(state.llmRows[0]?.["apiKey"]).toBe("ENC(sk-test)");
  });

  it("creates chat + guardrail LLM rows in one shot, each as its role's default", async () => {
    await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        oauthProviders: [
          {
            typeId: "github",
            label: "GitHub",
            clientId: "Iv1.abc",
            clientSecret: "secret",
          },
        ],
        llms: [
          { role: "chat", apiKey: "sk-chat", model: "gpt-5" },
          { role: "guardrail", apiKey: "sk-guard", model: "gpt-5-nano" },
        ],
      }),
    );
    expect(state.llmRows).toHaveLength(2);
    const chat = state.llmRows.find((r) => r["role"] === "chat");
    const guardrail = state.llmRows.find((r) => r["role"] === "guardrail");
    expect(chat).toMatchObject({ kind: "openai", role: "chat", isDefault: true });
    expect(guardrail).toMatchObject({ kind: "openai", role: "guardrail", isDefault: true });
  });

  it("BootstrapInput rejects when no OAuth provider is supplied", () => {
    expect(() =>
      BootstrapInput.parse({
        oauthProviders: [],
        llms: [{ role: "chat", apiKey: "sk-test" }],
      }),
    ).toThrow();
  });

  it("BootstrapInput rejects duplicate (kind, role) entries in llms", () => {
    expect(() =>
      BootstrapInput.parse({
        oauthProviders: [
          {
            typeId: "github",
            label: "GitHub",
            clientId: "Iv1.abc",
            clientSecret: "secret",
          },
        ],
        llms: [
          { role: "chat", apiKey: "sk-a" },
          { role: "chat", apiKey: "sk-b" },
        ],
      }),
    ).toThrow();
  });

  it("BootstrapInput rejects duplicate OAuth typeIds", () => {
    expect(() =>
      BootstrapInput.parse({
        oauthProviders: [
          { typeId: "github", label: "A", clientId: "x", clientSecret: "y" },
          { typeId: "github", label: "B", clientId: "x", clientSecret: "y" },
        ],
      }),
    ).toThrow();
  });

  it("rejects with CONFLICT once setup.complete is true", async () => {
    state.sticky = true;
    await expect(
      applyBootstrap(
        makeDb(),
        BootstrapInput.parse({
          oauthProviders: [
            {
              typeId: "github",
              label: "GitHub",
              clientId: "Iv1.abc",
              clientSecret: "secret",
            },
          ],
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.oauthRows).toHaveLength(0);
  });

  it("rejects when an Azure DevOps tenant id is missing", async () => {
    await expect(
      applyBootstrap(
        makeDb(),
        BootstrapInput.parse({
          oauthProviders: [
            {
              typeId: "azure_devops",
              label: "Azure DevOps",
              clientId: "x",
              clientSecret: "y",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });

  it("first LLM row of its role gets isDefault=true", async () => {
    await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        oauthProviders: [
          {
            typeId: "github",
            label: "GitHub",
            clientId: "Iv1.abc",
            clientSecret: "secret",
          },
        ],
        llms: [{ role: "chat", apiKey: "sk-test" }],
      }),
    );
    expect(state.llmRows[0]?.["isDefault"]).toBe(true);
  });

  it("CONFLICT is a TRPCError", async () => {
    state.sticky = true;
    await expect(
      applyBootstrap(
        makeDb(),
        BootstrapInput.parse({
          oauthProviders: [
            {
              typeId: "github",
              label: "GitHub",
              clientId: "Iv1.abc",
              clientSecret: "secret",
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
