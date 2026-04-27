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

const KIND_HINTS: Record<ItemKind, string> = {
  epic: "epic — big picture; child features carry the actual work",
  feature: "feature — coherent user-visible unit; child stories carry the work",
  story: "story — vertical slice with acceptance criteria",
  task: "task — single-developer-sized unit",
  bug: "bug — defect against expected behaviour",
};

const STATE_HINTS: Record<ItemState, string> = {
  new: "It's still in 'new' state. Likely candidates: start_work, or needs_info if the body is unclear.",
  active:
    "It's active. If a fix has landed, close_done with a reference; otherwise add a substantive comment only if you have new information.",
  blocked:
    "It's blocked. If you can identify the blocker, name it; otherwise propose needs_info or escalate.",
  needs_info: "It's waiting on info. Frame the open question precisely or escalate.",
  resolved: "It's resolved. Suggest reopen only if verification turned up a regression.",
  closed: "It's closed. Suggest reopen only if there's clear new evidence.",
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
  bodyMd: string | null;
  commentCount: number;
}): string {
  const { kind, state, title, bodyMd, commentCount } = args;
  const kindHint = kind ? KIND_HINTS[kind] : null;
  const stateHint = state ? STATE_HINTS[state] : null;
  const body = excerpt(bodyMd);

  const lines = [
    `What's the next concrete action on "${title}"?`,
    "",
    "Process:",
    "1. Call get_item (no args needed — it defaults to the active item) to read the full body and any comments. The body excerpt below is just a hint; the real text is what counts.",
    '2. Decide whether moving the item forward is even your job right now. A "next action" can be: a state transition (start_work, close_done, …), a substantive comment that adds information the item lacks (status, fix reference, decision, answered question), a description patch that fills a gap, or — entirely valid — a clarifying question for the human.',
    "3. If you have nothing new to add beyond what's already in the description, say so. Don't stage an echo comment.",
    "",
  ];

  if (kindHint) lines.push(`Kind context: ${kindHint}.`);
  if (stateHint) lines.push(stateHint);
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
