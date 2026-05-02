// These render as user-role messages after the system prefix — never
// concatenated into the byte-stable prefix in `prompt.ts`. The middle
// (`DEFAULT_SUGGEST_ACTION_BULLETS`) is operator-overridable; dynamic
// interpolation stays in code so the override is plain prose, not a
// template language.

import { DEFAULT_SUGGEST_ACTION_BULLETS } from "@/agent/prompt";
import type { ItemKind, ItemState } from "@/core/types";

export { DEFAULT_SUGGEST_ACTION_BULLETS };

export const SUGGEST_NEXT_ACTION_SENTINEL = "<!-- docket:seed:suggest-next-action -->";

const KIND_HINTS: Record<ItemKind, string> = {
  epic: "epic — track child rollup; suggest splitting if scope keeps growing",
  feature: "feature — coherent unit; child stories carry the work",
  story: "story — vertical slice with testable acceptance criteria",
  task: "task — single-developer-day unit",
  bug: "bug — needs repro / env / trace / regression scope",
};

const STATE_HINTS: Record<ItemState, string> = {
  new: "still in 'new' — likely candidates: start_work, or needs_info if the body is unclear",
  active:
    "active — close_done with a fix reference if it's landed; otherwise add a substantive update only if you have new info",
  blocked: "blocked — name the blocker if you can identify it; otherwise needs_info or escalate",
  needs_info: "waiting on info — frame the open question precisely or escalate",
  resolved: "resolved — reopen only if verification turned up a regression",
  closed: "closed — reopen only if there's clear new evidence",
};

const MAX_BODY_EXCERPT = 600;

function excerpt(body: string | null): string {
  if (!body) return "";
  const trimmed = body.trim();
  if (trimmed.length <= MAX_BODY_EXCERPT) return trimmed;
  return `${trimmed.slice(0, MAX_BODY_EXCERPT)}…`;
}

export function buildSuggestSeed(args: {
  kind: ItemKind | null;
  state: ItemState | null;
  title: string;
  body: string | null;
  commentCount: number;
  /**
   * Operator-editable instructional middle. Falls back to the bundled
   * default when null/empty (e.g. the global setting hasn't been
   * fetched yet, or the operator left the field blank).
   */
  actionBullets?: string | null;
}): string {
  const { kind, state, title, body: rawBody, commentCount, actionBullets } = args;
  const kindHint = kind ? KIND_HINTS[kind] : null;
  const stateHint = state ? STATE_HINTS[state] : null;
  const body = excerpt(rawBody);
  const bullets =
    actionBullets && actionBullets.trim().length > 0
      ? actionBullets
      : DEFAULT_SUGGEST_ACTION_BULLETS;

  const lines = [
    SUGGEST_NEXT_ACTION_SENTINEL,
    "",
    `What's the next concrete action on "${title}"?${kindHint ? ` (${kindHint})` : ""}${stateHint ? ` — ${stateHint}.` : ""}`,
    "",
    bullets,
    "",
  ];

  if (commentCount === 0) {
    lines.push(
      "Heads-up: this item has no comments yet — research the body and any linked PRs before proposing one.",
    );
  } else {
    lines.push(
      `Heads-up: this item already has ${commentCount} comment${commentCount === 1 ? "" : "s"}; read them via get_item before adding another so you don't duplicate.`,
    );
  }
  if (body) {
    lines.push(
      "",
      "Body excerpt (NOT the full body — call get_item for that):",
      "```",
      body,
      "```",
    );
  }

  return lines.join("\n");
}

export type SeedKind = "suggest-next-action";

export function extractSeedKind(content: string): SeedKind | null {
  if (content.startsWith(SUGGEST_NEXT_ACTION_SENTINEL)) return "suggest-next-action";
  return null;
}

export const SEED_LABELS: Record<SeedKind, string> = {
  "suggest-next-action": "Suggest next action",
};
