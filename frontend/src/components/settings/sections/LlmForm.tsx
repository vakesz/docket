import { RotateCcw } from "lucide-react";
import { useState } from "react";

import { useRotateLlmKey } from "~/api/hooks";
import { NumberInput, TextInput } from "~/components/common/FormInputs";

import { getNumberValue, getString, setOrUnset } from "../_helpers";
import { FormField } from "../_shared";
import type { ConfigMap } from "../_types";

export function LlmForm({
  value,
  onChange,
}: {
  value: ConfigMap;
  onChange: (updater: (current: ConfigMap) => ConfigMap) => void;
}) {
  const endpoint = getString(value, "endpoint") ?? "";
  const deployment = getString(value, "deployment") ?? "";
  const compaction = getNumberValue(value, "compaction_threshold_tokens");
  const watch = getNumberValue(value, "external_watch_interval_seconds");
  const priceInput = getNumberValue(value, "price_input_per_1m");
  const priceOutput = getNumberValue(value, "price_output_per_1m");

  return (
    <>
      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <FormField
          label="Endpoint"
          help="Azure OpenAI chat-completions URL (including api-version)."
        >
          <TextInput
            type="url"
            value={endpoint}
            onChange={(v) => onChange((cur) => setOrUnset(cur, "endpoint", v))}
            placeholder="https://…cognitiveservices.azure.com/…/chat/completions?api-version=…"
          />
        </FormField>
        <FormField label="Deployment" help="Azure OpenAI deployment name.">
          <TextInput
            value={deployment}
            onChange={(v) => onChange((cur) => ({ ...cur, deployment: v }))}
            placeholder="gpt-5"
          />
        </FormField>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          label="Input price per 1M tokens (USD)"
          help="Used to compute chat cost. Clear to hide cost in the ledger."
        >
          <NumberInput
            value={priceInput}
            min={0}
            step={0.01}
            onChange={(v) => onChange((cur) => ({ ...cur, price_input_per_1m: v }))}
            suffix="$"
          />
        </FormField>
        <FormField
          label="Output price per 1M tokens (USD)"
          help="Used to compute chat cost. Clear to hide cost in the ledger."
        >
          <NumberInput
            value={priceOutput}
            min={0}
            step={0.01}
            onChange={(v) => onChange((cur) => ({ ...cur, price_output_per_1m: v }))}
            suffix="$"
          />
        </FormField>
      </div>

      <LlmKeyRotation />

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField label="Compaction threshold" help="Tokens before older messages get summarized.">
          <NumberInput
            value={compaction}
            min={0}
            step={1000}
            onChange={(v) => onChange((cur) => ({ ...cur, compaction_threshold_tokens: v ?? 0 }))}
          />
        </FormField>
        <FormField
          label="External watch interval"
          help="Seconds between external-change checks. 0 disables the watcher."
        >
          <NumberInput
            value={watch}
            min={0}
            step={1}
            onChange={(v) =>
              onChange((cur) => ({ ...cur, external_watch_interval_seconds: v ?? 0 }))
            }
            suffix="s"
          />
        </FormField>
      </div>
    </>
  );
}

function LlmKeyRotation() {
  const [draft, setDraft] = useState("");
  const rotate = useRotateLlmKey();
  const submit = () => {
    if (!draft.trim() && !rotate.isPending) return;
    rotate.mutate({ api_key: draft.trim() }, { onSuccess: () => setDraft("") });
  };
  return (
    <FormField
      label="API key"
      help="Azure OpenAI key. Stored in the XDG `.env` file — never in config.toml. Leave empty to clear (disables chat)."
    >
      <div className="flex w-full gap-2">
        <TextInput
          type="password"
          value={draft}
          onChange={setDraft}
          placeholder="Enter a new key to rotate"
        />
        <button
          type="button"
          onClick={submit}
          disabled={rotate.isPending}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-xl border border-border px-3 py-2 text-sm font-medium text-fg hover:bg-surface-alt disabled:cursor-not-allowed disabled:opacity-40"
        >
          <RotateCcw className="h-4 w-4" />
          {rotate.isPending ? "Saving…" : "Rotate"}
        </button>
      </div>
      {rotate.error && <p className="text-xs text-danger">{(rotate.error as Error).message}</p>}
      {rotate.isSuccess && rotate.data && (
        <p className="text-xs text-fg-muted">
          {rotate.data.configured
            ? rotate.data.requires_restart
              ? "Key updated. Restart `docket serve` for chat to pick up the new key."
              : "Key written to .env."
            : "Key cleared. Chat will 503 until a new key is set."}
        </p>
      )}
    </FormField>
  );
}
