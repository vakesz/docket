/**
 * Default-view step — web equivalent of `_step_provider_view`.
 *
 * Spec-driven: we render one input per `SetupProviderTypeDTO.scope_axes`,
 * with a datalist sourced from the axis's `discovery_stage` when present.
 * Providers that declare zero axes (e.g. github_stub) collapse to just the
 * assignee field.
 *
 * Each axis input takes a comma-separated list — multi-select is first-class
 * on the new visual filter, so "Team A, Team B" persists as a two-element
 * list. Empty input means the axis is unconstrained.
 */
import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import { useProviderDiscover } from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { cn } from "~/lib/cn";
import { primaryButtonClass, setupCardClass } from "~/lib/formClasses";
import type { ProviderDraft } from "./types";

type ScopeAxisDTO = DTO["SetupProviderScopeAxisDTO"];
type ProviderTypeDTO = DTO["SetupProviderTypeDTO"];

interface Props {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  spec: ProviderTypeDTO | null;
  onBack: () => void;
  onNext: () => void;
}

const STATE_BUCKETS: Array<{ value: DTO["SavedViewDTO"]["state_bucket"]; label: string }> = [
  { value: "open", label: "Open (default)" },
  { value: "closed", label: "Closed" },
  { value: "all", label: "All" },
];

export function DefaultViewStep({ draft, setDraft, spec, onBack, onNext }: Props) {
  const axes = spec?.scope_axes ?? [];
  const hasAxes = axes.length > 0;

  return (
    <div className={setupCardClass}>
      <p>
        This is the saved <strong>default view</strong> for the new provider — the named filter the
        chip bar starts from. Sync still pulls the full project; views just narrow what's visible.
        Leave any axis blank to keep it unconstrained.
      </p>

      {hasAxes &&
        axes.map((axis) => (
          <AxisField
            key={axis.key}
            axis={axis}
            providerType={draft.type}
            config={draft.config}
            values={draft.view.axes[axis.key] ?? []}
            onChange={(values) =>
              setDraft((d) => ({
                ...d,
                view: { ...d.view, axes: { ...d.view.axes, [axis.key]: values } },
              }))
            }
          />
        ))}

      <AssigneeField draft={draft} setDraft={setDraft} />

      <StateBucketField draft={draft} setDraft={setDraft} />

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
  values,
  onChange,
}: {
  axis: ScopeAxisDTO;
  providerType: string;
  config: Record<string, string>;
  values: string[];
  onChange: (values: string[]) => void;
}) {
  const stage = axis.discovery_stage;
  const discover = useProviderDiscover(providerType);
  const [options, setOptions] = useState<string[]>([]);
  const [error, setError] = useState("");

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
  const display = values.join(", ");

  return (
    <section className="flex flex-col gap-2">
      <Label>{axis.label}</Label>
      <input
        list={stage ? id : undefined}
        type="text"
        value={display}
        onChange={(e) => {
          const parts = e.target.value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          onChange(parts);
        }}
        placeholder="comma-separated; blank = any"
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
  const single = draft.view.assignees[0] ?? "";
  const set = (assignee: string) =>
    setDraft((d) => ({
      ...d,
      view: { ...d.view, assignees: assignee ? [assignee] : [] },
    }));
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
              single === p
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-fg-muted hover:bg-surface-alt",
            )}
          >
            {p === "" ? "any" : p}
          </button>
        ))}
      </div>
      <TextInput value={single} onChange={set} placeholder="email or @me — blank for any" />
      <HelpText>Defaults to "any" so you see everything in the cache.</HelpText>
    </section>
  );
}

function StateBucketField({
  draft,
  setDraft,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  const set = (state_bucket: DTO["SavedViewDTO"]["state_bucket"]) =>
    setDraft((d) => ({ ...d, view: { ...d.view, state_bucket } }));

  return (
    <section className="flex flex-col gap-2">
      <Label>Default state bucket</Label>
      <div className="flex flex-wrap gap-2">
        {STATE_BUCKETS.map((opt) => (
          <button
            type="button"
            key={opt.value}
            onClick={() => set(opt.value)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs",
              draft.view.state_bucket === opt.value
                ? "border-accent bg-accent/10 text-accent"
                : "border-border text-fg-muted hover:bg-surface-alt",
            )}
          >
            {opt.label}
          </button>
        ))}
      </div>
      <HelpText>"Open" hides done items by default; switch with the chip bar later.</HelpText>
    </section>
  );
}
