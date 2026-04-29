"use client";

import { useEffect, useId, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { type ToolDisplayMode, useToolDisplayMode } from "@/lib/ui-prefs";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { RadioGroup, RadioGroupItem } from "@/ui/primitives/radio-group";
import { Switch } from "@/ui/primitives/switch";

const MAX_TOOL_ROUNDS_MIN = 3;
const MAX_TOOL_ROUNDS_MAX = 30;
const MAX_TOOL_ROUNDS_DEFAULT = 12;

const OPTIONS: { value: ToolDisplayMode; label: string; helper: string }[] = [
  {
    value: "show",
    label: "Show open",
    helper: "Tool calls render fully expanded.",
  },
  {
    value: "collapse",
    label: "Collapse",
    helper: "Tool calls render as one-line rows you can click to expand.",
  },
  {
    value: "hide",
    label: "Hide",
    helper: "Tool calls are hidden — you only see the assistant's text.",
  },
];

/**
 * Chat section — chat-pane preferences. Mixes browser-local rendering
 * preferences (tool-call display mode, stored on this device) with
 * catalog-backed keybinding preferences (send-on-Enter, synced to your
 * account).
 */
export function ChatDisplayPanel() {
  const [mode, setMode] = useToolDisplayMode();

  const utils = trpc.useUtils();
  const list = trpc.settings.list.useQuery();
  const update = trpc.settings.update.useMutation({
    onSuccess: async () => {
      await utils.settings.list.invalidate();
    },
  });

  const sendOnEnter = list.data?.find((r) => r.key === "chat.send-on-enter")?.value ?? true;
  const storedMaxRounds = list.data?.find((r) => r.key === "chat.max-tool-rounds")?.value;
  const disabled = list.isPending || update.isPending;
  const sendOnEnterId = useId();
  const maxRoundsId = useId();

  const [maxRounds, setMaxRounds] = useState<string>(String(MAX_TOOL_ROUNDS_DEFAULT));
  useEffect(() => {
    if (typeof storedMaxRounds === "number") {
      setMaxRounds(String(storedMaxRounds));
    }
  }, [storedMaxRounds]);

  const commitMaxRounds = () => {
    const n = Number.parseInt(maxRounds, 10);
    if (!Number.isFinite(n) || n < MAX_TOOL_ROUNDS_MIN || n > MAX_TOOL_ROUNDS_MAX) {
      // Snap back to the last valid stored value so the field never holds garbage.
      setMaxRounds(String(storedMaxRounds ?? MAX_TOOL_ROUNDS_DEFAULT));
      return;
    }
    if (n === storedMaxRounds) return;
    update.mutate({ key: "chat.max-tool-rounds" as never, value: n });
  };

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        <Label className="text-sm font-medium text-foreground">Tool calls in chat</Label>
        <p className="text-xs text-muted-foreground">
          Controls how the agent's tool invocations appear inside the chat transcript. Stored on
          this device only.
        </p>
        <RadioGroup
          value={mode}
          onValueChange={(value) => setMode(value as ToolDisplayMode)}
          aria-label="Tool calls in chat"
          className="flex flex-col gap-2"
        >
          {OPTIONS.map((opt) => (
            <ToolDisplayOption key={opt.value} option={opt} />
          ))}
        </RadioGroup>
      </div>

      <div className="flex flex-col gap-1 border-t border-border pt-6">
        <Label htmlFor={sendOnEnterId} className="text-sm font-medium text-foreground">
          Send on Enter
        </Label>
        <p className="text-xs text-muted-foreground">
          When on, Enter sends a message and Shift+Enter inserts a newline. When off, Enter inserts
          a newline and Cmd/Ctrl+Enter sends.
        </p>
        <div className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            id={sendOnEnterId}
            checked={sendOnEnter === true}
            disabled={disabled}
            onCheckedChange={(next) =>
              update.mutate({ key: "chat.send-on-enter" as never, value: next })
            }
          />
          <Label htmlFor={sendOnEnterId}>{sendOnEnter === true ? "Enabled" : "Disabled"}</Label>
        </div>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <Label htmlFor={maxRoundsId} className="text-sm font-medium text-foreground">
          Max agent tool-call rounds per turn
        </Label>
        <p className="text-xs text-muted-foreground">
          Hard cap on how many tool-call rounds the agent runs inside one turn before it aborts.
          Higher values let multi-step investigations finish; lower values cut off runaway loops
          sooner. Range {MAX_TOOL_ROUNDS_MIN}–{MAX_TOOL_ROUNDS_MAX}.
        </p>
        <Input
          id={maxRoundsId}
          type="number"
          inputMode="numeric"
          min={MAX_TOOL_ROUNDS_MIN}
          max={MAX_TOOL_ROUNDS_MAX}
          step={1}
          value={maxRounds}
          disabled={disabled}
          onChange={(e) => setMaxRounds(e.target.value)}
          onBlur={commitMaxRounds}
          className="max-w-[8rem]"
        />
      </div>

      {update.error ? (
        <Alert variant="destructive">
          <AlertDescription>{update.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function ToolDisplayOption({
  option,
}: {
  option: { value: ToolDisplayMode; label: string; helper: string };
}) {
  const id = useId();
  return (
    <label
      htmlFor={id}
      className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
    >
      <RadioGroupItem id={id} value={option.value} className="mt-1" />
      <span className="flex flex-col">
        <span className="font-medium text-foreground">{option.label}</span>
        <span className="text-xs text-muted-foreground">{option.helper}</span>
      </span>
    </label>
  );
}
