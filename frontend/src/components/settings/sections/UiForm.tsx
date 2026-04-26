import { NumberInput, Select } from "~/components/common/FormInputs";
import { Toggle } from "~/components/common/Toggle";
import { ThemePicker } from "~/components/shell/ThemePicker";
import { ToolDisplayPicker } from "~/components/shell/ToolDisplayPicker";

import { ITEM_KINDS, THEME_OPTIONS } from "../_constants";
import { getBoolean, getNumberValue, getString } from "../_helpers";
import { FormField } from "../_shared";
import type { ConfigMap } from "../_types";

export function UiForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const theme = getString(value, "theme") ?? "";
  const defaultKind = getString(value, "default_new_item_kind") ?? "task";
  const showAcceptance = getBoolean(value, "show_acceptance_criteria") ?? true;
  const hideDone = getBoolean(value, "hide_done") ?? true;
  const tagLimit = getNumberValue(value, "tag_filter_collapse_limit");

  return (
    <>
      <FormField
        label="Web theme"
        help="Color theme for this web UI. Stored in your browser; does not affect the TUI."
      >
        <ThemePicker />
      </FormField>

      <FormField
        label="Chat tool messages"
        help="How tool-call results render in the chat pane. Stored in your browser; does not affect the TUI."
      >
        <ToolDisplayPicker />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Theme" help="TUI (terminal) theme. Saved to config.toml.">
          <Select
            value={theme}
            options={THEME_OPTIONS.map((t) => ({ value: t, label: t }))}
            onChange={(v) => onChange((cur) => ({ ...cur, theme: v }))}
            allowCustom
            placeholder="textual-dark"
          />
        </FormField>
        <FormField label="Default new item kind">
          <Select
            value={defaultKind}
            options={ITEM_KINDS.map((k) => ({ value: k, label: k }))}
            onChange={(v) => onChange((cur) => ({ ...cur, default_new_item_kind: v }))}
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Show acceptance criteria"
          help="Reveal the acceptance criteria block in item detail views."
        >
          <Toggle
            checked={showAcceptance}
            onChange={(v) => onChange((cur) => ({ ...cur, show_acceptance_criteria: v }))}
            label={showAcceptance ? "Visible" : "Hidden"}
          />
        </FormField>

        <FormField
          label="Hide done items"
          help="Hide resolved/closed items from the backlog on startup. The TUI's `c` key toggles this at runtime."
        >
          <Toggle
            checked={hideDone}
            onChange={(v) => onChange((cur) => ({ ...cur, hide_done: v }))}
            label={hideDone ? "Hidden" : "Shown"}
          />
        </FormField>
      </div>

      <FormField
        label="Tag filter collapse limit"
        help="Number of tag chips shown before the “+N more” toggle. 0 disables collapsing."
      >
        <NumberInput
          value={tagLimit}
          min={0}
          max={100}
          step={1}
          onChange={(v) => onChange((cur) => ({ ...cur, tag_filter_collapse_limit: v ?? 0 }))}
        />
      </FormField>
    </>
  );
}
