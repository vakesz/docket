"use client";

import { Send, Square } from "lucide-react";
import { type ReactNode, type RefObject, useState } from "react";
import { cn } from "@/lib/utils";
import { Textarea } from "@/ui/primitives/textarea";

const MICRO_CAPS_BUTTON =
  "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground hover:bg-muted hover:text-foreground";
const META_LABEL_FAINT = "text-xs uppercase tracking-wide text-muted-foreground/70";

/**
 * Composer footer for ChatPane. Owns its own `draft` state so keystrokes
 * don't ripple up into the parent's transcript render path
 * (`buildRenderUnits`, `showPendingUserMessage`, etc.). Parent re-renders
 * on streaming/message changes still flow through, but the heavy work
 * stays in the parent and the keystroke churn stays local to this tree.
 *
 * Mount with `key={itemNumber}` so the draft resets cleanly on item
 * switch — replaces the prior `setDraft("")` reset effect in the parent.
 */
export function ChatComposer({
  inFlight,
  canSubmit,
  sendOnEnter,
  hasActiveQuestion,
  promptRef,
  errorText,
  onSubmit,
  onStop,
  leftSlot,
}: {
  inFlight: boolean;
  canSubmit: boolean;
  sendOnEnter: boolean;
  hasActiveQuestion: boolean;
  promptRef: RefObject<HTMLTextAreaElement | null>;
  errorText?: string | undefined;
  onSubmit: (body: string) => void;
  onStop: () => void;
  leftSlot: ReactNode;
}) {
  const [draft, setDraft] = useState("");

  const submit = () => {
    const body = draft.trim();
    if (!body || inFlight || !canSubmit) return;
    setDraft("");
    onSubmit(body);
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className="border-border border-t p-2"
    >
      <p className="mb-1 text-[10px] text-muted-foreground/70">
        {hasActiveQuestion
          ? "Pick from the card above — or type free text and it'll be sent as your answer."
          : "Ask the agent to comment, transition, or rewrite — changes appear as cards to confirm."}
      </p>
      <Textarea
        ref={promptRef}
        value={draft}
        disabled={inFlight}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          // Honor the user pref: if "send on Enter" is on, plain Enter
          // sends and Shift+Enter inserts a newline; flipped otherwise.
          const enter = e.key === "Enter";
          if (!enter) return;
          const wantSend = sendOnEnter ? !e.shiftKey : e.shiftKey;
          if (wantSend) {
            e.preventDefault();
            submit();
          }
        }}
        rows={3}
        placeholder={sendOnEnter ? "Ask the agent… (Enter to send)" : "Ask the agent… (Shift+Enter to send)"}
        className="resize-none"
      />
      <div className={cn("mt-1 flex items-center justify-between gap-2", META_LABEL_FAINT)}>
        {leftSlot}
        <div className="flex items-center gap-2">
          {errorText && <span className="text-destructive">{errorText}</span>}
          {inFlight ? (
            <button
              type="button"
              onClick={onStop}
              className={cn(
                MICRO_CAPS_BUTTON,
                "border border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive",
              )}
              title="Stop generation"
            >
              <Square className="h-3 w-3" aria-hidden />
              Stop
            </button>
          ) : (
            <button
              type="submit"
              disabled={!draft.trim()}
              className={cn(MICRO_CAPS_BUTTON, "disabled:opacity-50")}
              title="Send message"
            >
              <Send className="h-3 w-3" aria-hidden />
              Send
            </button>
          )}
        </div>
      </div>
    </form>
  );
}
