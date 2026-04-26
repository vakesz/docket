import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import {
  useCompleteSetup,
  useProviderTypes,
  useSetupStatus,
  useTestLlm,
  useTestProvider,
} from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import {
  dangerTextClass,
  metaLabelClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";

type Step = "welcome" | "provider" | "llm" | "review";

interface ProviderDraft {
  key: string;
  type: string;
  display_name: string;
  config: Record<string, string>;
}

interface LlmDraft {
  endpoint: string;
  api_key: string;
  deployment: string;
  api_version: string;
  price_input_per_1m: string;
  price_output_per_1m: string;
  // Tracks whether the user has hand-edited prices. Until they do, switching
  // deployments auto-refills with the known Azure Foundry list price.
  prices_dirty: boolean;
  skip: boolean;
}

// Azure Foundry list prices per 1M tokens for known deployments. Mirrors
// `KNOWN_MODEL_PRICES` in src/docket/config/setup_wizard.py.
const KNOWN_MODEL_PRICES: Record<string, { input: string; output: string }> = {
  "gpt-5": { input: "1.25", output: "10.00" },
  "gpt-5-mini": { input: "0.25", output: "2.00" },
  "gpt-5-nano": { input: "0.05", output: "0.40" },
};

function defaultPricesFor(deployment: string): { input: string; output: string } | null {
  return KNOWN_MODEL_PRICES[deployment.trim().toLowerCase()] ?? null;
}

export function SetupWizard() {
  const status = useSetupStatus();
  const types = useProviderTypes();
  const [step, setStep] = useState<Step>("welcome");

  const [provider, setProvider] = useState<ProviderDraft>({
    key: "default",
    type: "",
    display_name: "Default",
    config: {},
  });
  const [llm, setLlm] = useState<LlmDraft>(() => {
    const defaults = defaultPricesFor("gpt-5");
    return {
      endpoint: "",
      api_key: "",
      deployment: "gpt-5",
      api_version: "2025-01-01-preview",
      price_input_per_1m: defaults?.input ?? "",
      price_output_per_1m: defaults?.output ?? "",
      prices_dirty: false,
      skip: false,
    };
  });

  return (
    <div className="flex min-h-screen flex-col bg-bg">
      <header className="border-b border-border bg-surface px-6 py-4">
        <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-fg">
          Docket · First-time setup
        </h1>
        {status.data?.config_path && (
          <p className="mt-1 font-mono text-[11px] text-fg-muted">
            config will be written to {status.data.config_path}
          </p>
        )}
      </header>

      <div className="flex items-center gap-2 border-b border-border bg-surface px-6 py-2">
        <StepDot active={step === "welcome"} label="Welcome" />
        <Arrow />
        <StepDot active={step === "provider"} label="Provider" />
        <Arrow />
        <StepDot active={step === "llm"} label="LLM" />
        <Arrow />
        <StepDot active={step === "review"} label="Review" />
      </div>

      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        {step === "welcome" && <WelcomeStep onNext={() => setStep("provider")} />}
        {step === "provider" && (
          <ProviderStep
            types={types.data ?? []}
            loading={types.isPending}
            draft={provider}
            setDraft={setProvider}
            onBack={() => setStep("welcome")}
            onNext={() => setStep("llm")}
          />
        )}
        {step === "llm" && (
          <LlmStep
            draft={llm}
            setDraft={setLlm}
            onBack={() => setStep("provider")}
            onNext={() => setStep("review")}
          />
        )}
        {step === "review" && (
          <ReviewStep provider={provider} llm={llm} onBack={() => setStep("llm")} />
        )}
      </main>
    </div>
  );
}

function StepDot({ active, label }: { active: boolean; label: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] uppercase tracking-wider",
        active ? "text-accent" : "text-fg-muted",
      )}
    >
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="font-mono text-[10px] text-fg-faint">→</span>;
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className={setupCardClass}>
      <p>
        Docket is ready to configure. We'll connect a work-item provider (GitHub, Azure DevOps, or a
        demo stub), optionally wire an Azure OpenAI deployment for chat, and then write your{" "}
        <code className="rounded bg-surface-alt px-1 text-fg">config.toml</code>.
      </p>
      <p className="text-fg-muted">
        The backend restarts automatically once setup is complete — the page will reload shortly
        after.
      </p>
      <div className="flex justify-end">
        <button type="button" onClick={onNext} className={primaryButtonClass}>
          Start
        </button>
      </div>
    </div>
  );
}

