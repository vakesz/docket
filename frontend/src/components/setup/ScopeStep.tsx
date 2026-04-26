/**
 * Scope filter step — web equivalent of `_step_provider_scope`.
 *
 * Spec-driven: we render one input per `SetupProviderTypeDTO.scope_axes`,
 * with a datalist sourced from the axis's `discovery_stage` when present.
 * Providers that declare zero axes (e.g. github_stub) collapse to just the
 * assignee field — same UX as the CLI's "this provider doesn't surface
 * scope axes" path.
 *
 * Match-count preview uses `/setup/probe-scope`, mirroring the CLI's
 * "→ N item(s) match this scope" line. Failure renders "could not count"
 * (same UX as the CLI) so the user can still proceed.
 */
import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import { useProbeScope, useProviderDiscover } from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { cn } from "~/lib/cn";
import {
  metaLabelClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";
import type { ProviderDraft } from "./types";
import { scopeToWire } from "./types";

type ScopeAxisDTO = DTO["SetupProviderScopeAxisDTO"];
type ProviderTypeDTO = DTO["SetupProviderTypeDTO"];

interface Props {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  spec: ProviderTypeDTO | null;
  onBack: () => void;
  onNext: () => void;
}

export function ScopeStep({ draft, setDraft, spec, onBack, onNext }: Props) {
  const axes = spec?.scope_axes ?? [];
  const hasAxes = axes.length > 0;

  return (
    <div className={setupCardClass}>
      <p>
        Scope filters limit which items get cached locally. Leave any axis blank to include
        everything.
      </p>

      {hasAxes &&
        axes.map((axis) => (
          <AxisField
            key={axis.key}
            axis={axis}
            providerType={draft.type}
            config={draft.config}
            value={draft.scope.axes[axis.key] ?? ""}
            onChange={(v) =>
              setDraft((d) => ({
                ...d,
                scope: { ...d.scope, axes: { ...d.scope.axes, [axis.key]: v } },
              }))
            }
          />
        ))}

      <AssigneeField draft={draft} setDraft={setDraft} />

      <ScopeProbe draft={draft} />

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

function AxisField({
  axis,
  providerType,
  config,
  value,
  onChange,
}: {
  axis: ScopeAxisDTO;
  providerType: string;
  config: Record<string, string>;
  value: string;
  onChange: (v: string) => void;
}) {
  const stage = axis.discovery_stage;
  const discover = useProviderDiscover(providerType);
  const [options, setOptions] = useState<string[]>([]);
  const [error, setError] = useState("");

  // Re-run discovery whenever the provider config changes — payload keys
  // are provider-defined so we just forward the whole config. The stringified
  // form keys the effect (mutate is stable; config object identity isn't).
  const configKey = JSON.stringify(config);

  // biome-ignore lint/correctness/useExhaustiveDependencies: configKey covers config; mutate is stable.
  useEffect(() => {
    if (!stage) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage, payload: config },
      {
        onSuccess: (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setOptions([]);
            setError(res.error ?? "");
            return;
          }
          setOptions((res.items ?? []).map((it) => it.value));
          setError("");
        },
        onError: () => {
          if (!cancelled) setOptions([]);
        },
      },
    );
    return () => {
      cancelled = true;
    };
  }, [stage, configKey]);

  const id = useMemo(
    () => `axis-${axis.key}-${Math.random().toString(36).slice(2, 7)}`,
    [axis.key],
  );

  return (
    <section className="flex flex-col gap-2">
      <Label>{axis.label}</Label>
      <input
        list={stage ? id : undefined}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="any (leave blank to include everything)"
        className={cn(
          "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg",
          "focus:border-accent focus:outline-none",
        )}
      />
      {stage && (
        <datalist id={id}>
          {options.map((opt) => (
            <option key={opt} value={opt} />
          ))}
        </datalist>
      )}
      {error && <HelpText>Discovery failed ({error}); enter manually.</HelpText>}
    </section>
  );
}

function AssigneeField({
  draft,
  setDraft,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  const set = (assignee: string) => setDraft((d) => ({ ...d, scope: { ...d.scope, assignee } }));
  const presets = ["", "@me"];

  return (
    <section className="flex flex-col gap-2">
      <Label>Assignee</Label>
      <div className="flex flex-wrap gap-2">
        {presets.map((p) => (
          <button
            type="button"
            key={p || "any"}
            onClick={() => set(p)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              draft.scope.assignee === p
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-fg-muted hover:bg-surface-alt",
            )}
          >
            {p === "" ? "any" : p}
          </button>
        ))}
      </div>
      <TextInput
        value={draft.scope.assignee}
        onChange={set}
        placeholder="email or @me — blank for any"
      />
      <HelpText>Defaults to "any" so you see everything in the cache.</HelpText>
    </section>
  );
}

function ScopeProbe({ draft }: { draft: ProviderDraft }) {
  const probe = useProbeScope();
  const wire = useMemo(() => scopeToWire(draft.scope), [draft.scope]);
  const stableKey = `${draft.type}|${JSON.stringify(draft.config)}|${JSON.stringify(wire)}`;
  const [lastResult, setLastResult] = useState<DTO["ProbeScopeDTO"] | null>(null);
  const [lastKey, setLastKey] = useState<string>("");

  // Re-probe is manual: the CLI version asks "Use this scope?" and reruns the
  // count on each round-trip. We expose a button to keep mutations off the
  // hot path of every keystroke.
  const probeNow = () => {
    probe.mutate(
      { type: draft.type, config: { ...draft.config }, scope: wire },
      {
        onSuccess: (res) => {
          setLastResult(res);
          setLastKey(stableKey);
        },
      },
    );
  };

  const fresh = lastKey === stableKey;

  return (
    <section className="flex items-center gap-2 border-t border-border pt-3">
      <button
        type="button"
        onClick={probeNow}
        disabled={probe.isPending}
        className={xsBorderButtonClass}
      >
        {probe.isPending ? "Counting…" : "Preview match count"}
      </button>
      {fresh && lastResult && lastResult.count !== null && (
        <span className={cn(metaLabelClass, "text-xs normal-case tracking-normal text-success-fg")}>
          → {lastResult.count} item(s) match this scope
        </span>
      )}
      {fresh && lastResult && lastResult.count === null && (
        <span className="text-xs text-warning-fg">
          Could not count — proceeding with this scope is fine.
        </span>
      )}
    </section>
  );
}
