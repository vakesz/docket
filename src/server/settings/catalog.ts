/**
 * Typed settings catalog — the source of truth for what keys exist, how
 * their values validate, and where they live (user / project / global).
 *
 * Adding a setting is one entry here plus (usually) one form field on the
 * settings page. The router validates every update against the catalog,
 * defaults are applied at read time, and the on-disk encoding is
 * `JSON.stringify(value)` so the `Setting.value` column stays a single
 * string regardless of the value's shape.
 *
 * Server-only deliberately: the catalog imports server-only helpers so the
 * tRPC layer can use it directly. The Zod schemas it exposes are isomorphic
 * across client/server, but the catalog object itself is not — clients see
 * the inferred TS types via the tRPC router.
 */

import "server-only";
import { z } from "zod";
import { GUARDRAIL_KINDS } from "@/agent/guardrail/types";

export const SETTING_SCOPES = ["user", "project", "global"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export type SettingDef<S extends z.ZodTypeAny> = {
  key: string;
  scope: SettingScope;
  schema: S;
  default: z.infer<S>;
  /** Human-readable label shown on the settings page. */
  label: string;
  /** One-line description shown under the field. */
  description: string;
};

const BoolSchema = z.boolean();
const PositiveIntSchema = z.number().int().min(0).max(3650);
// User staleness override: -1 = inherit project default, 0 = force-disabled
// for me on every project, >0 = my personal threshold (wins over project).
const UserStaleOverrideSchema = z.number().int().min(-1).max(3650);
const VisibleChipsSchema = z.number().int().min(0).max(20);
const AssigneeSelectorStyleSchema = z.enum(["chips", "dropdown"]);
const BacklogSortSchema = z.enum(["updated", "created", "priority", "title"]);
const BacklogStateFilterSchema = z.enum(["all", "open", "in_progress", "done"]);
const BacklogDensitySchema = z.enum(["compact", "cozy"]);
// IANA tz names go from a couple chars ("UTC") to 30+ ("America/Argentina/ComodRivadavia").
// 64 is generous and avoids DB-side surprises. Empty string = follow the browser;
// any non-empty value must be one Intl.DateTimeFormat accepts so direct DB / raw
// tRPC writes can't sneak in a bogus zone.
const TimezoneSchema = z
  .string()
  .max(64)
  .refine(
    (v) => {
      if (v === "") return true;
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: v });
        return true;
      } catch {
        return false;
      }
    },
    { message: "must be an IANA time-zone name (e.g. 'Europe/Stockholm') or empty" },
  );
const CompactionTokenThresholdSchema = z.number().int().min(1_000).max(500_000);
const CompactionKeepRecentTurnsSchema = z.number().int().min(2).max(50);
const CompactionStrategySchema = z.enum(["summary", "drop-tools"]);
// 0 = retain forever; positive integers cap retention to that many days.
const AuditRetentionSchema = z.number().int().min(0).max(3650);
// 0 = no cap; positive integers enforce a monthly spend cap in cents.
const MonthlyCostCapSchema = z.number().int().min(0).max(10_000_000);
const CostCapActionSchema = z.enum(["block", "warn"]);
// 0 = disabled; otherwise a polling interval in seconds. Capped at 1 hour
// so a stray "999999" can't pin a tab on `setInterval`. The settings UI
// presents this as minutes; the stored unit stays in seconds so
// `useAutoRefreshIntervalMs` only has one ×1000 conversion.
const AutoRefreshSecondsSchema = z.number().int().min(0).max(3600);
// Allowlist of fully-qualified hostnames the web_fetch tool may target.
// Empty list = no allowlist (any non-SSRF host is reachable). Hosts are
// matched case-insensitively against the URL's hostname only — no path /
// scheme constraints. 200 entries cap protects the per-fetch O(n) check.
const WebFetchAllowedHostsSchema = z.array(z.string().min(1).max(253)).max(200);
// 64 KB → 8 MB body cap on web_fetch responses, after which the tool
// truncates and reports `denied_size`. Keeps a runaway redirect from
// pulling a multi-GB payload into the agent context.
const WebFetchMaxBytesSchema = z.number().int().min(64_000).max(8_000_000);
const GuardrailKindSchema = z.enum(GUARDRAIL_KINDS);
// Hard cap on agent tool-call rounds within one user turn. 3 is the floor
// that still allows "read → think → answer"; 30 is well past where extra
// rounds stop helping a stuck model and start risking SSE/proxy timeouts.
const MaxToolRoundsSchema = z.number().int().min(3).max(30);