function ProviderStep({
  types,
  loading,
  draft,
  setDraft,
  onBack,
  onNext,
}: {
  types: DTO["SetupProviderTypeDTO"][];
  loading: boolean;
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const test = useTestProvider();
  const selected = types.find((t) => t.id === draft.type);

  const fieldsValid = useMemo(() => {
    if (!selected) return false;
    return (selected.fields ?? []).every(
      (f) => !f.required || (draft.config[f.key] ?? "").trim().length > 0,
    );
  }, [selected, draft.config]);

  return (
    <div className={setupCardClass}>
      <section className="flex flex-col gap-2">
        <Label>Provider type</Label>
        {loading ? (
          <span className="text-xs text-fg-muted">Loading provider types…</span>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {types.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setDraft((d) => ({ ...d, type: t.id, config: {} }))}
                className={cn(
                  "rounded-xl border p-3 text-left",
                  draft.type === t.id
                    ? "border-accent bg-accent/5"
                    : "border-border hover:border-fg-faint",
                )}
              >
                <div className="font-medium">{t.display}</div>
                {(t.requires_cli?.length ?? 0) > 0 && (
                  <div className={cn("mt-1", metaLabelClass)}>
                    needs: {t.requires_cli?.join(" ")}
                  </div>
                )}
              </button>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <Label>Display name</Label>
        <TextInput
          value={draft.display_name}
          onChange={(v) => setDraft((d) => ({ ...d, display_name: v }))}
        />
      </section>

      <section className="flex flex-col gap-2">
        <Label>Internal key</Label>
        <TextInput
          value={draft.key}
          onChange={(v) =>
            setDraft((d) => ({ ...d, key: v.replace(/[^a-z0-9_-]/gi, "_").toLowerCase() }))
          }
          placeholder="default"
        />
      </section>

      {selected?.fields?.map((field) => (
        <section key={field.key} className="flex flex-col gap-2">
          <Label required={field.required}>{field.label}</Label>
          <TextInput
            value={draft.config[field.key] ?? ""}
            onChange={(v) => setDraft((d) => ({ ...d, config: { ...d.config, [field.key]: v } }))}
            type={field.kind === "secret" ? "password" : "text"}
            placeholder={field.placeholder}
          />
          {field.help && <HelpText>{field.help}</HelpText>}
        </section>
      ))}

      {selected && (
        <section className="flex items-center gap-2 border-t border-border pt-3">
          <button
            type="button"
            disabled={!fieldsValid || test.isPending}
            onClick={() => test.mutate({ type: selected.id, config: draft.config })}
            className={xsBorderButtonClass}
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          {test.data?.ok && <span className="text-xs text-success">OK</span>}
          {test.data?.ok === false && (
            <span className={dangerTextClass}>{test.data.error ?? "Failed"}</span>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
          ← Back
        </button>
        <button
          type="button"
          disabled={!selected || !fieldsValid}
          onClick={onNext}
          className={primaryButtonClass}
        >
          Next
        </button>
      </div>
    </div>
  );
}

function LlmStep({
  draft,
  setDraft,
  onBack,
  onNext,
}: {
  draft: LlmDraft;
  setDraft: React.Dispatch<React.SetStateAction<LlmDraft>>;
  onBack: () => void;
  onNext: () => void;
}) {
  const test = useTestLlm();
  const canTest = !!draft.endpoint.trim() && !!draft.api_key.trim() && !!draft.deployment.trim();

  return (
    <div className={setupCardClass}>
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
          </section>
          <section className="grid gap-2 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label>Deployment</Label>
              <TextInput
                value={draft.deployment}
                onChange={(v) =>
                  setDraft((d) => {
                    const next: LlmDraft = { ...d, deployment: v };
                    // Auto-refill prices for known deployments until the user
                    // edits a price field — then we leave their values alone.
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
            {test.data?.ok && <span className="text-xs text-success">OK</span>}
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

function parseOptionalFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

function ReviewStep({
  provider,
  llm,
  onBack,
}: {
  provider: ProviderDraft;
  llm: LlmDraft;
  onBack: () => void;
}) {
  const complete = useCompleteSetup();

  const submit = () => {
    const body: DTO["SetupCompleteRequest"] = {
      providers: {
        [provider.key]: {
          type: provider.type,
          display_name: provider.display_name,
          config: provider.config,
        },
      },
      active_provider: provider.key,
      llm: llm.skip
        ? null
        : {
            endpoint: llm.endpoint,
            api_key: llm.api_key,
            deployment: llm.deployment,
            api_version: llm.api_version,
            price_input_per_1m: parseOptionalFloat(llm.price_input_per_1m),
            price_output_per_1m: parseOptionalFloat(llm.price_output_per_1m),
          },
      http_bind: "0.0.0.0",
      http_port: 8765,
      http_token: "",
      telemetry_enabled: true,
      telemetry_level: "DEBUG",
      run_initial_sync: true,
    };
    complete.mutate(body);
  };

  if (complete.data) {
    return (
      <Notice tone="ok" title="Configuration written">
        <div className="flex flex-col gap-2">
          <div className="font-mono text-[11px]">{complete.data.config_path}</div>
          {complete.data.initial_sync && (
            <div className="font-mono text-[11px]">
              Initial sync: upserted {complete.data.initial_sync.upserted}, archived{" "}
              {complete.data.initial_sync.archived}
            </div>
          )}
          <p>
            The backend is restarting. This page will reload in a few seconds — if it doesn't,
            refresh manually.
          </p>
          <ReloadTimer />
        </div>
      </Notice>
    );
  }

  return (
    <div className={setupCardClass}>
      <section className="rounded-xl border border-border p-3">
        <div className={cn("mb-1", metaLabelClass)}>Provider</div>
        <div>
          {provider.display_name}{" "}
          <span className="font-mono text-[10px] text-fg-muted">({provider.type})</span>
        </div>
      </section>
      <section className="rounded-xl border border-border p-3">
        <div className={cn("mb-1", metaLabelClass)}>LLM</div>
        <div>{llm.skip ? "Disabled" : `${llm.deployment} @ ${llm.endpoint}`}</div>
      </section>

      {complete.error && (
        <Notice tone="error" title="Setup failed">
          {complete.error.message}
        </Notice>
      )}

      <div className="flex justify-between">
        <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
          ← Back
        </button>
        <button
          type="button"
          disabled={complete.isPending}
          onClick={submit}
          className={primaryButtonClass}
        >
          {complete.isPending ? "Writing config…" : "Finish setup"}
        </button>
      </div>
    </div>
  );
}

function ReloadTimer() {
  useEffect(() => {
    if (typeof window === "undefined") return;
    const id = window.setTimeout(() => window.location.reload(), 6000);
    return () => window.clearTimeout(id);
  }, []);
  return <div className="font-mono text-[11px] text-fg-muted">Reloading in ~6 seconds…</div>;
}
