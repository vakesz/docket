"use client";

import { Field, Label, Switch } from "@headlessui/react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  primaryButtonClass,
  secondaryButtonClass,
  switchThumbClass,
  switchTrackClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type GuardrailKind = "noop" | "pattern" | "llm-judge" | "composite";

const KIND_OPTIONS: { value: GuardrailKind; label: string; hint: string }[] = [
  {
    value: "composite",
    label: "Composite (recommended)",
    hint: "Pattern check first, escalates to the model only on harder cases.",
  },
  {
    value: "llm-judge",
    label: "LLM judge only",
    hint: "Every check goes through the configured guardrail model. Most precise, costs the most.",
  },
  {
    value: "pattern",
    label: "Pattern only",
    hint: "Local regex screen, no model calls. Free but coarse.",
  },
  {
    value: "noop",
    label: "Off (no checks)",
    hint: "Disables the layer without flipping the enabled toggle.",
  },
];

/**
 * Project-scoped chat guardrail knobs.
 *
 * Six keys live here:
 *   - `guardrail.enabled`               — master kill switch.
 *   - `guardrail.kind`                  — strategy (pattern / llm-judge / composite / noop).
 *   - `guardrail.block-on-injection`    — refuse vs flag tool results that look like injection.
 *   - `guardrail.block-off-topic`       — refuse vs flag user messages outside scope.
 *   - `guardrail.scope-check-enabled`   — input scope classifier (LLM-judge round-trip).
 *   - `guardrail.output-check-enabled`  — output safety classifier (extra round-trip).
 *
 * The enabled toggle is gated behind the existence of at least one
 * `role: "guardrail"` LLM provider — pattern-only mode still benefits
 * from a model fallback in composite, and the layer is meant to be a
 * defense-in-depth feature, not a regex toy.
 */
