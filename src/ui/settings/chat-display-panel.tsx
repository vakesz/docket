"use client";

// UI-only preference — see src/lib/ui-prefs.ts. Deliberately not in SETTINGS_CATALOG.

import { Description, Field, Label, Radio, RadioGroup } from "@headlessui/react";
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

export function ChatDisplayPanel() {
  const [mode, setMode] = useToolDisplayMode();

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h2 className="text-base font-medium text-fg">Chat</h2>
        <p className="text-sm text-fg-muted">
          Browser-local display preferences for the chat pane. Stored on this device only.
        </p>
      </header>

      <RadioGroup
        value={mode}
        onChange={setMode}
        aria-label="Tool calls in chat"
        className="flex flex-col gap-3"
      >
        <Label className="text-sm font-medium text-fg">Tool calls in chat</Label>
        <p className="text-xs text-fg-muted">
          Controls how tool invocations the agent makes appear inside the chat transcript.
        </p>
        <div className="flex flex-col gap-2">
          {OPTIONS.map((opt) => (
            <Field
              key={opt.value}
              className="flex items-start gap-3 rounded-lg border border-border bg-surface px-3 py-2 text-sm text-fg hover:bg-surface-alt"
            >
              <Radio
                value={opt.value}
                className="group mt-1 grid size-4 shrink-0 place-items-center rounded-full border border-border bg-surface data-[checked]:border-accent data-[checked]:bg-accent"
              >
                <span className="size-1.5 rounded-full bg-surface opacity-0 group-data-[checked]:opacity-100" />
              </Radio>
              <span className="flex flex-col">
                <Label className="font-medium text-fg">{opt.label}</Label>
                <Description className="text-xs text-fg-muted">{opt.helper}</Description>
              </span>
            </Field>
          ))}
        </div>
      </RadioGroup>
    </div>
  );
}
