/**
 * Templates for the "Suggest next action" button.
 *
 * Each template is the literal user-role message the chat pane fires after
 * opening. Kept short and directive — the agent already knows the item
 * context from the system prefix. Phrasing nudges the agent to either stage
 * a proposal or ask a clarifying question rather than producing a wall of
 * description text.
 *
 * Lives in its own file so revising wording is one diff and the prompt
 * cache invariant stays intact (this is post-prefix user content, never
 * concatenated into the byte-stable system prefix).
 */

import type { ItemKind, ItemState } from "@/core/types";

const KIND_HINTS: Record<ItemKind, string> = {
  epic: "epic — consider whether child features need movement before the epic itself",
  feature: "feature — consider scope completion and child story state",
  story: "story — consider acceptance criteria, blocked-on, and definition of done",
  task: "task — consider status, assignee, and the next concrete step",
  bug: "bug — consider reproducibility, severity, and fix verification",
};

const STATE_HINTS: Record<ItemState, string> = {
  new: "It's still in the 'new' state — start_work or needs_info are likely candidates.",
  active: "Work is active. Lean toward progress comments or close_done if appropriate.",
  blocked: "It's blocked — call out what's needed to unblock if visible.",
  needs_info: "It's waiting on info — propose the question or escalate.",
  resolved: "It's resolved; suggest a next action only if verification or cleanup is warranted.",
  closed: "It's closed; suggest a next action only if reopen is warranted.",
};

export function buildSuggestSeed(args: { kind: ItemKind | null; state: ItemState | null }): string {
  const { kind, state } = args;
  const kindHint = kind ? KIND_HINTS[kind] : null;
  const stateHint = state ? STATE_HINTS[state] : null;
  const lines = [
    "What's the next concrete action on this item?",
    "If a state transition or comment would move it forward, stage a proposal — don't just describe the situation.",
    "If you need information that isn't in the snapshot, ask one targeted question.",
  ];
  if (kindHint) lines.push(`Context: ${kindHint}.`);
  if (stateHint) lines.push(stateHint);
  return lines.join("\n");
}
