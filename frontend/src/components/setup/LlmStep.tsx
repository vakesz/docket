/**
 * LLM credentials step — equivalent of `_step_llm`.
 *
 * Endpoint + deployment land in `config.toml`; the API key never does — the
 * backend writes it to the OS keyring at /setup/complete time. We surface
 * keyring-availability up-front so the user knows whether chat will work.
 */
import { useCliStatus, useTestLlm } from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { Notice } from "~/components/common/Notice";
import {
  dangerTextClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";
import type { LlmDraft } from "./types";
import { defaultPricesFor } from "./types";

interface Props {
  draft: LlmDraft;
  setDraft: React.Dispatch<React.SetStateAction<LlmDraft>>;
  onBack: () => void;
  onNext: () => void;
}

export function LlmStep({ draft, setDraft, onBack, onNext }: Props) {
  const cli = useCliStatus();
  const test = useTestLlm();
  const canTest = !!draft.endpoint.trim() && !!draft.api_key.trim() && !!draft.deployment.trim();

  return (
    <div className={setupCardClass}>
      {cli.data && !cli.data.keyring_available && !draft.skip && (
        <Notice tone="warning" title="OS keyring unavailable">
          {cli.data.keyring_error || "no backend detected"}. The wizard will refuse to write the API
          key until a keyring backend is installed; check "Skip LLM setup" to continue without chat.
        </Notice>
      )}

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          checked={draft.skip}
          onChange={(e) => setDraft((d) => ({ ...d, skip: e.target.checked }))}
          className="accent-accent"
        />
        Skip LLM setup — chat will stay disabled.
      </label>

      {!draft.skip && (
        <>
          <section className="flex flex-col gap-2">
            <Label required>Endpoint</Label>
            <TextInput
              value={draft.endpoint}
              onChange={(v) => setDraft((d) => ({ ...d, endpoint: v }))}
              placeholder="https://…cognitiveservices.azure.com/…chat/completions?api-version=…"
            />
          </section>
          <section className="flex flex-col gap-2">
            <Label required>API key</Label>
            <TextInput
              type="password"
              value={draft.api_key}
              onChange={(v) => setDraft((d) => ({ ...d, api_key: v }))}
            />
            <HelpText>
              Stored in the OS keyring (Keychain / Credential Manager / Secret Service); never
              persisted to config.toml.
            </HelpText>
          </section>
          <section className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label>Deployment</Label>
              <TextInput
                value={draft.deployment}
                onChange={(v) =>
                  setDraft((d) => {
                    const next: LlmDraft = { ...d, deployment: v };
                    if (!d.prices_dirty) {
                      const defaults = defaultPricesFor(v);
                      next.price_input_per_1m = defaults?.input ?? "";
                      next.price_output_per_1m = defaults?.output ?? "";
                    }
                    return next;
                  })
                }
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>API version</Label>
              <TextInput
                value={draft.api_version}
                onChange={(v) => setDraft((d) => ({ ...d, api_version: v }))}
              />
            </div>
          </section>
          <section className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label>Input price per 1M tokens (USD)</Label>
              <TextInput
                value={draft.price_input_per_1m}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, price_input_per_1m: v, prices_dirty: true }))
                }
                placeholder="e.g. 1.25"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label>Output price per 1M tokens (USD)</Label>
              <TextInput
                value={draft.price_output_per_1m}
                onChange={(v) =>
                  setDraft((d) => ({ ...d, price_output_per_1m: v, prices_dirty: true }))
                }
                placeholder="e.g. 10.00"
              />
            </div>
          </section>
          <HelpText>
            {defaultPricesFor(draft.deployment)
              ? "Prefilled with Azure Foundry list prices for this deployment — override if your contract differs, or clear both to hide cost in the ledger."
              : "Leave both blank to skip cost display in the chat ledger."}
          </HelpText>
          <section className="flex items-center gap-2 border-t border-border pt-3">
            <button
              type="button"
              disabled={!canTest || test.isPending}
              onClick={() =>
                test.mutate({
                  endpoint: draft.endpoint,
                  api_key: draft.api_key,
                  deployment: draft.deployment,
                  api_version: draft.api_version,
                })
              }
              className={xsBorderButtonClass}
            >
              {test.isPending ? "Testing…" : "Test LLM"}
            </button>
            {test.data?.ok && <span className="text-xs text-success-fg">OK</span>}
            {test.data?.ok === false && (
              <span className={dangerTextClass}>{test.data.error ?? "Failed"}</span>
            )}
          </section>
        </>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
          ← Back
        </button>
        <button type="button" onClick={onNext} className={primaryButtonClass}>
          Next
        </button>
      </div>
    </div>
  );
}
