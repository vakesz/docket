import { RefreshCw } from "lucide-react";
import { useState } from "react";

import { useRegenerateHttpToken } from "~/api/hooks";
import { FormField } from "~/components/common/FormField";
import { NumberInput, TextInput } from "~/components/common/FormInputs";
import { Toggle } from "~/components/common/Toggle";
import { outlineButtonClass } from "~/lib/formClasses";

import { getBoolean, getNumberValue, getString, setOrUnset } from "../_helpers";
import type { ConfigMap } from "../_types";

export function HttpForm({
  value,
  initialToken,
  onChange,
}: {
  value: ConfigMap;
  initialToken: string | null;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const enabled = getBoolean(value, "enabled") ?? false;
  const bind = getString(value, "bind") ?? "";
  const port = getNumberValue(value, "port");
  // Token: only present in `value` if user typed something. Show the current
  // masked value as placeholder.
  const tokenInDraft = "token" in value ? String(value.token ?? "") : "";

  return (
    <>
      <FormField label="HTTP API" help="Expose the local FastAPI surface.">
        <Toggle
          checked={enabled}
          onChange={(v) => onChange((cur) => ({ ...cur, enabled: v }))}
          label={enabled ? "Enabled" : "Disabled"}
        />
      </FormField>

      <div className="grid gap-4 sm:grid-cols-[1fr_140px]">
        <FormField label="Bind address" help="Hostname or IP the server listens on.">
          <TextInput
            value={bind}
            onChange={(v) => onChange((cur) => ({ ...cur, bind: v }))}
            placeholder="127.0.0.1"
          />
        </FormField>
        <FormField label="Port">
          <NumberInput
            value={port}
            min={1}
            max={65535}
            step={1}
            onChange={(v) => onChange((cur) => ({ ...cur, port: v ?? 0 }))}
          />
        </FormField>
      </div>

      <FormField
        label="Bearer token"
        help="Leave empty to keep the current token. Type a new value to replace it, or click Regenerate for a random one."
      >
        <div className="flex w-full gap-2">
          <TextInput
            type="password"
            value={tokenInDraft}
            onChange={(v) => onChange((cur) => setOrUnset(cur, "token", v))}
            placeholder={initialToken ? initialToken : "(no token set)"}
          />
          <HttpTokenRegenButton />
        </div>
      </FormField>
    </>
  );
}

function HttpTokenRegenButton() {
  const regen = useRegenerateHttpToken();
  const [revealed, setRevealed] = useState<string | null>(null);
  const trigger = () => {
    if (regen.isPending) return;
    regen.mutate(undefined, { onSuccess: (data) => setRevealed(data.token) });
  };
  const copy = () => {
    if (!revealed) return;
    void navigator.clipboard?.writeText(revealed);
  };
  return (
    <div className="flex shrink-0 flex-col gap-1">
      <button
        type="button"
        onClick={trigger}
        disabled={regen.isPending}
        className={outlineButtonClass}
      >
        <RefreshCw className="h-4 w-4" />
        {regen.isPending ? "…" : "Regenerate"}
      </button>
      {revealed && (
        <button
          type="button"
          onClick={copy}
          className="text-[10px] font-mono text-fg-muted hover:text-fg"
          title="Copy to clipboard"
        >
          Copy new token
        </button>
      )}
    </div>
  );
}
