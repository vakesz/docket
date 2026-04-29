import { describe, expect, it } from "vitest";
import {
  findTemplateByUrl,
  MCP_TEMPLATES,
  templateHeadersComplete,
  unwrapField,
  wrapField,
} from "./templates";

describe("mcp templates catalog", () => {
  it("has the expected eight templates with stable ids", () => {
    expect(MCP_TEMPLATES.map((t) => t.id)).toEqual([
      "github",
      "sentry",
      "atlassian",
      "linear",
      "notion",
      "context7",
      "deepwiki",
      "cloudflare-docs",
    ]);
  });

  it("only points at HTTPS URLs", () => {
    for (const t of MCP_TEMPLATES) {
      expect(new URL(t.url).protocol).toBe("https:");
    }
  });

  it("findTemplateByUrl matches with or without trailing slash", () => {
    expect(findTemplateByUrl("https://api.githubcopilot.com/mcp/")?.id).toBe("github");
    expect(findTemplateByUrl("https://api.githubcopilot.com/mcp")?.id).toBe("github");
    expect(findTemplateByUrl("https://example.com/")).toBeUndefined();
  });

  it("wrap/unwrap field round-trips a Bearer-prefixed token", () => {
    const github = MCP_TEMPLATES.find((t) => t.id === "github");
    expect(github).toBeDefined();
    const field = github?.fields[0];
    expect(field?.prefix).toBe("Bearer ");
    if (!field) throw new Error("github template missing field");
    const wrapped = wrapField(field, "ghp_abc");
    expect(wrapped).toBe("Bearer ghp_abc");
    expect(unwrapField(field, wrapped)).toBe("ghp_abc");
  });

  it("templateHeadersComplete reflects required fields", () => {
    const noAuth = MCP_TEMPLATES.find((t) => t.id === "deepwiki");
    expect(noAuth).toBeDefined();
    if (!noAuth) throw new Error("deepwiki template missing");
    expect(templateHeadersComplete(noAuth, {})).toBe(true);

    const github = MCP_TEMPLATES.find((t) => t.id === "github");
    expect(github).toBeDefined();
    if (!github) throw new Error("github template missing");
    expect(templateHeadersComplete(github, {})).toBe(false);
    expect(templateHeadersComplete(github, { Authorization: "Bearer " })).toBe(false);
    expect(templateHeadersComplete(github, { Authorization: "Bearer ghp_x" })).toBe(true);

    const ctx = MCP_TEMPLATES.find((t) => t.id === "context7");
    expect(ctx).toBeDefined();
    if (!ctx) throw new Error("context7 template missing");
    expect(templateHeadersComplete(ctx, { CONTEXT7_API_KEY: "ctx7sk_…" })).toBe(true);
  });
});
