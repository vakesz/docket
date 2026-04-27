import { TRPCError } from "@trpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/secrets/encryption", () => ({
  encryptSecret: (plain: string) => `ENC(${plain})`,
}));

import { applyBootstrap, BootstrapInput } from "@/server/setup/bootstrap";

type Database = Parameters<typeof applyBootstrap>[0];

const state = {
  oauthRows: [] as Array<{ id: string; kind: string; clientId: string; clientSecret: string }>,
  llmRows: [] as Array<{ id: string; kind: string; apiKey: string; isDefault: boolean }>,
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
      count: async () => state.llmRows.length,
      findFirst: async ({ where }: { where: { kind: string } }) =>
        state.llmRows.find((r) => r.kind === where.kind) ?? null,
      create: async ({ data }: { data: { kind: string; apiKey: string; isDefault: boolean } }) => {
        state.llmCreated += 1;
        const row = {
          id: `llm-${state.llmCreated}`,
          kind: data.kind,
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
        openai: null,
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: false, hasOauth: true });
    expect(state.oauthRows).toHaveLength(1);
    expect(state.oauthRows[0]).toMatchObject({ kind: "github", clientId: "Iv1.abc" });
    expect(state.oauthRows[0].clientSecret).toBe("ENC(secret)");
    expect(state.llmRows).toHaveLength(0);
    expect(state.sticky).toBe(true);
  });

  it("creates GitHub + Azure DevOps + OpenAI in one shot", async () => {
    const result = await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "gh-secret", baseUrl: "" },
        azureDevops: {
          clientId: "azdo-app",
          clientSecret: "azdo-secret",
          tenantId: "00000000-0000-0000-0000-000000000000",
        },
        openai: { apiKey: "sk-test", model: "gpt-5", baseUrl: "" },
      }),
    );
    expect(result).toEqual({ complete: true, hasLlm: true, hasOauth: true });
    expect(state.oauthRows.map((r) => r.kind).sort()).toEqual(["azure_devops", "github"]);
    expect(state.llmRows[0]).toMatchObject({ kind: "openai", isDefault: true });
    expect(state.llmRows[0].apiKey).toBe("ENC(sk-test)");
  });

  it("BootstrapInput rejects when neither OAuth section is provided", () => {
    expect(() =>
      BootstrapInput.parse({
        github: null,
        azureDevops: null,
        openai: { apiKey: "sk-test", model: "", baseUrl: "" },
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
          openai: null,
        }),
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(state.oauthRows).toHaveLength(0);
  });

  it("first LLM row gets isDefault=true", async () => {
    await applyBootstrap(
      makeDb(),
      BootstrapInput.parse({
        github: { clientId: "Iv1.abc", clientSecret: "secret", baseUrl: "" },
        azureDevops: null,
        openai: { apiKey: "sk-test", model: "", baseUrl: "" },
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
          openai: null,
        }),
      ),
    ).rejects.toBeInstanceOf(TRPCError);
  });
});
