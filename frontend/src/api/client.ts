/**
 * Typed fetch client for the Docket HTTP surface.
 *
 * Same-origin `/api/*` calls. The bearer token is injected into the page as
 * `window.__DOCKET_TOKEN__` (by `docket serve` in prod, vite plugin in dev),
 * and we attach it on every request — so the token never leaves the local
 * box but the request flow is identical in both modes.
 */
import type { components } from "./schema";

export type DTO = components["schemas"];

const BASE = "/api";

declare global {
  interface Window {
    __DOCKET_TOKEN__?: string;
  }
}

function authHeader(): Record<string, string> {
  if (typeof window === "undefined") return {};
  const token = window.__DOCKET_TOKEN__;
  return token ? { authorization: `Bearer ${token}` } : {};
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function request<T>(
  method: string,
  path: string,
  init: { body?: unknown; query?: Record<string, unknown>; signal?: AbortSignal } = {},
): Promise<T> {
  const url = new URL(
    `${BASE}${path}`,
    typeof window !== "undefined" ? window.location.origin : "http://localhost",
  );
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null) continue;
      if (Array.isArray(v)) {
        for (const entry of v) {
          if (entry !== undefined && entry !== null) url.searchParams.append(k, String(entry));
        }
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const headers: Record<string, string> = { accept: "application/json", ...authHeader() };
  let body: BodyInit | undefined;
  if (init.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(init.body);
  }

  const res = await fetch(url.toString(), { method, headers, body, signal: init.signal });
  if (!res.ok) {
    let payload: unknown = null;
    try {
      payload = await res.json();
    } catch {
      payload = await res.text().catch(() => null);
    }
    const detail =
      (typeof payload === "object" &&
        payload &&
        "detail" in payload &&
        String((payload as { detail: unknown }).detail)) ||
      res.statusText;
    throw new ApiError(res.status, payload, `${method} ${path} failed (${res.status}): ${detail}`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return text ? (JSON.parse(text) as T) : (undefined as T);
}

export const api = {
  get: <T>(path: string, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>("GET", path, { query, signal }),
  post: <T>(path: string, body?: unknown, query?: Record<string, unknown>, signal?: AbortSignal) =>
    request<T>("POST", path, { body, query, signal }),
  put: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>("PUT", path, { body, signal }),
  patch: <T>(path: string, body?: unknown, signal?: AbortSignal) =>
    request<T>("PATCH", path, { body, signal }),
  delete: <T>(path: string, signal?: AbortSignal) => request<T>("DELETE", path, { signal }),

  /**
   * Server-Sent Events over fetch + ReadableStream. We avoid EventSource so we
   * can POST and stream back — EventSource is GET-only and cannot set headers.
   */
  stream: async function* (
    path: string,
    body: unknown,
    signal?: AbortSignal,
  ): AsyncGenerator<{ event: string; data: string }, void, void> {
    const res = await fetch(`${BASE}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
        ...authHeader(),
      },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) {
      throw new ApiError(res.status, null, `stream ${path} failed (${res.status})`);
    }

    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    // SSE event boundary is an empty line — any of `\r\n\r\n`, `\n\n`, or
    // `\r\r`. sse-starlette uses `\r\n` by default, so we must handle CRLF.
    const boundary = /\r\n\r\n|\n\n|\r\r/;
    const lineSep = /\r\n|\r|\n/;
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += value;
      for (;;) {
        const match = boundary.exec(buf);
        if (!match) break;
        const raw = buf.slice(0, match.index);
        buf = buf.slice(match.index + match[0].length);
        let event = "message";
        const dataLines: string[] = [];
        for (const line of raw.split(lineSep)) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
        }
        if (dataLines.length) yield { event, data: dataLines.join("\n") };
      }
    }
  },
};
