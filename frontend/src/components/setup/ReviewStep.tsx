/**
 * Review + submit step.
 *
 * Collects every other step's draft into one `SetupCompleteRequest`, fires
 * `/setup/complete`, and renders the post-completion "restart docket serve"
 * panel on success. The CLI wizard exits and the user re-runs `docket serve`;
 * we mirror that — Phase 5 replaces the auto-reload with explicit copy.
 */
import type { DTO } from "~/api/client";
import { useCompleteSetup } from "~/api/hooks";
import { Notice } from "~/components/common/Notice";
import { cn } from "~/lib/cn";
import { metaLabelClass, primaryButtonClass, setupCardClass } from "~/lib/formClasses";
import type { LlmDraft, ProviderDraft, SettingsDraft } from "./types";
import { viewToWire } from "./types";

function parseOptionalFloat(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

interface Props {
  provider: ProviderDraft;
  spec: DTO["SetupProviderTypeDTO"] | null;
  llm: LlmDraft;
  settings: SettingsDraft;
  onBack: () => void;
  onCompleted: (result: DTO["SetupCompleteDTO"]) => void;
}

export function ReviewStep({ provider, spec, llm, settings, onBack, onCompleted }: Props) {
  const complete = useCompleteSetup();

  const submit = () => {
    const body: DTO["SetupCompleteRequest"] = {
      providers: {
        [provider.key]: {
          type: provider.type,
          display_name: provider.display_name || provider.type,
          config: { ...provider.config },
          view: viewToWire(provider.view),
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
      http_bind: settings.http_bind,
      http_port: settings.http_port,
      http_token: "",
      telemetry_enabled: settings.telemetry_enabled,
      telemetry_level: settings.telemetry_level,
      run_initial_sync: settings.run_initial_sync,
    };
    complete.mutate(body, {
      onSuccess: (res) => onCompleted(res),
    });
  };

  const viewChips = viewChipsFor(provider, spec);

  return (
    <div className={setupCardClass}>
      <section className="rounded-xl border border-border p-3">
        <div className={cn("mb-1", metaLabelClass)}>Provider</div>
        <div>
          {provider.display_name || provider.type}{" "}
          <span className="font-mono text-[10px] text-fg-muted">
            ({provider.type} · key {provider.key})
          </span>
        </div>
        {viewChips.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1">
            {viewChips.map((chip) => (
              <span
                key={chip}
                className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] text-fg-muted"
              >
                {chip}
              </span>
            ))}
          </div>
        )}
      </section>
      <section className="rounded-xl border border-border p-3">
        <div className={cn("mb-1", metaLabelClass)}>LLM</div>
        <div>{llm.skip ? "Disabled" : `${llm.deployment} @ ${llm.endpoint}`}</div>
      </section>
      <section className="rounded-xl border border-border p-3">
        <div className={cn("mb-1", metaLabelClass)}>Host</div>
        <div className="font-mono text-[11px] text-fg-muted">
          {settings.http_bind}:{settings.http_port} · telemetry{" "}
          {settings.telemetry_enabled ? settings.telemetry_level : "off"} ·{" "}
          {settings.run_initial_sync ? "initial sync on" : "initial sync off"}
        </div>
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

function viewChipsFor(provider: ProviderDraft, spec: DTO["SetupProviderTypeDTO"] | null): string[] {
  const chips: string[] = [];
  for (const axis of spec?.scope_axes ?? []) {
    const values = provider.view.axes[axis.key] ?? [];
    if (values.length > 0) chips.push(`${axis.label}: ${values.join(", ")}`);
  }
  if (provider.view.assignees.length > 0) {
    chips.push(`assignee: ${provider.view.assignees.join(", ")}`);
  }
  chips.push(`state: ${provider.view.state_bucket}`);
  return chips;
}