// UI-origin auto-accept floor. These kinds always auto-confirm when staged
// from the UI (origin === "ui") — they're not gated by the per-project
// policy, only by read-only mode. Tier-A enrichment: additive, reversible,
// no silent state changes. Agent-staged rows still always wait for a human
// regardless. Adding a kind here is a security review event.
export const AUTO_ACCEPT_FLOOR_KINDS = ["comment_add", "reaction_toggle"] as const;
export const AUTO_ACCEPT_FLOOR_KINDS_LIST: readonly string[] = AUTO_ACCEPT_FLOOR_KINDS;

// Opt-in kinds the project may add on top of the floor. Memory writes/deletes
// are local-DB only (no provider blast radius) so they're safe to auto-accept
// when the project explicitly opts in. Provider-touching kinds (state changes,
// descriptions, tags, item creation, assignee changes) are deliberately NOT
// eligible and never make this list.
const AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS = ["memory_write", "memory_delete"] as const;
export const AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS_LIST: readonly string[] =
  AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS;
const AutoAcceptExtraKindsSchema = z
  .array(z.enum(AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS))
  .max(AUTO_ACCEPT_EXTRA_ELIGIBLE_KINDS.length);

// Theme is intentionally browser-local (see `src/lib/theme.ts` +
// ThemePicker in the top bar) — same pattern main uses. Keeping it out
// of the catalog avoids a split-brain where the DB row says "light" while
// the user's browser is on "rose-pine-moon".
export const SETTINGS_CATALOG = {
  "chat.send-on-enter": {
    key: "chat.send-on-enter",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Send chat on Enter",
    description:
      "When on, Enter sends the message and Shift-Enter inserts a newline. When off, the keys swap.",
  },
  "chat.max-tool-rounds": {
    key: "chat.max-tool-rounds",
    scope: "user",
    schema: MaxToolRoundsSchema,
    default: 12,
    label: "Max agent tool-call rounds per turn",
    description:
      "Hard cap on how many back-and-forth tool rounds the agent runs inside a single turn before aborting. Each round = one LLM response that includes tool calls. Lower values cut off runaway loops sooner; higher values let multi-step investigations finish. Range 3–30.",
  },
  "items.max-visible-tags": {
    key: "items.max-visible-tags",
    scope: "user",
    schema: VisibleChipsSchema,
    default: 2,
    label: "Backlog — max tag chips shown",
    description:
      "How many tag chips render inline (on each backlog row, and in the tag-filter bar at the top of the backlog pane) before the rest collapse into a +N badge. Set to 0 to always collapse (just the count, no chips).",
  },
  "items.max-visible-assignees": {
    key: "items.max-visible-assignees",
    scope: "user",
    schema: VisibleChipsSchema,
    default: 2,
    label: "Backlog — max assignee chips shown",
    description:
      "How many assignee chips render in the backlog filter row before the rest collapse into a +N badge. Only applies when the assignee selector style is set to chips. Set to 0 to always collapse.",
  },
  "items.assignee-selector-style": {
    key: "items.assignee-selector-style",
    scope: "user",
    schema: AssigneeSelectorStyleSchema,
    default: "chips",
    label: "Backlog — assignee selector style",
    description:
      "How the assignee filter renders. 'chips' shows each assignee as a toggleable pill (good for small teams). 'dropdown' shows a multi-select dropdown — switch to this when the project has many people and chips would overflow. The list always offers Any, Unassigned, and the project's assignees; if your name is recognised, it is pinned to the front.",
  },
  "items.show-assignee-avatars": {
    key: "items.show-assignee-avatars",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Backlog — show assignee avatars",
    description:
      "When on, assignee chips render with the user's profile picture pulled from the provider (currently GitHub only — a deterministic CDN URL, no extra API calls). Other providers fall back to a colored initial circle. Turn off to show only the username.",
  },
  "items.show-archived-bucket": {
    key: "items.show-archived-bucket",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Backlog — show Archived bucket",
    description:
      "When on, the backlog filter bar offers an Archived bucket alongside Open / Closed / All. Archived rows are still reachable via the All-states bucket regardless of this setting.",
  },
  "items.show-reactions-header": {
    key: "items.show-reactions-header",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Item detail — show reactions on header",
    description:
      "When off, the reaction picker and existing reaction chips are hidden on the item detail header. Reactions on comments are unaffected. Sync still pulls reactions; this is a personal view preference.",
  },
  "items.show-reactions-comments": {
    key: "items.show-reactions-comments",
    scope: "user",
    schema: BoolSchema,
    default: true,
    label: "Item detail — show reactions in comments",
    description:
      "When off, the reaction picker and existing reaction chips are hidden inside each comment. Reactions on the item header itself are unaffected. Sync still pulls reactions; this is a personal view preference.",
  },
  "app.read-only": {
    key: "app.read-only",
    scope: "global",
    schema: BoolSchema,
    default: false,
    label: "System read-only mode",
    description:
      "When on, every mutation route — including proposal confirms — is blocked. Reads stay open. Flip on for maintenance windows.",
  },
  "setup.complete": {
    key: "setup.complete",
    scope: "global",
    schema: BoolSchema,
    default: false,
    label: "Initial setup complete",
    description:
      "Sticky bit flipped on the first request that observes at least one LLM provider and at least one OAuth provider. Middleware uses it to decide whether to redirect to /setup-required. Manually toggle off only when reverting after a destructive deployment-config operation.",
  },
  "items.stale-after-days": {
    key: "items.stale-after-days",
    scope: "project",
    schema: PositiveIntSchema,
    default: 7,
    label: "Stale-after threshold (days)",
    description:
      "Project-level default for the freshness tint. Backlog rows tint amber once an item has been untouched this long, and red at 2x. Set to 0 to disable the freshness tint for everyone viewing this project. Each member can override the value with their own under Profile → Item detail.",
  },
  "items.stale-after-days.user": {
    key: "items.stale-after-days.user",
    scope: "user",
    schema: UserStaleOverrideSchema,
    default: -1,
    label: "My staleness threshold (override)",
    description:
      "Personal override for the freshness tint, applied across every project I view. -1 means inherit the project default; 0 force-disables the tint for me everywhere; any positive integer wins over the project value.",
  },
  "backlog.default-sort": {
    key: "backlog.default-sort",
    scope: "user",
    schema: BacklogSortSchema,
    default: "updated",
    label: "Backlog — default sort",
    description:
      "Initial sort order applied when a project's backlog opens. Per-view sort still wins.",
  },
  "backlog.default-state-filter": {
    key: "backlog.default-state-filter",
    scope: "user",
    schema: BacklogStateFilterSchema,
    default: "open",
    label: "Backlog — default state filter",
    description: "Initial state-bucket filter applied when the backlog opens.",
  },
  "backlog.density": {
    key: "backlog.density",
    scope: "user",
    schema: BacklogDensitySchema,
    default: "cozy",
    label: "Backlog — row density",
    description:
      "Compact packs more rows on screen with smaller padding; cozy is the default touch-friendly height.",
  },
  "display.timezone": {
    key: "display.timezone",
    scope: "user",
    schema: TimezoneSchema,
    default: "",
    label: "Display time zone",
    description:
      "IANA time-zone name used for relative dates and the staleness tint window (e.g. 'Europe/Stockholm', 'UTC'). Empty falls back to the browser's local zone.",
  },
  "llm.compaction.enabled": {
    key: "llm.compaction.enabled",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Auto-compact long conversations",
    description:
      "When on, conversations whose transcript exceeds the token threshold get summarised before the next agent turn so the prompt fits the context window.",
  },
  "llm.compaction.token-threshold": {
    key: "llm.compaction.token-threshold",
    scope: "project",
    schema: CompactionTokenThresholdSchema,
    default: 60_000,
    label: "Compaction token threshold",
    description:
      "Estimated transcript-token count at which compaction kicks in. The token count is approximate (4 chars ≈ 1 token); pad below your model's hard limit.",
  },
  "llm.compaction.keep-recent-turns": {
    key: "llm.compaction.keep-recent-turns",
    scope: "project",
    schema: CompactionKeepRecentTurnsSchema,
    default: 6,
    label: "Compaction — recent turns to keep verbatim",
    description:
      "How many of the most-recent message turns are preserved as-is. Older turns get folded into the summary.",
  },
  "llm.compaction.strategy": {
    key: "llm.compaction.strategy",
    scope: "project",
    schema: CompactionStrategySchema,
    default: "summary",
    label: "Compaction strategy",
    description:
      "'summary' replaces older turns with a single assistant-generated summary message. 'drop-tools' is cheaper: drop only stale tool-call/result pairs and keep the prose.",
  },
  "audit.retention-days": {
    key: "audit.retention-days",
    scope: "global",
    schema: AuditRetentionSchema,
    default: 365,
    label: "Audit retention (days)",
    description:
      "Audit rows older than this are eligible for pruning by the deployment-admin. 0 disables pruning entirely (rows are retained forever).",
  },
  "llm.monthly-cost-cap-cents": {
    key: "llm.monthly-cost-cap-cents",
    scope: "global",
    schema: MonthlyCostCapSchema,
    default: 0,
    label: "LLM monthly cost cap (cents)",
    description:
      "Hard ceiling on the sum of `Conversation.costCents` accrued in the current calendar month (UTC). 0 disables the cap. Cap is checked before each agent turn and against the action below.",
  },
  "ui.auto-refresh-seconds": {
    key: "ui.auto-refresh-seconds",
    scope: "user",
    schema: AutoRefreshSecondsSchema,
    default: 0,
    label: "Background sync interval (seconds)",
    description:
      "While you have a project open, run an incremental sync against the provider every N seconds and refetch settings dashboards (LLM/OAuth providers) on the same cadence. The footer's 'synced X ago' tracks each sync. 0 disables — the manual sync button in the footer still works. A catch-up sync also fires on tab focus when the cached cursor is older than one interval. Maximum 3600 (one hour). Surfaced to users as minutes in the settings UI; ≥ 120 seconds recommended.",
  },
  "llm.cost-cap-action": {
    key: "llm.cost-cap-action",
    scope: "global",
    schema: CostCapActionSchema,
    default: "warn",
    label: "Cost-cap action",
    description:
      "When the monthly cap is reached: 'warn' lets the turn proceed but surfaces a banner; 'block' refuses agent turns until the cap is raised or the calendar month rolls over.",
  },
  "web-fetch.enabled": {
    key: "web-fetch.enabled",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Allow agent to fetch web pages",
    description:
      "When on, the agent can call the web_fetch tool to read public URLs (docs, RFCs, vendor changelogs). HTML pages are cleaned to markdown (head/script/style/comments stripped, relative links resolved) before reaching the agent; the agent can request the raw body when the cleaned output looks wrong. SSRF guards block private addresses and cloud metadata endpoints regardless of this setting.",
  },
  "web-fetch.allowed-hosts": {
    key: "web-fetch.allowed-hosts",
    scope: "project",
    schema: WebFetchAllowedHostsSchema,
    default: [] as string[],
    label: "Web-fetch host allowlist",
    description:
      "Optional list of hostnames the agent may fetch from (one per row, e.g. 'docs.python.org'). Empty = any public host is reachable; non-empty acts as a strict allowlist.",
  },
  "web-fetch.max-bytes": {
    key: "web-fetch.max-bytes",
    scope: "project",
    schema: WebFetchMaxBytesSchema,
    default: 200_000,
    label: "Web-fetch response size cap (bytes)",
    description:
      "Upper bound on the wire response body web_fetch will read. Larger payloads are truncated and reported as denied_size. Range: 64 KB to 8 MB. Keep small — a single turn can fan out to several fetches, and each one's body lands in the model's context window (after HTML cleaning, when applicable).",
  },
  "guardrail.enabled": {
    key: "guardrail.enabled",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Enable chat guardrails",
    description:
      "When on, the chatbot's input, tool results, and output flow through a guardrail layer that screens for prompt injection, off-topic requests, and harmful content. Calls go to the project's configured guardrail LLM provider — never an external free endpoint.",
  },
  "guardrail.kind": {
    key: "guardrail.kind",
    scope: "project",
    schema: GuardrailKindSchema,
    default: "composite",
    label: "Guardrail strategy",
    description:
      "'pattern' is local regex only (free, fast, low precision). 'llm-judge' uses the configured guardrail model exclusively (precise, ~$0.0002/call). 'composite' runs pattern first and only escalates to the model on harder cases (recommended). 'noop' disables guardrails without flipping the enabled toggle.",
  },
  "guardrail.block-on-injection": {
    key: "guardrail.block-on-injection",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Block prompt-injection attempts",
    description:
      "When on, tool results that the guardrail flags as prompt injection are replaced with a refusal stub before re-entering the prompt. Off, they pass through with a flag annotation only.",
  },
  "guardrail.block-off-topic": {
    key: "guardrail.block-off-topic",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Block off-topic chat",
    description:
      "When on, user messages classified as outside the software / work-item scope (e.g. 'how to make pancakes', medical / legal advice) are refused before reaching the agent. Off, they only get a banner and the agent still answers.",
  },
  "guardrail.scope-check-enabled": {
    key: "guardrail.scope-check-enabled",
    scope: "project",
    schema: BoolSchema,
    default: true,
    label: "Scope-check user input",
    description:
      "When on, every user message is run through a one-token scope classifier on the configured guardrail model. Turn off if your projects extend beyond software work-items.",
  },
  "guardrail.output-check-enabled": {
    key: "guardrail.output-check-enabled",
    scope: "project",
    schema: BoolSchema,
    default: false,
    label: "Output safety check",
    description:
      "When on, the assistant's final reply is classified for harmful content (hate, harassment, threats, sexual). Adds one extra round-trip per turn on the guardrail model. Output is never blocked mid-stream — flagged messages get a banner.",
  },
  "proposals.auto-accept-extra-kinds": {
    key: "proposals.auto-accept-extra-kinds",
    scope: "project",
    schema: AutoAcceptExtraKindsSchema,
    default: [] as string[],
    label: "Auto-accept proposals — extra kinds",
    description:
      "Additional proposal kinds that confirm automatically without a human tap when the user originates them in the UI. UI-origin comments and reactions always auto-confirm regardless of this setting (Tier-A enrichment — additive, reversible). This list opts in extra local-DB kinds (memory writes/deletes); provider-touching kinds (state changes, descriptions, tags, assignee changes, new items) always require explicit review. Agent-staged proposals never auto-confirm regardless. Read-only mode still wins.",
  },
} as const satisfies Record<string, SettingDef<z.ZodTypeAny>>;

