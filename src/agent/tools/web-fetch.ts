// Every outcome — including denies — writes one `WebFetchEvent` row.
// That table is separate from `Audit` because CLAUDE.md rule 9 reserves
// `Audit` for proposal outcomes.

import "server-only";
import { z } from "zod";
import type { ToolFactory } from "@/agent/tools/types";
import { defineTool, fail, ok } from "@/agent/tools/types";
import { cleanHtml, shouldCleanHtml } from "@/agent/tools/web-fetch-clean";
import { loadProjectSetting } from "@/server/settings/effective";
import { recordWebFetchEvent } from "@/server/web-fetch/audit";
import { assertFetchTargetSafe } from "@/server/web-fetch/ssrf";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;

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

const webFetchInputSchema = z.object({
  url: z.string().min(1).max(2_000),
  raw: z
    .boolean()
    .optional()
    .describe(
      "If true, return the raw response body without HTML→markdown cleaning. Default false. Try this if the cleaned output looks wrong, looks empty, or you specifically need the raw HTML/JSON.",
    ),
});

export const webFetchTool: ToolFactory = (ctx) =>
  defineTool({
    name: "web_fetch",
    description:
      "Fetch a public URL and return its body. HTML responses are converted to cleaned markdown by default — head, script, style, noscript, iframe, embedded SVG, and HTML comments are stripped, and relative links are resolved to absolute URLs, so you only see the readable content. Pass `raw: true` to skip cleaning and get the original body verbatim — use this when the cleaned markdown looks wrong or empty, when you need to inspect raw HTML/JSON structure, or after a fetch returns `cleaned: false` with a `cleanError`. Non-HTML responses (JSON, XML, plain text, YAML) are always returned unchanged regardless of `raw`. Private IPs and cloud metadata endpoints are blocked. Project admins can disable the tool or restrict it to an allowlist of hosts in settings.",
    schema: webFetchInputSchema,
    // The body comes straight from a third-party URL. The whole envelope
    // (status / contentType / body) is foreign content — full scan is the
    // only safe choice here. Tagged explicitly so the arch test doesn't
    // need a "default = full" escape hatch.
    guardrailScan: { mode: "full" },
    handler: async (args) => {
      const wantRaw = args.raw === true;
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
        return fail(
          "web_fetch is disabled for this project. Ask an admin to enable it in settings.",
        );
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

      // Bounded redirect chain. SSRF + allowlist checks run on every hop —
      // `redirect: "follow"` would let a public URL bounce to an internal
      // target after passing the initial guard, so we drive redirects ourselves
      // and re-validate each Location.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
      let response: Response;
      let currentUrl = parsed;
      try {
        let hop = 0;
        while (true) {
          const guard = await assertFetchTargetSafe(currentUrl);
          if (!guard.ok) {
            clearTimeout(timeoutId);
            await recordWebFetchEvent(ctx.db, {
              ...auditBase,
              url: currentUrl.toString(),
              status: guard.reason,
              contentType: null,
              bytes: 0,
              errorMessage: hop === 0 ? guard.detail : `redirect target rejected: ${guard.detail}`,
            });
            return fail(`fetch denied: ${guard.detail}`);
          }
          if (!hostAllowed(guard.host, allowlist)) {
            clearTimeout(timeoutId);
            await recordWebFetchEvent(ctx.db, {
              ...auditBase,
              url: currentUrl.toString(),
              status: "denied_host_allowlist",
              contentType: null,
              bytes: 0,
              errorMessage:
                hop === 0
                  ? `'${guard.host}' is not in the project allowlist`
                  : `redirect to '${guard.host}' is not in the project allowlist`,
            });
            return fail(
              `fetch denied: '${guard.host}' is not in the project's web-fetch host allowlist.`,
            );
          }

          const hopResponse = await fetch(currentUrl.toString(), {
            method: "GET",
            signal: controller.signal,
            redirect: "manual",
            headers: {
              "user-agent": "docket-agent/1.0 (+https://github.com/vakesz/docket)",
              accept: "text/html,text/plain,application/json;q=0.9,*/*;q=0.5",
            },
          });

          const isRedirect =
            hopResponse.status >= 300 &&
            hopResponse.status < 400 &&
            hopResponse.status !== 304 &&
            hopResponse.headers.has("location");
          if (!isRedirect) {
            response = hopResponse;
            break;
          }

          // Drain the redirect body so the connection can be reused.
          try {
            await hopResponse.body?.cancel();
          } catch {
            // ignore
          }

          if (hop >= MAX_REDIRECTS) {
            clearTimeout(timeoutId);
            await recordWebFetchEvent(ctx.db, {
              ...auditBase,
              url: currentUrl.toString(),
              status: "denied_redirect",
              contentType: null,
              bytes: 0,
              errorMessage: `exceeded ${MAX_REDIRECTS} redirects`,
            });
            return fail(`fetch denied: exceeded ${MAX_REDIRECTS} redirects`);
          }

          const location = hopResponse.headers.get("location") ?? "";
          let next: URL;
          try {
            next = new URL(location, currentUrl);
          } catch (err) {
            clearTimeout(timeoutId);
            const detail = err instanceof Error ? err.message : String(err);
            await recordWebFetchEvent(ctx.db, {
              ...auditBase,
              url: currentUrl.toString(),
              status: "denied_redirect",
              contentType: null,
              bytes: 0,
              errorMessage: `invalid redirect Location '${location}': ${detail}`,
            });
            return fail(`fetch denied: invalid redirect Location '${location}'`);
          }
          currentUrl = next;
          hop += 1;
        }
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
      const rawBody = new TextDecoder("utf-8", { fatal: false }).decode(buffer);
      const finalBytes = buffer.byteLength;

      // HTML cleanup pass. Truncated HTML is still cleaned (jsdom is tolerant);
      // the agent can refetch with `raw: true` if a partial trailing section
      // matters.
      let cleaned: boolean | null = null;
      let cleanedBytes: number | null = null;
      let cleanError: string | null = null;
      let body = rawBody;
      if (!wantRaw && shouldCleanHtml(contentType, rawBody)) {
        try {
          const result = cleanHtml(rawBody, currentUrl.toString());
          body = result.markdown;
          cleaned = true;
          cleanedBytes = result.bytes;
        } catch (err) {
          cleaned = false;
          cleanError = err instanceof Error ? err.message : String(err);
          body = rawBody;
        }
      }

      if (truncated) {
        await recordWebFetchEvent(ctx.db, {
          ...auditBase,
          status: "denied_size",
          contentType,
          bytes: finalBytes,
          errorMessage: `response exceeded ${maxBytes} bytes; truncated`,
          cleaned,
          cleanedBytes,
          cleanError,
        });
        return ok({
          status: response.status,
          content_type: contentType,
          truncated: true,
          bytes: finalBytes,
          cleaned,
          cleaned_bytes: cleanedBytes,
          clean_error: cleanError,
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
        cleaned,
        cleanedBytes,
        cleanError,
      });
      return ok({
        status: response.status,
        content_type: contentType,
        truncated: false,
        bytes: finalBytes,
        cleaned,
        cleaned_bytes: cleanedBytes,
        clean_error: cleanError,
        body,
      });
    },
  });

export function webFetchTools(ctx: Parameters<ToolFactory>[0]) {
  return [webFetchTool(ctx)] as const;
}
