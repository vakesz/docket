/**
 * web_fetch tool — branch coverage for the cleaning + raw paths.
 *
 * The cleaner itself is exercised in web-fetch-clean.test.ts. These tests
 * pin behaviour at the tool boundary: which response shape the agent sees,
 * which audit row gets written, and how `raw: true` opts out.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "@/agent/tools/types";

const settings = vi.hoisted(() => ({
  enabled: true as boolean,
  allowlist: [] as string[],
  maxBytes: 200_000 as number,
}));

const auditLog = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[] }));

vi.mock("@/server/settings/effective", () => ({
  loadProjectSetting: async (_db: unknown, _projectId: string, key: string) => {
    if (key === "web-fetch.enabled") return settings.enabled;
    if (key === "web-fetch.allowed-hosts") return settings.allowlist;
    if (key === "web-fetch.max-bytes") return settings.maxBytes;
    throw new Error(`unmocked setting ${key}`);
  },
}));

vi.mock("@/server/web-fetch/audit", () => ({
  recordWebFetchEvent: async (_db: unknown, row: Record<string, unknown>) => {
    auditLog.rows.push(row);
  },
}));

vi.mock("@/server/web-fetch/ssrf", () => ({
  assertFetchTargetSafe: async (url: URL) => ({
    ok: true,
    host: url.hostname,
    resolvedIps: ["93.184.216.34"],
  }),
}));

const { webFetchTool } = await import("@/agent/tools/web-fetch");

const ctx: ToolContext = {
  db: {} as unknown as ToolContext["db"],
  projectId: "proj_1",
  userId: "user_1",
  itemId: null,
  providerItemId: null,
};

function mockFetchOnce(body: string, contentType: string, status = 200): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const encoder = new TextEncoder();
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(body));
          controller.close();
        },
      });
      return new Response(stream, {
        status,
        headers: { "content-type": contentType },
      });
    }),
  );
}

beforeEach(() => {
  settings.enabled = true;
  settings.allowlist = [];
  settings.maxBytes = 200_000;
  auditLog.rows.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

type ToolOk = { ok: true; data: Record<string, unknown> };

async function callTool(args: Record<string, unknown>): Promise<ToolOk["data"]> {
  const tool = webFetchTool(ctx);
  const result = (await tool.handler(args)) as
    | { ok: true; data: Record<string, unknown> }
    | { ok: false; error: string };
  if (!result.ok) throw new Error(`tool failed: ${result.error}`);
  return result.data;
}

describe("web_fetch tool", () => {
  it("cleans HTML responses by default", async () => {
    mockFetchOnce(
      `<!doctype html><html><head><title>x</title><script>app()</script></head><body><h1>Hi</h1><p>Body.</p></body></html>`,
      "text/html; charset=utf-8",
    );
    const data = await callTool({ url: "https://example.com/page" });
    expect(data.cleaned).toBe(true);
    expect(typeof data.cleanedBytes).toBe("number");
    expect(data.body as string).toContain("# Hi");
    expect(data.body as string).toContain("Body.");
    expect(data.body as string).not.toContain("<script");
    expect(data.body as string).not.toContain("<head");
    expect(auditLog.rows.at(-1)?.cleaned).toBe(true);
  });

  it("returns the raw body when raw=true", async () => {
    const rawBody = `<!doctype html><html><body><h1>Hi</h1></body></html>`;
    mockFetchOnce(rawBody, "text/html");
    const data = await callTool({ url: "https://example.com/page", raw: true });
    expect(data.cleaned).toBeNull();
    expect(data.body).toBe(rawBody);
    expect(auditLog.rows.at(-1)?.cleaned ?? null).toBeNull();
  });

  it("passes JSON responses through untouched", async () => {
    const jsonBody = `{"hello":"world"}`;
    mockFetchOnce(jsonBody, "application/json");
    const data = await callTool({ url: "https://api.example.com/x" });
    expect(data.cleaned).toBeNull();
    expect(data.body).toBe(jsonBody);
  });

  it("cleans HTML even when truncated mid-body", async () => {
    settings.maxBytes = 80;
    const html = `<!doctype html><html><body><h1>Heading</h1><p>Some readable content that fits</p><p>This trailing paragraph will be truncated by the byte cap.</p></body></html>`;
    mockFetchOnce(html, "text/html");
    const data = await callTool({ url: "https://example.com/long" });
    expect(data.truncated).toBe(true);
    expect(data.cleaned).toBe(true);
    expect(data.body as string).toContain("Heading");
  });

  it("falls back to raw with cleanError when cleaned output is empty", async () => {
    // Page with only a <script> in the body — after stripping, cleanHtml
    // throws EmptyCleanedOutputError and the tool falls back to raw.
    const html = `<!doctype html><html><head></head><body><script>boot()</script></body></html>`;
    mockFetchOnce(html, "text/html");
    const data = await callTool({ url: "https://example.com/spa" });
    expect(data.cleaned).toBe(false);
    expect(data.cleanError).toMatch(/empty/i);
    expect(data.body).toBe(html);
    expect(auditLog.rows.at(-1)?.cleaned).toBe(false);
    expect(auditLog.rows.at(-1)?.cleanError).toMatch(/empty/i);
  });

  it("cleans XML that sniffs as HTML", async () => {
    const html = `<!DOCTYPE html><html><body><p>XHTML-ish.</p></body></html>`;
    mockFetchOnce(html, "application/xml");
    const data = await callTool({ url: "https://example.com/feed.xml" });
    expect(data.cleaned).toBe(true);
    expect(data.body as string).toContain("XHTML-ish.");
  });

  it("does NOT clean genuine XML payloads", async () => {
    const xml = `<?xml version="1.0"?><feed><entry><title>x</title></entry></feed>`;
    mockFetchOnce(xml, "application/xml");
    const data = await callTool({ url: "https://example.com/feed" });
    expect(data.cleaned).toBeNull();
    expect(data.body).toBe(xml);
  });
});
