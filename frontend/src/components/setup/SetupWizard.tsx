/**
 * First-time setup wizard — full parity with `docket setup` over HTTP.
 *
 * Steps mirror `STEP_NAMES` in `src/docket/config/setup_wizard.py`, with two
 * collapses for the web's vertical room:
 *   welcome → cli → provider (= pick + connection + label) → view →
 *   llm → settings (= telemetry + http) → review → done
 *
 * Discovery and label suggestion hit dedicated `/setup/*` endpoints so the
 * SPA needs zero provider knowledge.
 */
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProviderTypes, useSetupStatus } from "~/api/hooks";
import { cn } from "~/lib/cn";

import { CliStep } from "./CliStep";
import { DefaultViewStep } from "./DefaultViewStep";
import { DoneStep } from "./DoneStep";
import { LlmStep } from "./LlmStep";
import { ProviderStep } from "./ProviderStep";
import { ReviewStep } from "./ReviewStep";
import { SettingsStep } from "./SettingsStep";
import type { LlmDraft, ProviderDraft, SettingsDraft, Step } from "./types";
import { defaultPricesFor, emptyView } from "./types";
import { WelcomeStep } from "./WelcomeStep";

const STEP_LABELS: { id: Step; label: string }[] = [
  { id: "welcome", label: "Welcome" },
  { id: "cli", label: "CLI" },
  { id: "provider", label: "Provider" },
  { id: "view", label: "Default view" },
  { id: "llm", label: "LLM" },
  { id: "settings", label: "Settings" },
  { id: "review", label: "Review" },
];

export function SetupWizard() {
  const status = useSetupStatus();
  const types = useProviderTypes();
  const [step, setStep] = useState<Step>("welcome");
  const [done, setDone] = useState<DTO["SetupCompleteDTO"] | null>(null);

  const [provider, setProvider] = useState<ProviderDraft>({
    key: "default",
    type: "",
    display_name: "",
    display_name_dirty: false,
    config: {},
    view: emptyView(),
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

  const [settings, setSettings] = useState<SettingsDraft>({
    http_bind: "0.0.0.0",
    http_port: 8765,
    telemetry_enabled: true,
    telemetry_level: "DEBUG",
    run_initial_sync: true,
  });

  const activeSpec = (types.data ?? []).find((t) => t.id === provider.type) ?? null;

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

      {!done && (
        <nav className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-6 py-2">
          {STEP_LABELS.map((s, idx) => (
            <span key={s.id} className="flex items-center gap-3">
              <StepDot active={step === s.id} done={isStepBefore(step, s.id)} label={s.label} />
              {idx < STEP_LABELS.length - 1 && <Arrow />}
            </span>
          ))}
        </nav>
      )}

      <main className="mx-auto w-full max-w-2xl flex-1 p-6">
        {done ? (
          <DoneStep result={done} />
        ) : (
          <>
            {step === "welcome" && <WelcomeStep onNext={() => setStep("cli")} />}
            {step === "cli" && (
              <CliStep onBack={() => setStep("welcome")} onNext={() => setStep("provider")} />
            )}
            {step === "provider" && (
              <ProviderStep
                types={types.data ?? []}
                loading={types.isPending}
                draft={provider}
                setDraft={setProvider}
                onBack={() => setStep("cli")}
                onNext={() => setStep("view")}
              />
            )}
            {step === "view" && (
              <DefaultViewStep
                draft={provider}
                setDraft={setProvider}
                spec={activeSpec}
                onBack={() => setStep("provider")}
                onNext={() => setStep("llm")}
              />
            )}
            {step === "llm" && (
              <LlmStep
                draft={llm}
                setDraft={setLlm}
                onBack={() => setStep("view")}
                onNext={() => setStep("settings")}
              />
            )}
            {step === "settings" && (
              <SettingsStep
                draft={settings}
                setDraft={setSettings}
                onBack={() => setStep("llm")}
                onNext={() => setStep("review")}
              />
            )}
            {step === "review" && (
              <ReviewStep
                provider={provider}
                spec={activeSpec}
                llm={llm}
                settings={settings}
                onBack={() => setStep("settings")}
                onCompleted={(res) => setDone(res)}
              />
            )}
          </>
        )}
      </main>
    </div>
  );
}

function isStepBefore(current: Step, target: Step): boolean {
  const order: Step[] = STEP_LABELS.map((s) => s.id);
  const ci = order.indexOf(current);
  const ti = order.indexOf(target);
  return ti >= 0 && ci > ti;
}

function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) {
  return (
    <span
      className={cn(
        "font-mono text-[11px] uppercase tracking-wider",
        active ? "text-accent" : done ? "text-fg" : "text-fg-muted",
      )}
    >
      {label}
    </span>
  );
}

function Arrow() {
  return <span className="font-mono text-[10px] text-fg-faint">→</span>;
}
