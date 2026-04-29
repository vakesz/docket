/**
 * Architecture guard: every registered agent tool declares its
 * `guardrailScan` classification.
 *
 * The default at the loop level is `mode: "full"` so a forgotten tag
 * doesn't silently weaken the safety story. But forgetting *is* an
 * oversight — the cost of a default-full on a structured-only payload
 * is unnecessary guardrail-LLM calls and the false-positive blocks that
 * step 1 of the redesign was built to fix. This test fails CI if any
 * tool ships without an explicit decision, and pins the expected mode
 * for each well-known tool name so a refactor that flips a `skip` back
 * to `full` (or vice versa) is caught at review.
 *
 * MCP tools are dynamic — the bridge in `src/agent/mcp/tools.ts` tags
 * them at adapt-time, and the test asserts the bridge does so on a
 * representative stubbed schema.
 */

import { describe, expect, it } from "vitest";
import { mcpTools } from "@/agent/mcp/tools";
import { buildToolRegistry } from "@/agent/tools/registry";
import type { GuardrailScan, ToolContext } from "@/agent/tools/types";

type ScanMode = GuardrailScan["mode"];

/**
 * Pinned scan classification per tool name. Updating this map is the
 * deliberate way to declare "I thought about this tool's untrusted
 * surface and chose X". Drift from the actual factory tag fails this
 * test.
 */
const EXPECTED: Record<string, ScanMode> = {
  // (1) readonly
  list_items: "fields",
  get_item: "fields",
  get_pull_request: "fields",
  get_commit: "fields",
  get_ci_status: "fields",
  // (2) links
  find_related_pull_requests: "fields",
  // (3) memory readonly
  list_memory: "fields",
  get_memory: "fields",
  // (4) source readonly
  list_sources: "fields",
  read_source: "fields",
  search_sources: "fields",
  // (6) provider mutating
  propose_transition: "skip",
  propose_description_patch: "skip",
  propose_comment: "skip",
  propose_new_item: "skip",
  propose_item_tags: "skip",
  // (7) memory mutating
  propose_memory_write: "skip",
  propose_memory_delete: "skip",
  // out-of-band
  ask_user_question: "skip",
  // (8) web_fetch
  web_fetch: "full",
  // (9) discovery
  search_items: "fields",
  list_audit: "fields",
  get_pull_request_diff: "fields",
  search_code: "skip",
  search_pull_requests: "fields",
};

const fakeCtx: ToolContext = {
  db: {
    mcpServerConfig: { findMany: async () => [] },
    setting: { findFirst: async () => null },
  } as unknown as ToolContext["db"],
  projectId: "proj_arch_test",
  userId: "user_arch_test",
  itemId: null,
  providerItemId: null,
};

describe("arch: guardrail-scan coverage", () => {
  it("every registered tool declares a guardrailScan field", async () => {
    const tools = await buildToolRegistry(fakeCtx, { readOnly: false });
    const missing = tools.filter((t) => t.guardrailScan === undefined).map((t) => t.def.name);
    expect(missing).toEqual([]);
  });

  it("each tool's scan mode matches the pinned expectation", async () => {
    const tools = await buildToolRegistry(fakeCtx, { readOnly: false });
    const actual: Record<string, ScanMode> = {};
    for (const tool of tools) {
      const scan = tool.guardrailScan;
      if (!scan) continue;
      actual[tool.def.name] = scan.mode;
    }
    expect(actual).toEqual(EXPECTED);
  });

  it("the EXPECTED map covers every registered tool with no extras", async () => {
    const tools = await buildToolRegistry(fakeCtx, { readOnly: false });
    const registered = new Set(tools.map((t) => t.def.name));
    const expected = new Set(Object.keys(EXPECTED));
    const missingFromExpected = [...registered].filter((n) => !expected.has(n));
    const orphanedInExpected = [...expected].filter((n) => !registered.has(n));
    expect({ missingFromExpected, orphanedInExpected }).toEqual({
      missingFromExpected: [],
      orphanedInExpected: [],
    });
  });

  it("MCP tools are tagged `mode: full` by the bridge", async () => {
    // Stub one server that advertises one tool, and assert the adapted
    // AgentTool carries `guardrailScan: { mode: "full" }`. This covers
    // the dynamic slot the registry-level test can't reach.
    const ctxWithServer: ToolContext = {
      ...fakeCtx,
      db: {
        mcpServerConfig: {
          findMany: async () => [
            {
              id: "srv_1",
              name: "ledger",
              url: "https://example.invalid/mcp",
              headersJson: {},
              enabled: true,
              projectId: "proj_arch_test",
            },
          ],
        },
      } as unknown as ToolContext["db"],
    };

    // Stub the network calls so listMcpTools doesn't actually hit a server.
    const { vi } = await import("vitest");
    const mcpClient = await import("@/agent/mcp/client");
    const listSpy = vi.spyOn(mcpClient, "listMcpTools").mockResolvedValue([
      {
        name: "search",
        description: "search the ledger",
        inputSchema: { type: "object", properties: {} },
      },
    ]);

    try {
      const built = await mcpTools(ctxWithServer);
      expect(built).toHaveLength(1);
      expect(built[0]?.guardrailScan).toEqual({ mode: "full" });
      expect(built[0]?.def.name).toBe("ledger__search");
    } finally {
      listSpy.mockRestore();
    }
  });
});
