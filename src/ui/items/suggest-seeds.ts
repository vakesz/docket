/**
 * Templates for the "Suggest next action" button.
 *
 * Each template is the literal user-role message the chat pane fires after
 * opening. The seed names the active item and gives the agent a small
 * excerpt of the body so it can spot the obvious echo trap (proposing a
 * comment that just restates the description) without an extra round-trip.
 *
 * Lives in its own file so revising wording is one diff and the prompt
 * cache invariant stays intact (this is post-prefix user content, never
 * concatenated into the byte-stable system prefix).
 */

import type { ItemKind, ItemState } from "@/core/types";

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
}): string {
  const { kind, state, title, body: rawBody, commentCount } = args;
  const kindHint = kind ? KIND_HINTS[kind] : null;
  const stateHint = state ? STATE_HINTS[state] : null;
  const body = excerpt(rawBody);

  const lines = [
    SUGGEST_NEXT_ACTION_SENTINEL,
    "",
    `What's the next concrete action on "${title}"?${kindHint ? ` (${kindHint})` : ""}${stateHint ? ` — ${stateHint}.` : ""}`,
    "",
    "Call get_item first; the excerpt below is just a hint, not the full body. Then pick one and stage it (or explain why none apply):",
    "- propose_transition (start_work / needs_info / close_done / …) when the evidence supports it. For close_done on a bug, fetch the linked PR diff first.",
    "- propose_item_tags when a label change is unambiguous (needs-info, ready-for-work, …). Sample a few similar items via list_items first to learn the project's actual vocabulary — don't invent labels.",
    "- propose_comment with a substantive update (status, fix reference, decision, answered question, small fenced code snippet). Never an echo of the description.",
    "- propose_description_patch to fill repro / AC / env gaps. Pass only the new top-level content; the system preserves the previous version automatically.",
    "- propose_new_item to split when the item conflates concerns. Set parent_id to this item's id so the parent-child link is native; spell out WHY the split helps.",
    "- propose_memory_write to capture a non-obvious project convention you noticed (one per reply; narrow title; update an existing entry rather than creating a duplicate).",
    "- ask_user_question when you genuinely need info to decide.",
    "- Or: say nothing meaningful applies, and stop. Don't stage an echo proposal.",
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
