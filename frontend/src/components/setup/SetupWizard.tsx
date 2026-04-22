import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import {
  useCompleteSetup,
  useProviderTypes,
  useSetupStatus,
  useTestLlm,
  useTestProvider,
} from "~/api/hooks";
import { cn } from "~/lib/cn";

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
  skip: boolean;
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
  const [llm, setLlm] = useState<LlmDraft>({
    endpoint: "",
    api_key: "",
    deployment: "gpt-5",
    api_version: "2025-01-01-preview",
    skip: false,
  });

  return (
    <div className="flex min-h-screen flex-col bg-zinc-50 dark:bg-zinc-950">
      <header className="border-b border-zinc-200 bg-white px-6 py-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h1 className="font-mono text-sm font-semibold uppercase tracking-[0.2em] text-zinc-900 dark:text-zinc-100">
          Docket · First-time setup
        </h1>
        {status.data?.config_path && (
          <p className="mt-1 font-mono text-[11px] text-zinc-500">
            config will be written to {status.data.config_path}
          </p>
        )}
      </header>

      <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-6 py-2 dark:border-zinc-800 dark:bg-zinc-950">
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
        active ? "text-accent" : "text-zinc-500",
      )}
    >
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="font-mono text-[10px] text-zinc-400">→</span>;
}

function WelcomeStep({ onNext }: { onNext: () => void }) {
  return (
    <div className="flex flex-col gap-4 rounded border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <p>
        Docket is ready to configure. We'll connect a work-item provider (GitHub, Azure DevOps, or a
        demo stub), optionally wire an Azure OpenAI deployment for chat, and then write your{" "}
        <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-900">config.toml</code>.
      </p>
      <p className="text-zinc-500">
        The backend restarts automatically once setup is complete — the page will reload shortly
        after.
      </p>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onNext}
          className="rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent/90"
        >
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
    <div className="flex flex-col gap-4 rounded border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <section className="flex flex-col gap-2">
        <Label>Provider type</Label>
        {loading ? (
          <span className="text-xs text-zinc-500">Loading provider types…</span>
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            {types.map((t) => (
              <button
                type="button"
                key={t.id}
                onClick={() => setDraft((d) => ({ ...d, type: t.id, config: {} }))}
                className={cn(
                  "rounded border p-3 text-left",
                  draft.type === t.id
                    ? "border-accent bg-accent/5"
                    : "border-zinc-200 hover:border-zinc-300 dark:border-zinc-800",
                )}
              >
                <div className="font-medium">{t.display}</div>
                {(t.requires_cli?.length ?? 0) > 0 && (
                  <div className="mt-1 font-mono text-[10px] uppercase tracking-wider text-zinc-500">
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
        <section className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <button
            type="button"
            disabled={!fieldsValid || test.isPending}
            onClick={() => test.mutate({ type: selected.id, config: draft.config })}
            className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
          >
            {test.isPending ? "Testing…" : "Test connection"}
          </button>
          {test.data?.ok && (
            <span className="text-xs text-emerald-600 dark:text-emerald-400">OK</span>
          )}
          {test.data?.ok === false && (
            <span className="text-xs text-rose-600 dark:text-rose-400">
              {test.data.error ?? "Failed"}
            </span>
          )}
        </section>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-zinc-500 hover:text-zinc-700"
        >
          ← Back
        </button>
        <button
          type="button"
          disabled={!selected || !fieldsValid}
          onClick={onNext}
          className="rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
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
    <div className="flex flex-col gap-4 rounded border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-950">
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
                onChange={(v) => setDraft((d) => ({ ...d, deployment: v }))}
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
          <section className="flex items-center gap-2 border-t border-zinc-200 pt-3 dark:border-zinc-800">
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
              className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
            >
              {test.isPending ? "Testing…" : "Test LLM"}
            </button>
            {test.data?.ok && (
              <span className="text-xs text-emerald-600 dark:text-emerald-400">OK</span>
            )}
            {test.data?.ok === false && (
              <span className="text-xs text-rose-600 dark:text-rose-400">
                {test.data.error ?? "Failed"}
              </span>
            )}
          </section>
        </>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-zinc-500 hover:text-zinc-700"
        >
          ← Back
        </button>
        <button
          type="button"
          onClick={onNext}
          className="rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent/90"
        >
          Next
        </button>
      </div>
    </div>
  );
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
      foundry: llm.skip
        ? null
        : {
            endpoint: llm.endpoint,
            api_key: llm.api_key,
            deployment: llm.deployment,
            api_version: llm.api_version,
          },
      http_bind: "0.0.0.0",
      http_port: 8765,
      http_token: "",
      telemetry_enabled: true,
      run_initial_sync: true,
    };
    complete.mutate(body);
  };

  if (complete.data) {
    return (
      <div className="flex flex-col gap-3 rounded border border-emerald-300 bg-emerald-50 p-6 text-sm dark:border-emerald-900 dark:bg-emerald-950/40">
        <div className="font-semibold">Configuration written.</div>
        <div className="font-mono text-[11px]">{complete.data.config_path}</div>
        {complete.data.initial_sync && (
          <div className="font-mono text-[11px]">
            Initial sync: upserted {complete.data.initial_sync.upserted}, archived{" "}
            {complete.data.initial_sync.archived}
          </div>
        )}
        <p>
          The backend is restarting. This page will reload in a few seconds — if it doesn't, refresh
          manually.
        </p>
        <ReloadTimer />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 rounded border border-zinc-200 bg-white p-6 text-sm dark:border-zinc-800 dark:bg-zinc-950">
      <section className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-zinc-500">
          Provider
        </div>
        <div>
          {provider.display_name}{" "}
          <span className="font-mono text-[10px] text-zinc-500">({provider.type})</span>
        </div>
      </section>
      <section className="rounded border border-zinc-200 p-3 dark:border-zinc-800">
        <div className="mb-1 font-mono text-[11px] uppercase tracking-wider text-zinc-500">LLM</div>
        <div>{llm.skip ? "Disabled" : `${llm.deployment} @ ${llm.endpoint}`}</div>
      </section>

      {complete.error && (
        <div className="rounded border border-rose-300 bg-rose-50 p-3 text-xs text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">
          {complete.error.message}
        </div>
      )}

      <div className="flex justify-between">
        <button
          type="button"
          onClick={onBack}
          className="text-xs text-zinc-500 hover:text-zinc-700"
        >
          ← Back
        </button>
        <button
          type="button"
          disabled={complete.isPending}
          onClick={submit}
          className="rounded bg-accent px-4 py-1.5 text-sm font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
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
  return <div className="font-mono text-[11px] text-zinc-500">Reloading in ~6 seconds…</div>;
}

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  // Rendered above its TextInput sibling rather than wrapping it; a plain
  // span is sufficient since each field has a single labeled control.
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
      {children}
      {required && <span className="ml-1 text-rose-500">*</span>}
    </span>
  );
}

function HelpText({ children }: { children: React.ReactNode }) {
  return <span className="text-xs text-zinc-500">{children}</span>;
}

function TextInput({
  value,
  onChange,
  type = "text",
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  type?: string;
  placeholder?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="w-full rounded border border-zinc-200 bg-white px-2 py-1 text-sm focus:border-accent focus:outline-none dark:border-zinc-800 dark:bg-zinc-950"
    />
  );
}
