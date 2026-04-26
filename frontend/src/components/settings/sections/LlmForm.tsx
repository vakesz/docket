import { RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";

import { useRemoveLlmKey, useRotateLlmKey } from "~/api/hooks";
import { FormField } from "~/components/common/FormField";
import { NumberInput, TextInput } from "~/components/common/FormInputs";
import { type KeyHint, KeyHintBadge } from "~/components/common/KeyHintBadge";
import { cn } from "~/lib/cn";
import { dangerTextClass, outlineButtonClass } from "~/lib/formClasses";

import { asRecord, getNumberValue, getString, setOrUnset } from "../_helpers";
import type { ConfigMap } from "../_types";

function readKeyHint(value: ConfigMap): KeyHint | null {
  const rec = asRecord(value.key_hint);
  if (!rec) return null;
  const configured = rec.configured;
  if (typeof configured !== "boolean" || !configured) return null;
  return {
    configured,
    prefix: typeof rec.prefix === "string" ? rec.prefix : "",
    suffix: typeof rec.suffix === "string" ? rec.suffix : "",
    length: typeof rec.length === "number" ? rec.length : 0,
    updated_at: typeof rec.updated_at === "string" ? rec.updated_at : null,
  };
}

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
  const keyHint = readKeyHint(value);

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

      <LlmKeyRotation hint={keyHint} />

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

function LlmKeyRotation({ hint }: { hint: KeyHint | null }) {
  const [draft, setDraft] = useState("");
  const rotate = useRotateLlmKey();
  const remove = useRemoveLlmKey();

  const submit = () => {
    if (!draft.trim() || rotate.isPending) return;
    rotate.mutate({ api_key: draft.trim() }, { onSuccess: () => setDraft("") });
  };

  const removeKey = () => {
    if (remove.isPending || !hint?.configured) return;
    if (typeof window !== "undefined") {
      if (!window.confirm("Remove the stored Azure OpenAI key? Chat will stop working.")) return;
    }
    remove.mutate();
  };

  return (
    <FormField
      label="API key"
      help="Azure OpenAI key. Stored in the OS keyring (macOS Keychain / Windows Credential Manager / Secret Service) — never in config.toml. Only a non-secret hint persists for UI preview."
    >
      <div className="flex flex-col gap-2">
        {hint && (
          <div className="flex items-center gap-2">
            <KeyHintBadge hint={hint} />
            <button
              type="button"
              onClick={removeKey}
              disabled={remove.isPending}
              className={cn(outlineButtonClass, "shrink-0 text-danger")}
            >
              <Trash2 className="h-4 w-4" />
              {remove.isPending ? "Removing…" : "Remove"}
            </button>
          </div>
        )}
        <div className="flex w-full gap-2">
          <TextInput
            type="password"
            value={draft}
            onChange={setDraft}
            placeholder={hint ? "Enter a new key to rotate" : "Paste your Azure OpenAI key"}
          />
          <button
            type="button"
            onClick={submit}
            disabled={rotate.isPending || !draft.trim()}
            className={cn(outlineButtonClass, "shrink-0")}
          >
            <RotateCcw className="h-4 w-4" />
            {rotate.isPending ? "Saving…" : hint ? "Rotate" : "Save"}
          </button>
        </div>
      </div>
      {rotate.error && <p className={dangerTextClass}>{(rotate.error as Error).message}</p>}
      {remove.error && <p className={dangerTextClass}>{(remove.error as Error).message}</p>}
      {rotate.isSuccess && rotate.data && (
        <p className="text-xs text-fg-muted">
          {rotate.data.requires_restart
            ? "Key updated. Restart `docket serve` for chat to pick up the new key."
            : "Key written to the OS keyring."}
        </p>
      )}
      {remove.isSuccess && remove.data && (
        <p className="text-xs text-fg-muted">
          Key cleared. Chat will 503 until a new key is stored.
        </p>
      )}
    </FormField>
  );
}
