"use client";

import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Switch } from "@/ui/primitives/switch";

type CompactionStrategy = "summary" | "drop-tools";

const PROVIDER_NONE = "__none";

/**
 * Per-project LLM defaults — provider row + sampling temperature, plus the
 * conversation-compaction knobs. Conversation overrides (set inside the
 * chat-pane LLM switcher) still win at runtime.
 */
export function ProjectLlmPanel({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const projectsList = trpc.projects.list.useQuery();
  const providers = trpc.llmProviders.list.useQuery();
  const projectSettings = trpc.settings.projectList.useQuery({ projectSlug });

  const project = projectsList.data?.find((p) => p.slug === projectSlug) ?? null;

  const [providerId, setProviderId] = useState<string | "">("");
  const [temperature, setTemperature] = useState<string>("");
  const [compactEnabled, setCompactEnabled] = useState(false);
  const [compactThreshold, setCompactThreshold] = useState<string>("60000");
  const [compactKeep, setCompactKeep] = useState<string>("8");
  const [compactStrategy, setCompactStrategy] = useState<CompactionStrategy>("summary");

  const providerSelectId = useId();
  const temperatureId = useId();
  const compactEnabledId = useId();
  const thresholdId = useId();
  const keepId = useId();
  const strategyId = useId();

  // Seed the form once per project. Re-seeding on every refetch would
  // clobber in-flight user edits — including the partial-state window
  // during the parallel-mutation submit below, where one mutation's
  // invalidate fires a refetch before the others have written their rows.
  // Switching projects in-place must re-seed from the new project's
  // settings instead of keeping the previous project's state.
  const seededProjectFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededProjectFor.current === projectSlug) return;
    if (!project) return;
    setProviderId(project.defaultLlmProviderId ?? "");
    setTemperature(
      project.defaultTemperature !== null && project.defaultTemperature !== undefined
        ? String(project.defaultTemperature)
        : "",
    );
    seededProjectFor.current = projectSlug;
  }, [project, projectSlug]);

  const seededSettingsFor = useRef<string | null>(null);
  useEffect(() => {
    if (seededSettingsFor.current === projectSlug) return;
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
    seededSettingsFor.current = projectSlug;
  }, [projectSettings.data, projectSlug]);

  const saveLlm = trpc.projects.setLlmDefaults.useMutation({
    onSuccess: async () => {
      await utils.projects.list.invalidate();
    },
  });

  const saveSetting = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectSlug });
    },
  });

  const onSubmitLlm = (e: React.FormEvent) => {
    e.preventDefault();
    const tempNum = temperature.trim() === "" ? null : Number.parseFloat(temperature);
    if (tempNum !== null && (!Number.isFinite(tempNum) || tempNum < 0 || tempNum > 2)) {
      return;
    }
    saveLlm.mutate({
      projectSlug,
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
        projectSlug,
        key: "llm.compaction.enabled",
        value: compactEnabled,
      }),
      saveSetting.mutateAsync({
        projectSlug,
        key: "llm.compaction.token-threshold",
        value: thresholdNum,
      }),
      saveSetting.mutateAsync({
        projectSlug,
        key: "llm.compaction.keep-recent-turns",
        value: keepNum,
      }),
      saveSetting.mutateAsync({
        projectSlug,
        key: "llm.compaction.strategy",
        value: compactStrategy,
      }),
    ]);
  };

  if (projectsList.isPending || providers.isPending || projectSettings.isPending) {
    return <p className="text-muted-foreground/70 text-sm">Loading…</p>;
  }
  if (!project) {
    return <p className="text-muted-foreground/70 text-sm">Project not found.</p>;
  }

  const enabled = providers.data?.filter((p) => p.enabled && p.role === "chat") ?? [];
  const globalDefault = providers.data?.find((p) => p.role === "chat" && p.isDefault) ?? null;

  return (
    <div className="flex flex-col gap-8">
      <form onSubmit={onSubmitLlm} className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Label htmlFor={providerSelectId} className="font-medium text-foreground text-sm">
            Default provider
          </Label>
          <p className="text-muted-foreground text-xs">
            Picks the LLM row used by every conversation in this project. Empty falls back to the
            global default
            {globalDefault ? ` (currently ${globalDefault.label})` : " (none configured)"}. A
            per-conversation switcher in the chat pane still wins for individual threads.
          </p>
          <Select
            value={providerId === "" ? PROVIDER_NONE : providerId}
            disabled={saveLlm.isPending}
            onValueChange={(value) => setProviderId(value === PROVIDER_NONE ? "" : value)}
          >
            <SelectTrigger id={providerSelectId} className="max-w-md">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={PROVIDER_NONE}>Use global default</SelectItem>
              {enabled.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label} ({p.kind}
                  {p.model ? ` · ${p.model}` : ""})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="flex flex-col gap-2 border-border border-t pt-6">
          <Label htmlFor={temperatureId} className="font-medium text-foreground text-sm">
            Sampling temperature
          </Label>
          <p className="text-muted-foreground text-xs">
            0–2. Lower is more deterministic, higher is more creative. Empty falls back to the
            adapter default. Per-request overrides (e.g. tool-mode turns) still win.
          </p>
          <Input
            id={temperatureId}
            type="number"
            inputMode="decimal"
            min={0}
            max={2}
            step={0.1}
            placeholder="adapter default"
            value={temperature}
            disabled={saveLlm.isPending}
            onChange={(e) => setTemperature(e.target.value)}
            className="max-w-[8rem]"
          />
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" disabled={saveLlm.isPending}>
            {saveLlm.isPending ? "Saving…" : "Save LLM defaults"}
          </Button>
          {saveLlm.error ? (
            <span className="text-destructive text-xs">{saveLlm.error.message}</span>
          ) : null}
          {saveLlm.isSuccess ? <span className="text-muted-foreground text-xs">Saved.</span> : null}
        </div>
      </form>

      <form
        onSubmit={onSubmitCompaction}
        className="flex flex-col gap-4 border-border border-t pt-6"
      >
        <div>
          <h3 className="font-medium text-foreground text-sm">Conversation compaction</h3>
          <p className="text-muted-foreground text-xs">
            Long threads can exceed the model's context window. When auto-compaction is on, older
            turns are folded into a summary as soon as the transcript crosses the token threshold.
            Manual compaction is always available from the chat pane.
          </p>
        </div>

        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={compactEnabledId}
            checked={compactEnabled}
            disabled={saveSetting.isPending}
            onCheckedChange={setCompactEnabled}
          />
          <Label htmlFor={compactEnabledId}>Auto-compact long conversations</Label>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={thresholdId} className="font-medium text-foreground text-sm">
            Token threshold
          </Label>
          <p className="text-muted-foreground text-xs">
            Trigger compaction once the live transcript reaches this many estimated tokens (4 chars
            ≈ 1 token). Default 60 000.
          </p>
          <Input
            id={thresholdId}
            type="number"
            inputMode="numeric"
            min={1_000}
            max={500_000}
            step={1_000}
            value={compactThreshold}
            disabled={saveSetting.isPending}
            onChange={(e) => setCompactThreshold(e.target.value)}
            className="max-w-[10rem]"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={keepId} className="font-medium text-foreground text-sm">
            Recent turns to keep verbatim
          </Label>
          <p className="text-muted-foreground text-xs">
            How many of the most-recent message turns survive compaction unchanged. 2–50.
          </p>
          <Input
            id={keepId}
            type="number"
            inputMode="numeric"
            min={2}
            max={50}
            step={1}
            value={compactKeep}
            disabled={saveSetting.isPending}
            onChange={(e) => setCompactKeep(e.target.value)}
            className="max-w-[8rem]"
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor={strategyId} className="font-medium text-foreground text-sm">
            Strategy
          </Label>
          <p className="text-muted-foreground text-xs">
            <strong>summary</strong> replaces older turns with a synthetic system summary.
            <strong> drop-tools</strong> only sheds stale tool-call/result rows and keeps the prose
            — cheaper but less aggressive.
          </p>
          <Select
            value={compactStrategy}
            disabled={saveSetting.isPending}
            onValueChange={(value) => setCompactStrategy(value as CompactionStrategy)}
          >
            <SelectTrigger id={strategyId} className="max-w-[14rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="summary">summary</SelectItem>
              <SelectItem value="drop-tools">drop-tools</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center gap-3">
          <Button type="submit" variant="secondary" disabled={saveSetting.isPending}>
            {saveSetting.isPending ? "Saving…" : "Save compaction settings"}
          </Button>
          {saveSetting.error ? (
            <Alert variant="destructive">
              <AlertDescription>{saveSetting.error.message}</AlertDescription>
            </Alert>
          ) : null}
          {saveSetting.isSuccess ? (
            <span className="text-muted-foreground text-xs">Saved.</span>
          ) : null}
        </div>
      </form>
    </div>
  );
}
