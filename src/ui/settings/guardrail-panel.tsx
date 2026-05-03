"use client";

import Link from "next/link";
import { useId } from "react";
import { GUARDRAIL_KINDS, type GuardrailKind } from "@/agent/guardrail/types";
import { useProjectSettingsForm } from "@/lib/settings-client";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription, AlertTitle } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Switch } from "@/ui/primitives/switch";

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
export function GuardrailPanel({ projectSlug }: { projectSlug: string }) {
  const providers = trpc.llmProviders.list.useQuery();
  const { values, setValues, isLoading, save, saveMany } = useProjectSettingsForm({
    projectSlug,
    initial: {
      enabled: true,
      kind: "composite",
      blockOnInjection: true,
      blockOffTopic: true,
      scopeCheckEnabled: true,
      outputCheckEnabled: false,
    } satisfies {
      enabled: boolean;
      kind: GuardrailKind;
      blockOnInjection: boolean;
      blockOffTopic: boolean;
      scopeCheckEnabled: boolean;
      outputCheckEnabled: boolean;
    },
    seed: (view) => {
      const k = view.raw("guardrail.kind");
      return {
        enabled: view.bool("guardrail.enabled", true),
        kind: GUARDRAIL_KINDS.find((g) => g === k) ?? "composite",
        blockOnInjection: view.bool("guardrail.block-on-injection", true),
        blockOffTopic: view.bool("guardrail.block-off-topic", true),
        scopeCheckEnabled: view.bool("guardrail.scope-check-enabled", true),
        outputCheckEnabled: view.bool("guardrail.output-check-enabled", false),
      };
    },
  });
  const { enabled, kind, blockOnInjection, blockOffTopic, scopeCheckEnabled, outputCheckEnabled } =
    values;

  const enabledId = useId();
  const kindId = useId();
  const injectionId = useId();
  const offTopicId = useId();
  const scopeId = useId();
  const outputId = useId();

  const guardrailProviders =
    providers.data?.filter((p) => p.role === "guardrail" && p.enabled) ?? [];
  const hasGuardrailProvider = guardrailProviders.length > 0;
  const defaultGuardrailProvider = guardrailProviders.find((p) => p.isDefault) ?? null;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    // Defense in depth: never persist enabled=true without a guardrail row.
    const safeEnabled = hasGuardrailProvider ? enabled : false;
    await saveMany([
      { key: "guardrail.enabled", value: safeEnabled },
      { key: "guardrail.kind", value: kind },
      { key: "guardrail.block-on-injection", value: blockOnInjection },
      { key: "guardrail.block-off-topic", value: blockOffTopic },
      { key: "guardrail.scope-check-enabled", value: scopeCheckEnabled },
      { key: "guardrail.output-check-enabled", value: outputCheckEnabled },
    ]);
  };

  if (isLoading || providers.isPending) {
    return <p className="text-muted-foreground/70 text-sm">Loading…</p>;
  }

  const knobsDisabled = !enabled || !hasGuardrailProvider || save.isPending;
  // Sub-knobs that only matter when an LLM-judge is involved — pattern-only
  // and noop ignore them entirely.
  const judgeOnly = kind === "llm-judge" || kind === "composite";
  const subKnobsDisabled = knobsDisabled || !judgeOnly;

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      {!hasGuardrailProvider ? (
        <Alert variant="warning">
          <AlertTitle>No guardrail model configured</AlertTitle>
          <AlertDescription>
            Chat guardrails need a dedicated LLM provider (role:{" "}
            <code className="rounded bg-card px-1 py-0.5 font-mono text-foreground">guardrail</code>
            ) before they can be enabled.{" "}
            <Link
              href="/settings?section=llm-providers"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Add one in Deployment &rarr; LLM providers
            </Link>
            , then come back to flip this on.
          </AlertDescription>
        </Alert>
      ) : null}

      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={enabledId}
            checked={hasGuardrailProvider && enabled}
            disabled={!hasGuardrailProvider || save.isPending}
            onCheckedChange={(next) => setValues((prev) => ({ ...prev, enabled: next }))}
          />
          <Label htmlFor={enabledId}>Enable chat guardrails</Label>
        </div>
        <p className="text-muted-foreground text-xs">
          When on, every user message, tool result, and final assistant reply runs through the
          guardrail layer. Calls go to the project&rsquo;s configured guardrail model
          {defaultGuardrailProvider ? (
            <>
              {" "}
              (currently{" "}
              <span className="font-medium text-foreground">{defaultGuardrailProvider.label}</span>)
            </>
          ) : null}{" "}
          — never an external endpoint.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-6">
        <Label htmlFor={kindId} className="font-medium text-foreground text-sm">
          Strategy
        </Label>
        <p className="text-muted-foreground text-xs">
          Composite is the default — pattern is fast and free, and the model only runs when the
          regex layer is uncertain.
        </p>
        <Select
          value={kind}
          disabled={knobsDisabled}
          onValueChange={(value) =>
            setValues((prev) => ({ ...prev, kind: value as GuardrailKind }))
          }
        >
          <SelectTrigger id={kindId} className="max-w-md">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {KIND_OPTIONS.map((opt) => (
              <SelectItem key={opt.value} value={opt.value}>
                {opt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-[11px] text-muted-foreground/70">
          {KIND_OPTIONS.find((opt) => opt.value === kind)?.hint}
        </p>
      </div>

      <div className="flex flex-col gap-3 border-border border-t pt-6">
        <h3 className="font-medium text-foreground text-sm">Behavior</h3>

        <div className="flex items-start gap-2 text-foreground text-sm">
          <Switch
            id={injectionId}
            checked={blockOnInjection}
            disabled={knobsDisabled}
            onCheckedChange={(next) => setValues((prev) => ({ ...prev, blockOnInjection: next }))}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={injectionId}>Block prompt-injection attempts</Label>
            <p className="text-muted-foreground text-xs">
              Tool results flagged as injection are replaced with a refusal stub before re-entering
              the prompt. Off keeps the original payload and only annotates the row.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 text-foreground text-sm">
          <Switch
            id={offTopicId}
            checked={blockOffTopic}
            disabled={knobsDisabled}
            onCheckedChange={(next) => setValues((prev) => ({ ...prev, blockOffTopic: next }))}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={offTopicId}>Block off-topic chat</Label>
            <p className="text-muted-foreground text-xs">
              User messages classified as outside the software / work-item scope (cooking, shopping,
              medical advice) are refused before the agent sees them. Off downgrades to a banner.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-3 border-border border-t pt-6">
        <h3 className="font-medium text-foreground text-sm">LLM-judge round-trips</h3>
        <p className="text-muted-foreground text-xs">
          These add a one-token classifier call on the guardrail model. They only run when the
          strategy is <em>composite</em> or <em>llm-judge</em>; pattern-only and off ignore them.
        </p>

        <div className="flex items-start gap-2 text-foreground text-sm">
          <Switch
            id={scopeId}
            checked={scopeCheckEnabled}
            disabled={subKnobsDisabled}
            onCheckedChange={(next) => setValues((prev) => ({ ...prev, scopeCheckEnabled: next }))}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={scopeId}>Scope-check user input</Label>
            <p className="text-muted-foreground text-xs">
              Classify each user message as on-topic / off-topic. Turn off if your projects extend
              beyond software work-items.
            </p>
          </div>
        </div>

        <div className="flex items-start gap-2 text-foreground text-sm">
          <Switch
            id={outputId}
            checked={outputCheckEnabled}
            disabled={subKnobsDisabled}
            onCheckedChange={(next) => setValues((prev) => ({ ...prev, outputCheckEnabled: next }))}
          />
          <div className="flex flex-col gap-0.5">
            <Label htmlFor={outputId}>Output safety check</Label>
            <p className="text-muted-foreground text-xs">
              Run the assistant&rsquo;s final reply through a harmful-content classifier. Output is
              never blocked mid-stream — flagged messages get a banner. Costs one extra round-trip
              per turn.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-3 border-border border-t pt-6">
        <Button type="submit" disabled={save.isPending || !hasGuardrailProvider}>
          {save.isPending ? "Saving…" : "Save guardrail settings"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() =>
            setValues({
              enabled: true,
              kind: "composite",
              blockOnInjection: true,
              blockOffTopic: true,
              scopeCheckEnabled: true,
              outputCheckEnabled: false,
            })
          }
        >
          Reset to defaults
        </Button>
        {save.error ? <span className="text-destructive text-xs">{save.error.message}</span> : null}
        {save.isSuccess ? <span className="text-muted-foreground text-xs">Saved.</span> : null}
      </div>
    </form>
  );
}