export function GuardrailPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectId });
  const providers = trpc.llmProviders.list.useQuery();

  const [enabled, setEnabled] = useState(true);
  const [kind, setKind] = useState<GuardrailKind>("composite");
  const [blockOnInjection, setBlockOnInjection] = useState(true);
  const [blockOffTopic, setBlockOffTopic] = useState(true);
  const [scopeCheckEnabled, setScopeCheckEnabled] = useState(true);
  const [outputCheckEnabled, setOutputCheckEnabled] = useState(false);

  // Seed once per project. Parallel mutateAsync calls below would
  // otherwise let an intermediate refetch (after one mutation lands but
  // before the others) clobber whatever the user is still editing.
  // Switching projects in-place must re-seed from the new project's
  // settings instead of keeping the previous project's state.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededForRef.current === projectId) return;
    if (!projectSettings.data) return;
    const lookup = new Map(projectSettings.data.map((row) => [row.key, row.value]));
    const e = lookup.get("guardrail.enabled");
    const k = lookup.get("guardrail.kind");
    const boi = lookup.get("guardrail.block-on-injection");
    const bot = lookup.get("guardrail.block-off-topic");
    const sce = lookup.get("guardrail.scope-check-enabled");
    const oce = lookup.get("guardrail.output-check-enabled");
    setEnabled(typeof e === "boolean" ? e : true);
    setKind(
      k === "noop" || k === "pattern" || k === "llm-judge" || k === "composite" ? k : "composite",
    );
    setBlockOnInjection(typeof boi === "boolean" ? boi : true);
    setBlockOffTopic(typeof bot === "boolean" ? bot : true);
    setScopeCheckEnabled(typeof sce === "boolean" ? sce : true);
    setOutputCheckEnabled(typeof oce === "boolean" ? oce : false);
    seededForRef.current = projectId;
  }, [projectSettings.data, projectId]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectId });
    },
  });

  const guardrailProviders =
    providers.data?.filter((p) => p.role === "guardrail" && p.enabled) ?? [];
  const hasGuardrailProvider = guardrailProviders.length > 0;
  const defaultGuardrailProvider = guardrailProviders.find((p) => p.isDefault) ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Defense in depth: never persist enabled=true without a guardrail row.
    const safeEnabled = hasGuardrailProvider ? enabled : false;
    await Promise.all([
      save.mutateAsync({ projectId, key: "guardrail.enabled", value: safeEnabled }),
      save.mutateAsync({ projectId, key: "guardrail.kind", value: kind }),
      save.mutateAsync({
        projectId,
        key: "guardrail.block-on-injection",
        value: blockOnInjection,
      }),
      save.mutateAsync({ projectId, key: "guardrail.block-off-topic", value: blockOffTopic }),
      save.mutateAsync({
        projectId,
        key: "guardrail.scope-check-enabled",
        value: scopeCheckEnabled,
      }),
      save.mutateAsync({
        projectId,
        key: "guardrail.output-check-enabled",
        value: outputCheckEnabled,
      }),
    ]);
  };

  if (projectSettings.isPending || providers.isPending) {
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }

  const knobsDisabled = !enabled || !hasGuardrailProvider || save.isPending;
  // Sub-knobs that only matter when an LLM-judge is involved — pattern-only
  // and noop ignore them entirely.
  const judgeOnly = kind === "llm-judge" || kind === "composite";
  const subKnobsDisabled = knobsDisabled || !judgeOnly;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {!hasGuardrailProvider ? (
        <aside
          role="note"
          className="rounded-2xl border border-warning/40 bg-warning-bg/40 p-4 text-xs text-warning-fg"
        >
          <p className="mb-1 font-medium">No guardrail model configured</p>
          <p>
            Chat guardrails need a dedicated LLM provider (role:{" "}
            <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">guardrail</code>)
            before they can be enabled.{" "}
            <Link
              href="/settings?section=llm-providers"
              className="underline underline-offset-2 hover:text-fg"
            >
              Add one in Deployment &rarr; LLM providers
            </Link>
            , then come back to flip this on.
          </p>
        </aside>
      ) : null}

      <div className="flex flex-col gap-2">
        <Field className="flex items-center gap-2 text-sm text-fg">
          <Switch
            checked={hasGuardrailProvider && enabled}
            disabled={!hasGuardrailProvider || save.isPending}
            onChange={setEnabled}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>Enable chat guardrails</Label>
        </Field>
        <p className="text-xs text-fg-muted">
          When on, every user message, tool result, and final assistant reply runs through the
          guardrail layer. Calls go to the project&rsquo;s configured guardrail model
          {defaultGuardrailProvider ? (
            <>
              {" "}
              (currently{" "}
              <span className="font-medium text-fg">{defaultGuardrailProvider.label}</span>)
            </>
          ) : null}{" "}
          — never an external endpoint.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-t border-border pt-6">
        <label htmlFor="guardrail-kind" className="text-sm font-medium text-fg">
          Strategy
        </label>
        <p className="text-xs text-fg-muted">
          Composite is the default — pattern is fast and free, and the model only runs when the
          regex layer is uncertain.
        </p>
        <SelectField
          id="guardrail-kind"
          value={kind}
          disabled={knobsDisabled}
          onChange={(e) => setKind(e.target.value as GuardrailKind)}
          wrapperClassName="max-w-md"
        >
          {KIND_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </SelectField>
        <p className="text-[11px] text-fg-faint">
          {KIND_OPTIONS.find((opt) => opt.value === kind)?.hint}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-fg">Behavior</h3>

        <Field className="flex items-start gap-2 text-sm text-fg">
          <Switch
            checked={blockOnInjection}
            disabled={knobsDisabled}
            onChange={setBlockOnInjection}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <div className="flex flex-col gap-0.5">
            <Label>Block prompt-injection attempts</Label>
            <p className="text-xs text-fg-muted">
              Tool results flagged as injection are replaced with a refusal stub before re-entering
              the prompt. Off keeps the original payload and only annotates the row.
            </p>
          </div>
        </Field>

        <Field className="flex items-start gap-2 text-sm text-fg">
          <Switch
            checked={blockOffTopic}
            disabled={knobsDisabled}
            onChange={setBlockOffTopic}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <div className="flex flex-col gap-0.5">
            <Label>Block off-topic chat</Label>
            <p className="text-xs text-fg-muted">
              User messages classified as outside the software / work-item scope (cooking, shopping,
              medical advice) are refused before the agent sees them. Off downgrades to a banner.
            </p>
          </div>
        </Field>
      </div>

      <div className="flex flex-col gap-3 border-t border-border pt-6">
        <h3 className="text-sm font-medium text-fg">LLM-judge round-trips</h3>
        <p className="text-xs text-fg-muted">
          These add a one-token classifier call on the guardrail model. They only run when the
          strategy is <em>composite</em> or <em>llm-judge</em>; pattern-only and off ignore them.
        </p>

        <Field className="flex items-start gap-2 text-sm text-fg">
          <Switch
            checked={scopeCheckEnabled}
            disabled={subKnobsDisabled}
            onChange={setScopeCheckEnabled}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <div className="flex flex-col gap-0.5">
            <Label>Scope-check user input</Label>
            <p className="text-xs text-fg-muted">
              Classify each user message as on-topic / off-topic. Turn off if your projects extend
              beyond software work-items.
            </p>
          </div>
        </Field>

        <Field className="flex items-start gap-2 text-sm text-fg">
          <Switch
            checked={outputCheckEnabled}
            disabled={subKnobsDisabled}
            onChange={setOutputCheckEnabled}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <div className="flex flex-col gap-0.5">
            <Label>Output safety check</Label>
            <p className="text-xs text-fg-muted">
              Run the assistant&rsquo;s final reply through a harmful-content classifier. Output is
              never blocked mid-stream — flagged messages get a banner. Costs one extra round-trip
              per turn.
            </p>
          </div>
        </Field>
      </div>

      <div className="flex items-center gap-3 border-t border-border pt-6">
        <button
          type="submit"
          disabled={save.isPending || !hasGuardrailProvider}
          className={primaryButtonClass}
        >
          {save.isPending ? "Saving…" : "Save guardrail settings"}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          className={secondaryButtonClass}
          onClick={() => {
            setEnabled(true);
            setKind("composite");
            setBlockOnInjection(true);
            setBlockOffTopic(true);
            setScopeCheckEnabled(true);
            setOutputCheckEnabled(false);
          }}
        >
          Reset to defaults
        </button>
        {save.error ? <span className="text-xs text-danger-fg">{save.error.message}</span> : null}
        {save.isSuccess ? <span className="text-xs text-fg-muted">Saved.</span> : null}
      </div>
    </form>
  );
}
