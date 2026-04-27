/**
 * web_fetch — agent tool for reading public URLs.
 *
 * Read-only on the *outside* world (no provider state changes), but it
 * still has a meaningful blast radius: a careless prompt could trick
 * the agent into requesting an internal admin URL, an SSH-style
 * meta-data endpoint, or a URL that returns a multi-GB payload. The
 * pipeline:
 *
 *   1. Per-project `web-fetch.enabled` toggle (audit `denied_disabled`)
 *   2. Optional per-project host allowlist (audit `denied_host_allowlist`)
 *   3. SSRF guard (`assertFetchTargetSafe`, audit `denied_*` from there)
 *   4. Bounded fetch — `AbortController` 10 s timeout, max-bytes cap
 *      from settings (audit `denied_size` on overflow, `error` on a
 *      transport failure)
 *   5. Body return — text only. Binary content types are denied
 *      (`denied_type`) so the agent doesn't try to reason over a PDF or
 *      a tarball as if it were prose.
 *
 * Every outcome — including the deny paths — writes one
 * `WebFetchEvent` row so an admin can audit who fetched what. That
 * table sits separately from `Audit` (which is reserved for proposal
 * outcomes per CLAUDE.md rule 9).
 */

import "server-only";
import { z } from "zod";
import { zodToJsonSchema } from "@/agent/tools/schema";
import type { ToolFactory } from "@/agent/tools/types";
import { fail, ok } from "@/agent/tools/types";
import { loadProjectSetting } from "@/server/settings/effective";
import { recordWebFetchEvent } from "@/server/web-fetch/audit";
import { assertFetchTargetSafe } from "@/server/web-fetch/ssrf";

const FETCH_TIMEOUT_MS = 10_000;

const TEXTUAL_CONTENT_TYPE_PREFIXES: readonly string[] = [
  "text/",
  "application/json",
  "application/xml",
  "application/xhtml",
  "application/atom",
  "application/rss",
  "application/ld+json",
  "application/yaml",
  "application/x-yaml",
  "application/javascript",
];

function isTextualContentType(value: string | null): boolean {
  if (!value) return true;
  const ct = value.toLowerCase().split(";")[0]?.trim() ?? "";
  if (!ct) return true;
  return TEXTUAL_CONTENT_TYPE_PREFIXES.some((p) => ct.startsWith(p));
}

function hostAllowed(host: string, allowlist: readonly string[]): boolean {
  if (allowlist.length === 0) return true;
  const h = host.toLowerCase();
  return allowlist.some((entry) => entry.toLowerCase() === h);
}

export const webFetchTool: ToolFactory = (ctx) => ({
  def: {
    name: "web_fetch",
    description:
      "Fetch a public URL and return its body as text. Use it to read RFCs, vendor docs, changelogs, or anything else outside the project. Private IPs and cloud metadata endpoints are blocked. Project admins can disable the tool or restrict it to an allowlist of hosts in settings.",
    parameters: zodToJsonSchema(
      z.object({
        url: z.string().min(1).max(2_000),
      }),
    ),
  },
  handler: async (raw) => {
    const args = z.object({ url: z.string().min(1).max(2_000) }).parse(raw);
    const auditBase = {
      projectId: ctx.projectId,
      userId: ctx.userId,
      url: args.url,
    };

    const [enabled, allowlist, maxBytes] = await Promise.all([
      loadProjectSetting(ctx.db, ctx.projectId, "web-fetch.enabled"),
      loadProjectSetting(ctx.db, ctx.projectId, "web-fetch.allowed-hosts"),
      loadProjectSetting(ctx.db, ctx.projectId, "web-fetch.max-bytes"),
    ]);

    if (!enabled) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "denied_disabled",
        contentType: null,
        bytes: 0,
        errorMessage: "web_fetch is disabled for this project",
      });
      return fail("web_fetch is disabled for this project. Ask an admin to enable it in settings.");
    }

    let parsed: URL;
    try {
      parsed = new URL(args.url);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "denied_url",
        contentType: null,
        bytes: 0,
        errorMessage: `invalid URL: ${detail}`,
      });
      return fail(`'${args.url}' is not a valid URL: ${detail}`);
    }

    const ssrf = await assertFetchTargetSafe(parsed);
    if (!ssrf.ok) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: ssrf.reason,
        contentType: null,
        bytes: 0,
        errorMessage: ssrf.detail,
      });
      return fail(`fetch denied: ${ssrf.detail}`);
    }

    if (!hostAllowed(ssrf.host, allowlist)) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "denied_host_allowlist",
        contentType: null,
        bytes: 0,
        errorMessage: `'${ssrf.host}' is not in the project allowlist`,
      });
      return fail(`fetch denied: '${ssrf.host}' is not in the project's web-fetch host allowlist.`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(parsed.toString(), {
        method: "GET",
        signal: controller.signal,
        redirect: "follow",
        headers: {
          "user-agent": "docket-agent/1.0 (+https://github.com/vakesz/docket)",
          accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
        },
      });
    } catch (err) {
      clearTimeout(timeoutId);
      const detail = err instanceof Error ? err.message : String(err);
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "error",
        contentType: null,
        bytes: 0,
        errorMessage: detail,
      });
      return fail(`fetch failed: ${detail}`);
    }
    clearTimeout(timeoutId);

    const contentType = response.headers.get("content-type");
    if (!isTextualContentType(contentType)) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "denied_type",
        contentType,
        bytes: 0,
        errorMessage: `non-textual content-type '${contentType ?? ""}'`,
      });
      return fail(
        `fetch denied: response content-type '${contentType ?? "(none)"}' is not textual.`,
      );
    }

    const reader = response.body?.getReader();
    if (!reader) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "error",
        contentType,
        bytes: 0,
        errorMessage: "response body was empty",
      });
      return fail("fetch failed: response body was empty");
    }
    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        truncated = true;
        const room = maxBytes - (total - value.byteLength);
        if (room > 0) chunks.push(value.slice(0, room));
        try {
          await reader.cancel();
        } catch {
          // ignore — we got what we needed
        }
        break;
      }
      chunks.push(value);
    }
    const buffer = new Uint8Array(truncated ? maxBytes : total);
    let offset = 0;
    for (const c of chunks) {
      buffer.set(c, offset);
      offset += c.byteLength;
    }
    const body = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
    const finalBytes = buffer.byteLength;

    if (truncated) {
      await recordWebFetchEvent(ctx.db, {
        ...auditBase,
        status: "denied_size",
        contentType,
        bytes: finalBytes,
        errorMessage: `response exceeded ${maxBytes} bytes; truncated`,
      });
      return ok({
        status: response.status,
        contentType,
        truncated: true,
        bytes: finalBytes,
        body,
        note: `response truncated at ${maxBytes} bytes`,
      });
    }

    await recordWebFetchEvent(ctx.db, {
      ...auditBase,
      status: response.ok ? "ok" : "error",
      contentType,
      bytes: finalBytes,
      errorMessage: response.ok ? null : `HTTP ${response.status}`,
    });
    return ok({
      status: response.status,
      contentType,
      truncated: false,
      bytes: finalBytes,
      body,
    });
  },
});

export function webFetchTools(ctx: Parameters<ToolFactory>[0]) {
  return [webFetchTool(ctx)] as const;
}
