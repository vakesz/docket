// `checkOutput` `block` is intentionally absent from the contract — the
// user has already seen the streamed text by that point, so the only
// useful disposition is `flag`. Vendor SDKs allowed under
// `src/agent/guardrail/**` (allow-listed in `no-llm-vendor-leak.test.ts`).

export const GUARDRAIL_KINDS = ["noop", "pattern", "llm-judge", "composite"] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export type GuardrailStage = "input" | "tool_result" | "output";

/**
 * Token + cost accounting for a single guardrail check. Adapters that hit
 * an LLM (the LLM-judge) populate this; cheap pattern / no-op adapters
 * leave it undefined. The loop folds these into per-conversation
 * `guardrailTokensIn / guardrailTokensOut / guardrailCostCents` columns so
 * analytics can split guardrail spend from chat spend without changing
 * the LlmProvider schema.
 */
export type GuardrailUsage = {
  tokensIn: number;
  tokensOut: number;
  /** USD cents, when the adapter can compute it from the row's pricing. */
  costCents?: number;
};

export type GuardrailDecision = (
  | { action: "allow" }
  | { action: "flag"; reason: string; categories?: readonly string[] }
  | { action: "block"; reason: string; categories?: readonly string[] }
) & { usage?: GuardrailUsage };

export type CheckToolResultArgs = {
  toolName: string;
  /**
   * The structured result already produced by the tool. Adapters typically
   * inspect `.data` (or its stringified form) rather than `.ok`.
   */
  result: unknown;
  /**
   * Optional pre-extracted text the loop has already isolated as the
   * untrusted portion of `result`. When set, adapters scan this string
   * instead of stringifying the whole envelope. Used by tools tagged
   * `guardrailScan: { mode: "fields" }` so the LLM judge sees only the
   * markdown body / comment text and never the surrounding server ids,
   * timestamps, or tag arrays — the latter dilute the signal and
   * occasionally drive false-positive injection verdicts on small models.
   *
   * An empty string means "no untrusted content extracted, scan nothing".
   */
  untrusted?: string;
};

export interface Guardrail {
  readonly kind: GuardrailKind;
  /** Display label for log lines / UI. */
  readonly label: string;

  checkInput(text: string, signal?: AbortSignal): Promise<GuardrailDecision>;
  checkToolResult(args: CheckToolResultArgs, signal?: AbortSignal): Promise<GuardrailDecision>;
  checkOutput(text: string, signal?: AbortSignal): Promise<GuardrailDecision>;
}

/**
 * Helper: extract a stringified payload from a tool's structured result so
 * adapters can scan it. Tools return `{ ok, data?, error? }`; `data` is
 * the part originating outside the trust boundary (web_fetch markdown,
 * GitHub comment bodies, MCP responses).
 */
export function stringifyToolResult(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  try {
    const r = result as { data?: unknown; error?: unknown };
    if (r.data !== undefined) {
      return typeof r.data === "string" ? r.data : JSON.stringify(r.data);
    }
    if (r.error !== undefined) {
      return typeof r.error === "string" ? r.error : JSON.stringify(r.error);
    }
    return JSON.stringify(result);
  } catch {
    return "";
  }
}

/**
 * Extract the untrusted text portions of a tool's `result.data` envelope
 * along the listed dotted paths. Used by the agent loop when a tool is
 * tagged `guardrailScan: { mode: "fields", untrusted: [...] }` so the
 * guardrail sees only foreign content (markdown bodies, comment text,
 * diff hunks) and not the surrounding server-controlled scaffolding.
 *
 * Path syntax (intentionally a tiny subset — anything richer is a sign
 * the tool's shape is wrong, not the extractor's):
 *
 *   - `"foo"`            — top-level field on `data`
 *   - `"foo.bar"`        — nested object access
 *   - `"foo[]"`          — iterate the array, take each element
 *   - `"foo[].bar"`      — iterate the array, take `bar` from each
 *   - `"foo[].bar.baz"`  — same, with a deeper nested take
 *
 * Multiple `[]` segments per path are supported but rarely needed. The
 * separator between extracted snippets is a literal newline followed by
 * `---\n`, so a hostile body containing `---` can't trivially join with
 * an adjacent field to look like a different shape to the judge.
 *
 * Missing fields, null values, and undefined paths contribute nothing
 * (no error, no placeholder). When every path produces nothing the
 * function returns the empty string and the loop short-circuits the
 * guardrail call entirely — same fast path as `mode: "skip"`.
 */
export function extractUntrustedFields(result: unknown, paths: readonly string[]): string {
  if (result === null || result === undefined) return "";
  const r = result as { data?: unknown };
  const data = r.data;
  if (data === null || data === undefined) return "";

  const snippets: string[] = [];
  for (const path of paths) {
    const segments = parsePath(path);
    collectSnippets(data, segments, snippets);
  }
  if (snippets.length === 0) return "";
  return snippets.join("\n---\n");
}

type PathSegment = { key: string; iterate: boolean };

function parsePath(path: string): PathSegment[] {
  const parts = path.split(".");
  const out: PathSegment[] = [];
  for (const raw of parts) {
    if (raw.length === 0) continue;
    if (raw.endsWith("[]")) {
      out.push({ key: raw.slice(0, -2), iterate: true });
    } else {
      out.push({ key: raw, iterate: false });
    }
  }
  return out;
}

function collectSnippets(value: unknown, segments: PathSegment[], out: string[]): void {
  const [head, ...rest] = segments;
  if (!head) {
    appendValue(value, out);
    return;
  }
  if (value === null || value === undefined) return;
  // Empty key (from a leading `[]`) means "iterate the current value
  // itself" rather than descending into a property. Lets a path like
  // `[].title` work when `data` is itself an array.
  let next: unknown;
  if (head.key === "") {
    next = value;
  } else if (typeof value === "object") {
    next = (value as Record<string, unknown>)[head.key];
  } else {
    return;
  }
  if (head.iterate) {
    if (!Array.isArray(next)) return;
    for (const child of next) collectSnippets(child, rest, out);
  } else {
    collectSnippets(next, rest, out);
  }
}

function appendValue(value: unknown, out: string[]): void {
  if (value === null || value === undefined) return;
  if (typeof value === "string") {
    if (value.length > 0) out.push(value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    for (const child of value) appendValue(child, out);
    return;
  }
  try {
    out.push(JSON.stringify(value));
  } catch {
    // Drop unserializable values — the field shouldn't have produced one.
  }
}
