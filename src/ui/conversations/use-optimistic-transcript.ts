"use client";

import type { StreamingState } from "@/ui/conversations/chat-stream";
import {
  buildRenderUnits,
  type PersistedMessage,
  type RenderUnit,
} from "@/ui/conversations/transcript";

type Result = {
  /** Render units derived from the persisted transcript. */
  renderUnits: readonly RenderUnit[];
  /** True if the optimistic pendingUserMessage bubble should still render. */
  showPendingUserMessage: boolean;
  /** True if any portion of the live streaming UI has content. */
  hasStreamingActivity: boolean;
};

/**
 * Pulls together the persisted transcript with the live streaming state.
 *
 * Two derived flags it owns so the chat-pane orchestrator stays declarative:
 *
 * - `showPendingUserMessage` — suppress the optimistic user bubble once
 *   its persisted twin lands in `messages`. Without this we'd render the
 *   same user bubble twice for the window between the initial detail
 *   refetch (server has already appended `role: "user"`) and the
 *   post-stream invalidate that finally clears `pendingUserMessage` in
 *   stream state. Most visible on the "Suggest next action" path because
 *   that creates a fresh conversation and forces detail to refetch from
 *   scratch mid-stream.
 *
 * - `hasStreamingActivity` — true when any live region carries content.
 *   The empty-state copy hides the moment a turn starts, even before the
 *   first persisted message exists.
 */
export function useOptimisticTranscript(
  messages: readonly PersistedMessage[],
  streaming: StreamingState,
): Result {
  const renderUnits = buildRenderUnits(messages);

  const hasStreamingActivity =
    streaming.pendingUserMessage !== null ||
    streaming.text.length > 0 ||
    streaming.toolCalls.length > 0 ||
    streaming.settledRounds.length > 0;

  const pending = streaming.pendingUserMessage;
  let showPendingUserMessage = false;
  if (pending !== null) {
    const target = pending.trim();
    if (target) {
      showPendingUserMessage = !messages.some(
        (m) => m.role === "user" && m.content.trim() === target,
      );
    }
  }

  return { renderUnits, showPendingUserMessage, hasStreamingActivity };
}