export type SettingKey = keyof typeof SETTINGS_CATALOG;
export const SETTING_KEYS = Object.keys(SETTINGS_CATALOG) as SettingKey[];

export type SettingValue<K extends SettingKey> = z.infer<(typeof SETTINGS_CATALOG)[K]["schema"]>;

/**
 * Resolve the catalog entry for a key, throwing on unknown keys. The router
 * uses this everywhere it touches the catalog so the unknown-key error is
 * one shape, not three.
 */
export function getSettingDef<K extends SettingKey>(key: K): (typeof SETTINGS_CATALOG)[K];
export function getSettingDef(key: string): SettingDef<z.ZodTypeAny>;
export function getSettingDef(key: string): SettingDef<z.ZodTypeAny> {
  const def = (SETTINGS_CATALOG as Record<string, SettingDef<z.ZodTypeAny>>)[key];
  if (!def) {
    throw new Error(`unknown setting key: '${key}'`);
  }
  return def;
}

/**
 * Decode a stored `Setting.value` string into the typed value, or return
 * the catalog default when the row's value fails to decode/validate. Bad
 * rows shouldn't take down the settings page; they get logged and the
 * default surfaces instead.
 */
export function decodeSettingValue<K extends SettingKey>(
  key: K,
  raw: string | null,
): SettingValue<K> {
  const def = getSettingDef(key);
  if (raw === null) return def.default as SettingValue<K>;
  try {
    const parsed = JSON.parse(raw);
    return def.schema.parse(parsed) as SettingValue<K>;
  } catch {
    return def.default as SettingValue<K>;
  }
}

export function encodeSettingValue<K extends SettingKey>(key: K, value: SettingValue<K>): string {
  const def = getSettingDef(key);
  // Re-validate so the on-wire representation matches the catalog.
  const validated = def.schema.parse(value);
  return JSON.stringify(validated);
}
