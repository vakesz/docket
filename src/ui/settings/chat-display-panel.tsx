"use client";

import { Description, Field, Label, Radio, RadioGroup, Switch } from "@headlessui/react";
import { switchThumbClass, switchTrackClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { type ToolDisplayMode, useToolDisplayMode } from "@/lib/ui-prefs";

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
  const disabled = list.isPending || update.isPending;

  return (
    <div className="flex flex-col gap-6">
      <RadioGroup
        value={mode}
        onChange={setMode}
        aria-label="Tool calls in chat"
        className="flex flex-col gap-3"
      >
        <Label className="text-sm font-medium text-foreground">Tool calls in chat</Label>
        <p className="text-xs text-muted-foreground">
          Controls how the agent's tool invocations appear inside the chat transcript. Stored on
          this device only.
        </p>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((opt) => (
            <Field
              key={opt.value}
              className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2 text-sm text-foreground hover:bg-muted"
            >
              <Radio
                value={opt.value}
                className="group mt-1 grid size-4 shrink-0 place-items-center rounded-full border border-border bg-card data-[checked]:border-primary data-[checked]:bg-primary"
              >
                <span className="size-1.5 rounded-full bg-card opacity-0 group-data-[checked]:opacity-100" />
              </Radio>
              <span className="flex flex-col">
                <Label className="font-medium text-foreground">{opt.label}</Label>
                <Description className="text-xs text-muted-foreground">{opt.helper}</Description>
              </span>
            </Field>
          ))}
        </div>
      </RadioGroup>

      <Field className="flex flex-col gap-1 border-t border-border pt-6">
        <Label className="text-sm font-medium text-foreground">Send on Enter</Label>
        <p className="text-xs text-muted-foreground">
          When on, Enter sends a message and Shift+Enter inserts a newline. When off, Enter inserts
          a newline and Cmd/Ctrl+Enter sends.
        </p>
        <Field className="flex items-center gap-2 text-sm text-foreground">
          <Switch
            checked={sendOnEnter === true}
            disabled={disabled}
            onChange={(next) => update.mutate({ key: "chat.send-on-enter" as never, value: next })}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>{sendOnEnter === true ? "Enabled" : "Disabled"}</Label>
        </Field>
        {update.error ? <p className="text-xs text-destructive">{update.error.message}</p> : null}
      </Field>
    </div>
  );
}
