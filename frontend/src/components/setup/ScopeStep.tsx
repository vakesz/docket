/**
 * Scope filter step — web equivalent of `_step_provider_scope`.
 *
 *  - azure_devops : team / area_path / iteration_path / assignee
 *  - github       : assignee only (team/area/iteration don't apply)
 *  - other        : skipped — empty scope sent to backend
 *
 * Match-count preview uses `/setup/probe-scope`, mirroring the CLI's
 * "→ N item(s) match this scope" line. Failure renders "could not count"
 * (same UX as the CLI) so the user can still proceed.
 */
import { useEffect, useMemo, useState } from "react";
import type { DTO } from "~/api/client";
import { useAdoDiscover, useProbeScope } from "~/api/hooks";
import { HelpText, TextInput } from "~/components/common/FormInputs";
import { Label } from "~/components/common/Label";
import { cn } from "~/lib/cn";
import {
  metaLabelClass,
  primaryButtonClass,
  setupCardClass,
  xsBorderButtonClass,
} from "~/lib/formClasses";
import type { ProviderDraft, ScopeDraft } from "./types";
import { scopeToWire } from "./types";

interface Props {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
  onBack: () => void;
  onNext: () => void;
}

export function ScopeStep({ draft, setDraft, onBack, onNext }: Props) {
  const isAdo = draft.type === "azure_devops";
  const isGithub = draft.type === "github" || draft.type === "github_stub";

  if (!isAdo && !isGithub) {
    // Third-party providers don't surface scope axes via the wizard.
    return (
      <div className={setupCardClass}>
        <p>This provider type doesn't expose scope filters in the wizard.</p>
        <p className="text-fg-muted">
          You can still configure scopes later from the in-app settings page or by editing{" "}
          <code className="rounded bg-surface-alt px-1 text-fg">config.toml</code> directly.
        </p>
        <div className="flex justify-between">
          <button type="button" onClick={onBack} className="text-xs text-fg-muted hover:text-fg">
            ← Back
          </button>
          <button type="button" onClick={onNext} className={primaryButtonClass}>
            Skip
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={setupCardClass}>
      <p>
        Scope filters limit which items get cached locally. Leave any axis blank to include
        everything.
      </p>

      {isAdo && <AdoScopeFields draft={draft} setDraft={setDraft} />}

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

function AdoScopeFields({
  draft,
  setDraft,
}: {
  draft: ProviderDraft;
  setDraft: React.Dispatch<React.SetStateAction<ProviderDraft>>;
}) {
  const setScope = (patch: Partial<ScopeDraft>) =>
    setDraft((d) => ({ ...d, scope: { ...d.scope, ...patch } }));

  const org = draft.config.organization ?? "";
  const project = draft.config.project ?? "";
  const enabled = !!org && !!project;

  return (
    <>
      <AdoAxisField
        label="Team"
        stage="teams"
        org={org}
        project={project}
        enabled={enabled}
        value={draft.scope.team}
        onChange={(v) => setScope({ team: v })}
      />
      <AdoAxisField
        label="Area path"
        stage="areas"
        org={org}
        project={project}
        enabled={enabled}
        value={draft.scope.area_path}
        onChange={(v) => setScope({ area_path: v })}
      />
      <AdoAxisField
        label="Iteration path"
        stage="iterations"
        org={org}
        project={project}
        enabled={enabled}
        value={draft.scope.iteration_path}
        onChange={(v) => setScope({ iteration_path: v })}
      />
    </>
  );
}

function AdoAxisField({
  label,
  stage,
  org,
  project,
  enabled,
  value,
  onChange,
}: {
  label: string;
  stage: DTO["AdoDiscoverRequest"]["stage"];
  org: string;
  project: string;
  enabled: boolean;
  value: string;
  onChange: (v: string) => void;
}) {
  const discover = useAdoDiscover();
  const [options, setOptions] = useState<string[]>([]);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!enabled) {
      setOptions([]);
      return;
    }
    let cancelled = false;
    discover.mutate(
      { stage, org, project },
      {
        onSuccess: (res) => {
          if (cancelled) return;
          if (!res.ok) {
            setOptions([]);
            setError(res.error ?? "");
            return;
          }
          setOptions(res.items ?? []);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, org, project, stage]);

  const id = useMemo(() => `axis-${stage}-${Math.random().toString(36).slice(2, 7)}`, [stage]);

  return (
    <section className="flex flex-col gap-2">
      <Label>{label}</Label>
      <input
        list={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="any (leave blank to include everything)"
        className={cn(
          "w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-fg",
          "focus:border-accent focus:outline-none",
        )}
      />
      <datalist id={id}>
        {options.map((opt) => (
          <option key={opt} value={opt} />
        ))}
      </datalist>
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
  const wire = useMemo(() => scopeToWire(draft.scope, draft.type), [draft.scope, draft.type]);
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
