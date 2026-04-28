import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/secrets/encryption", () => ({
  encryptSecret: (plain: string) => `ENC(${plain})`,
}));

import { applyBootstrap, BootstrapInput } from "@/server/setup/bootstrap";

type Database = Parameters<typeof applyBootstrap>[0];

const state = {
  oauthRows: [] as Array<{ id: string; kind: string; clientId: string; clientSecret: string }>,
  llmRows: [] as Array<{
    id: string;
    kind: string;
    role: string;
    apiKey: string;
    isDefault: boolean;
  }>,
  sticky: false,
  oauthCreated: 0,
  llmCreated: 0,
};

function makeDb(): Database {
  return {
    oauthProviderConfig: {
      count: async () => state.oauthRows.length,
      findFirst: async ({ where }: { where: { kind: string } }) =>
        state.oauthRows.find((r) => r.kind === where.kind) ?? null,
      create: async ({
        data,
      }: {
        data: { kind: string; clientId: string; clientSecret: string };
      }) => {
        state.oauthCreated += 1;
        const row = {
          id: `oauth-${state.oauthCreated}`,
          kind: data.kind,
          clientId: data.clientId,
          clientSecret: data.clientSecret,
        };
        state.oauthRows.push(row);
        return row;
      },
    },
    llmProvider: {
      count: async ({ where }: { where?: { role?: string } } = {}) =>
        where?.role
          ? state.llmRows.filter((r) => r.role === where.role).length
          : state.llmRows.length,
      findFirst: async ({ where }: { where: { kind?: string; role?: string } }) =>
        state.llmRows.find(
          (r) =>
            (where.kind === undefined || r.kind === where.kind) &&
            (where.role === undefined || r.role === where.role),
        ) ?? null,
      create: async ({
        data,
      }: {
        data: { kind: string; role: string; apiKey: string; isDefault: boolean };
      }) => {
        state.llmCreated += 1;
        const row = {
          id: `llm-${state.llmCreated}`,
          kind: data.kind,
          role: data.role,
          apiKey: data.apiKey,
          isDefault: data.isDefault,
        };
        state.llmRows.push(row);
        return row;
      },
    },
    setting: {
      findFirst: async () => (state.sticky ? { id: "s", value: JSON.stringify(true) } : null),
      create: async () => {
        state.sticky = true;
        return { id: "s", value: JSON.stringify(true) };
      },
      update: async () => ({ id: "s", value: JSON.stringify(true) }),
    },
    // biome-ignore lint/suspicious/noExplicitAny: test double — only the methods used by applyBootstrap matter
  } as any;
}

beforeEach(() => {
  state.oauthRows = [];
  state.llmRows = [];
  state.sticky = false;
  state.oauthCreated = 0;
  state.llmCreated = 0;
});

describe("applyBootstrap", () => {
  it("creates a GitHub OAuth row + flips setup.complete with no LLM", async () => {
    const result = await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
        azureDevops: null,
        llms: [],
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: false, hasOauth: true });
    expect(state.oauthRows).toHaveLength(1);
    expect(state.oauthRows[0]).toMatchObject({ kind: "github", clientId: "Iv1.abc" });
    expect(state.oauthRows[0].clientSecret).toBe("ENC(secret)");
    expect(state.llmRows).toHaveLength(0);
    expect(state.sticky).toBe(true);
  });

  it("creates GitHub + Azure DevOps + chat LLM in one shot", async () => {
    const result = await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "gh-secret", baseUrl: "" },
        azureDevops: {
          clientId: "azdo-app",
          clientSecret: "azdo-secret",
          tenantId: "00000000-0000-0000-0000-000000000000",
        },
        llms: [{ role: "chat", apiKey: "sk-test", model: "gpt-5", baseUrl: "" }],
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: true, hasOauth: true });
    expect(state.oauthRows.map((r) => r.kind).sort()).toEqual(["azure_devops", "github"]);
    expect(state.llmRows[0]).toMatchObject({ kind: "openai", role: "chat", isDefault: true });
    expect(state.llmRows[0].apiKey).toBe("ENC(sk-test)");
  });

  it("creates chat + guardrail LLM rows in one shot, each as its role's default", async () => {
    await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
        azureDevops: null,
        llms: [
          { role: "chat", apiKey: "sk-chat", model: "gpt-5", baseUrl: "" },
          { role: "guardrail", apiKey: "sk-guard", model: "gpt-5-nano", baseUrl: "" },
        ],
      }),
    );
    expect(state.llmRows).toHaveLength(2);
    const chat = state.llmRows.find((r) => r.role === "chat");
    const guardrail = state.llmRows.find((r) => r.role === "guardrail");
    expect(chat).toMatchObject({ kind: "openai", role: "chat", isDefault: true });
    expect(guardrail).toMatchObject({ kind: "openai", role: "guardrail", isDefault: true });
  });

  it("BootstrapInput rejects when neither OAuth section is provided", () => {
    expect(() =>
      BootstrapInput.parse({
        github: null,
        azureDevops: null,
        llms: [{ role: "chat", apiKey: "sk-test", model: "", baseUrl: "" }],
      }),
    ).toThrow();
  });

  it("BootstrapInput rejects duplicate (kind, role) entries in llms", () => {
    expect(() =>
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
        azureDevops: null,
        llms: [
          { role: "chat", apiKey: "sk-a", model: "", baseUrl: "" },
          { role: "chat", apiKey: "sk-b", model: "", baseUrl: "" },
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
          github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
          azureDevops: null,
          llms: [],
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.oauthRows).toHaveLength(0);
  });

  it("first LLM row of its role gets isDefault=true", async () => {
    await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
        azureDevops: null,
        llms: [{ role: "chat", apiKey: "sk-test", model: "", baseUrl: "" }],
      }),
    );
    expect(state.llmRows[0].isDefault).toBe(true);
  });

  it("CONFLICT is a TRPCError", async () => {
    state.sticky = true;
    await expect(
      applyBootstrap(
        makeDb(),
        BootstrapInput.parse({
          github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
          azureDevops: null,
          llms: [],
        }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
