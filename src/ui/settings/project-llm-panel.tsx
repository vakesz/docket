"use client";

import { Field, Input, Label, Switch } from "@headlessui/react";
import { useEffect, useRef, useState } from "react";
import {
  fieldClass,
  primaryButtonClass,
  secondaryButtonClass,
  switchThumbClass,
  switchTrackClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type CompactionStrategy = "summary" | "drop-tools";

/**
 * Per-project LLM defaults — provider row + sampling temperature, plus the
 * conversation-compaction knobs. Conversation overrides (set inside the
 * chat-pane LLM switcher) still win at runtime.
 */
export function ProjectLlmPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const projectsList = trpc.projects.list.useQuery();
  const providers = trpc.llmProviders.list.useQuery();
  const projectSettings = trpc.settings.projectList.useQuery({ projectId });

  const project = projectsList.data?.find((p) => p.id === projectId) ?? null;

  const [providerId, setProviderId] = useState<string | "">("");
  const [temperature, setTemperature] = useState<string>("");
  const [compactEnabled, setCompactEnabled] = useState(false);
  const [compactThreshold, setCompactThreshold] = useState<string>("60000");
  const [compactKeep, setCompactKeep] = useState<string>("8");
  const [compactStrategy, setCompactStrategy] = useState<CompactionStrategy>("summary");

  // Seed the form once per project. Re-seeding on every refetch would
  // clobber in-flight user edits — including the partial-state window
  // during the parallel-mutation submit below, where one mutation's
  // invalidate fires a refetch before the others have written their rows.
  // Switching projects in-place must re-seed from the new project's
  // settings instead of keeping the previous project's state.
  const seededProjectFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededProjectFor.current === projectId) return;
    if (!project) return;
    setProviderId(project.defaultLlmProviderId ?? "");
    setTemperature(
      project.defaultTemperature !== null && project.defaultTemperature !== undefined
        ? String(project.defaultTemperature)
        : "",
    );
    seededProjectFor.current = projectId;
  }, [project, projectId]);

  const seededSettingsFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededSettingsFor.current === projectId) return;
    if (!projectSettings.data) return;
    const lookup = new Map(projectSettings.data.map((row) => [row.key, row.value]));
    const enabled = lookup.get("llm.compaction.enabled");
    const threshold = lookup.get("llm.compaction.token-threshold");
    const keep = lookup.get("llm.compaction.keep-recent-turns");
    const strategy = lookup.get("llm.compaction.strategy");
    setCompactEnabled(typeof enabled === "boolean" ? enabled : false);
    setCompactThreshold(typeof threshold === "number" ? String(threshold) : "60000");
    setCompactKeep(typeof keep === "number" ? String(keep) : "8");
    setCompactStrategy(strategy === "drop-tools" ? "drop-tools" : "summary");
    seededSettingsFor.current = projectId;
  }, [projectSettings.data, projectId]);

  const saveLlm = trpc.projects.setLlmDefaults.useMutation({
    onSuccess: async () => {
      await utils.projects.list.invalidate();
    },
  });

  const saveSetting = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectId });
    },
  });

  const onSubmitLlm = (e: React.FormEvent) => {
    e.preventDefault();
    const tempNum = temperature.trim() === "" ? null : Number.parseFloat(temperature);
    if (tempNum !== null && (!Number.isFinite(tempNum) || tempNum < 0 || tempNum > 2)) {
      return;
    }
    saveLlm.mutate({
      projectId,
      llmProviderId: providerId === "" ? null : providerId,
      defaultTemperature: tempNum,
    });
  };

  const onSubmitCompaction = async (e: React.FormEvent) => {
    e.preventDefault();
    const thresholdNum = Number.parseInt(compactThreshold, 10);
    const keepNum = Number.parseInt(compactKeep, 10);
    if (!Number.isFinite(thresholdNum) || thresholdNum < 1_000 || thresholdNum > 500_000) return;
    if (!Number.isFinite(keepNum) || keepNum < 2 || keepNum > 50) return;
    await Promise.all([
      saveSetting.mutateAsync({
        projectId,
        key: "llm.compaction.enabled",
        value: compactEnabled,
      }),
      saveSetting.mutateAsync({
        projectId,
        key: "llm.compaction.token-threshold",
        value: thresholdNum,
      }),
      saveSetting.mutateAsync({
        projectId,
        key: "llm.compaction.keep-recent-turns",
        value: keepNum,
      }),
      saveSetting.mutateAsync({
        projectId,
        key: "llm.compaction.strategy",
        value: compactStrategy,
      }),
    ]);
  };

  if (projectsList.isPending || providers.isPending || projectSettings.isPending) {
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }
  if (!project) {
    return <p className="text-sm text-fg-faint">Project not found.</p>;
  }

  const enabled = providers.data?.filter((p) => p.enabled && p.role === "chat") ?? [];
  const globalDefault = providers.data?.find((p) => p.role === "chat" && p.isDefault) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSubmitLlm} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <label htmlFor="project-llm-provider" className="text-sm font-medium text-fg">
            Default provider
          </label>
          <p className="text-xs text-fg-muted">
            Picks the LLM row used by every conversation in this project. Empty falls back to the
            global default
            {globalDefault ? ` (currently ${globalDefault.label})` : " (none configured)"}. A
            per-conversation switcher in the chat pane still wins for individual threads.
          </p>
          <SelectField
            id="project-llm-provider"
            value={providerId}
            disabled={saveLlm.isPending}
            onChange={(e) => setProviderId(e.target.value)}
            wrapperClassName="max-w-md"
          >
            <option value="">Use global default</option>
            {enabled.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.kind}
                {p.model ? ` · ${p.model}` : ""})
              </option>
            ))}
          </SelectField>
        </div>

        <div className="flex flex-col gap-2 border-t border-border pt-6">
          <label htmlFor="project-llm-temperature" className="text-sm font-medium text-fg">
            Sampling temperature
          </label>
          <p className="text-xs text-fg-muted">
            0–2. Lower is more deterministic, higher is more creative. Empty falls back to the
            adapter default. Per-request overrides (e.g. tool-mode turns) still win.
          </p>
          <Input
            id="project-llm-temperature"
            type="number"
            inputMode="decimal"
            min={0}
            max={2}
            step={0.1}
            placeholder="adapter default"
            value={temperature}
            disabled={saveLlm.isPending}
            onChange={(e) => setTemperature(e.target.value)}
            className={`${fieldClass} max-w-[8rem]`}
          />
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={saveLlm.isPending} className={primaryButtonClass}>
            {saveLlm.isPending ? "Saving…" : "Save LLM defaults"}
          </button>
          {saveLlm.error ? (
            <span className="text-xs text-danger-fg">{saveLlm.error.message}</span>
          ) : null}
          {saveLlm.isSuccess ? <span className="text-xs text-fg-muted">Saved.</span> : null}
        </div>
      </form>

      <form
        onSubmit={onSubmitCompaction}
        className="flex flex-col gap-4 border-t border-border pt-6"
      >
        <div>
          <h3 className="text-sm font-medium text-fg">Conversation compaction</h3>
          <p className="text-xs text-fg-muted">
            Long threads can exceed the model's context window. When auto-compaction is on, older
            turns are folded into a summary as soon as the transcript crosses the token threshold.
            Manual compaction is always available from the chat pane.
          </p>
        </div>

        <Field className="flex items-center gap-2 text-sm text-fg">
          <Switch
            checked={compactEnabled}
            disabled={saveSetting.isPending}
            onChange={setCompactEnabled}
            className={switchTrackClass}
          >
            <span aria-hidden className={switchThumbClass} />
          </Switch>
          <Label>Auto-compact long conversations</Label>
        </Field>

        <div className="flex flex-col gap-2">
          <label htmlFor="compact-threshold" className="text-sm font-medium text-fg">
            Token threshold
          </label>
          <p className="text-xs text-fg-muted">
            Trigger compaction once the live transcript reaches this many estimated tokens (4 chars
            ≈ 1 token). Default 60 000.
          </p>
          <Input
            id="compact-threshold"
            type="number"
            inputMode="numeric"
            min={1_000}
            max={500_000}
            step={1_000}
            value={compactThreshold}
            disabled={saveSetting.isPending}
            onChange={(e) => setCompactThreshold(e.target.value)}
            className={`${fieldClass} max-w-[10rem]`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="compact-keep" className="text-sm font-medium text-fg">
            Recent turns to keep verbatim
          </label>
          <p className="text-xs text-fg-muted">
            How many of the most-recent message turns survive compaction unchanged. 2–50.
          </p>
          <Input
            id="compact-keep"
            type="number"
            inputMode="numeric"
            min={2}
            max={50}
            step={1}
            value={compactKeep}
            disabled={saveSetting.isPending}
            onChange={(e) => setCompactKeep(e.target.value)}
            className={`${fieldClass} max-w-[8rem]`}
          />
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="compact-strategy" className="text-sm font-medium text-fg">
            Strategy
          </label>
          <p className="text-xs text-fg-muted">
            <strong>summary</strong> replaces older turns with a synthetic system summary.
            <strong> drop-tools</strong> only sheds stale tool-call/result rows and keeps the prose
            — cheaper but less aggressive.
          </p>
          <SelectField
            id="compact-strategy"
            value={compactStrategy}
            disabled={saveSetting.isPending}
            onChange={(e) => setCompactStrategy(e.target.value as CompactionStrategy)}
            wrapperClassName="max-w-[14rem]"
          >
            <option value="summary">summary</option>
            <option value="drop-tools">drop-tools</option>
          </SelectField>
        </div>

        <div className="flex items-center gap-3">
          <button type="submit" disabled={saveSetting.isPending} className={secondaryButtonClass}>
            {saveSetting.isPending ? "Saving…" : "Save compaction settings"}
          </button>
          {saveSetting.error ? (
            <span className="text-xs text-danger-fg">{saveSetting.error.message}</span>
          ) : null}
          {saveSetting.isSuccess ? <span className="text-xs text-fg-muted">Saved.</span> : null}
        </div>
      </form>
    </div>
  );
}
