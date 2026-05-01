"use client";

import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

/**
 * Per-project knobs for the recommendation modes the agent can volunteer:
 * likely-resolved detection, duplicate detection, and the code-snippet caps
 * the deterministic post-processor enforces on every reply / staged body.
 */
export function RecommendationsPanel({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectSlug });

  const [likelyResolvedEnabled, setLikelyResolvedEnabled] = useState(true);
  const [duplicateEnabled, setDuplicateEnabled] = useState(true);
  const [codeExamplesEnabled, setCodeExamplesEnabled] = useState(true);
  const [maxLines, setMaxLines] = useState<string>("20");
  const [maxSnippets, setMaxSnippets] = useState<string>("2");
  const [similarityThreshold, setSimilarityThreshold] = useState<string>("70");

  const likelyId = useId();
  const dupId = useId();
  const codeId = useId();
  const maxLinesId = useId();
  const maxSnippetsId = useId();
  const thresholdId = useId();

  // Seed once per project — a sibling save's invalidation would otherwise
  // clobber the user's in-progress edits.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededForRef.current === projectSlug) return;
    if (!projectSettings.data) return;
    const lookup = new Map(projectSettings.data.map((row) => [row.key, row.value]));
    const lr = lookup.get("recommendations.likely-resolved.enabled");
    const dup = lookup.get("recommendations.duplicate-detection.enabled");
    const ce = lookup.get("recommendations.code-examples.enabled");
    const ml = lookup.get("recommendations.code-examples.max-lines");
    const ms = lookup.get("recommendations.code-examples.max-snippets-per-reply");
    const th = lookup.get("recommendations.duplicate-detection.similarity-threshold");
    setLikelyResolvedEnabled(typeof lr === "boolean" ? lr : true);
    setDuplicateEnabled(typeof dup === "boolean" ? dup : true);
    setCodeExamplesEnabled(typeof ce === "boolean" ? ce : true);
    setMaxLines(typeof ml === "number" ? String(ml) : "20");
    setMaxSnippets(typeof ms === "number" ? String(ms) : "2");
    setSimilarityThreshold(typeof th === "number" ? String(th) : "70");
    seededForRef.current = projectSlug;
  }, [projectSettings.data, projectSlug]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectSlug });
    },
  });

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const maxLinesNum = Number.parseInt(maxLines, 10);
    const maxSnippetsNum = Number.parseInt(maxSnippets, 10);
    const thresholdNum = Number.parseInt(similarityThreshold, 10);
    if (!Number.isFinite(maxLinesNum) || maxLinesNum < 1 || maxLinesNum > 40) return;
    if (!Number.isFinite(maxSnippetsNum) || maxSnippetsNum < 0 || maxSnippetsNum > 4) return;
    if (!Number.isFinite(thresholdNum) || thresholdNum < 50 || thresholdNum > 95) return;
    await Promise.all([
      save.mutateAsync({
        projectSlug,
        key: "recommendations.likely-resolved.enabled",
        value: likelyResolvedEnabled,
      }),
      save.mutateAsync({
        projectSlug,
        key: "recommendations.duplicate-detection.enabled",
        value: duplicateEnabled,
      }),
      save.mutateAsync({
        projectSlug,
        key: "recommendations.code-examples.enabled",
        value: codeExamplesEnabled,
      }),
      save.mutateAsync({
        projectSlug,
        key: "recommendations.code-examples.max-lines",
        value: maxLinesNum,
      }),
      save.mutateAsync({
        projectSlug,
        key: "recommendations.code-examples.max-snippets-per-reply",
        value: maxSnippetsNum,
      }),
      save.mutateAsync({
        projectSlug,
        key: "recommendations.duplicate-detection.similarity-threshold",
        value: thresholdNum,
      }),
    ]);
  };

  if (projectSettings.isPending) {
    return <p className="text-muted-foreground/70 text-sm">Loading…</p>;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={likelyId}
            checked={likelyResolvedEnabled}
            disabled={save.isPending}
            onCheckedChange={setLikelyResolvedEnabled}
          />
          <Label htmlFor={likelyId}>Likely-resolved detection</Label>
        </div>
        <p className="text-muted-foreground text-xs">
          When on, the agent may surface tickets whose underlying issue appears to be fixed in code
          (a merged PR references the item, the description doesn't already cite it) and stage a
          close-as-done transition plus a comment linking the resolving change.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-6">
        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={dupId}
            checked={duplicateEnabled}
            disabled={save.isPending}
            onCheckedChange={setDuplicateEnabled}
          />
          <Label htmlFor={dupId}>Duplicate-detection recommendations</Label>
        </div>
        <p className="text-muted-foreground text-xs">
          When on, the agent may suggest duplicates within this project. Suggestions still need
          evidence beyond title overlap (similarity threshold below, tag/repo overlap, or an
          explicit cross-reference). Off means the agent won't volunteer duplicates — the user can
          still ask for them explicitly.
        </p>
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-6">
        <Label htmlFor={thresholdId} className="font-medium text-foreground text-sm">
          Duplicate similarity threshold (%)
        </Label>
        <p className="text-muted-foreground text-xs">
          Jaccard token-overlap percentage between candidate items' titles + descriptions. Below
          this, the agent must NOT propose a duplicate-closing action. Range 50–95.
        </p>
        <Input
          id={thresholdId}
          type="number"
          inputMode="numeric"
          min={50}
          max={95}
          step={1}
          value={similarityThreshold}
          disabled={save.isPending}
          onChange={(e) => setSimilarityThreshold(e.target.value)}
          className="max-w-[8rem]"
        />
      </div>

      <div className="flex flex-col gap-2 border-border border-t pt-6">
        <div className="flex items-center gap-2 text-foreground text-sm">
          <Switch
            id={codeId}
            checked={codeExamplesEnabled}
            disabled={save.isPending}
            onCheckedChange={setCodeExamplesEnabled}
          />
          <Label htmlFor={codeId}>Allow short code snippets in replies</Label>
        </div>
        <p className="text-muted-foreground text-xs">
          When on, the agent may include short fenced code snippets (one-line guards, config tweaks,
          type narrowings). When off, every fenced block in a reply or staged comment / description
          body is replaced with a one-line italic placeholder.
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={maxLinesId} className="font-medium text-foreground text-sm">
          Max lines per snippet
        </Label>
        <p className="text-muted-foreground text-xs">
          Hard cap on body lines per fenced block. Blocks past the cap are trimmed and a
          language-aware "truncated by docket" comment is appended. Range 1–40.
        </p>
        <Input
          id={maxLinesId}
          type="number"
          inputMode="numeric"
          min={1}
          max={40}
          step={1}
          value={maxLines}
          disabled={save.isPending || !codeExamplesEnabled}
          onChange={(e) => setMaxLines(e.target.value)}
          className="max-w-[8rem]"
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor={maxSnippetsId} className="font-medium text-foreground text-sm">
          Max snippets per reply
        </Label>
        <p className="text-muted-foreground text-xs">
          Hard cap on fenced blocks per assistant reply or staged body. Blocks past the cap are
          dropped entirely. 0 is equivalent to disabling code examples. Range 0–4.
        </p>
        <Input
          id={maxSnippetsId}
          type="number"
          inputMode="numeric"
          min={0}
          max={4}
          step={1}
          value={maxSnippets}
          disabled={save.isPending || !codeExamplesEnabled}
          onChange={(e) => setMaxSnippets(e.target.value)}
          className="max-w-[8rem]"
        />
      </div>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={save.isPending}>
          {save.isPending ? "Saving…" : "Save recommendation settings"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => {
            setLikelyResolvedEnabled(true);
            setDuplicateEnabled(true);
            setCodeExamplesEnabled(true);
            setMaxLines("20");
            setMaxSnippets("2");
            setSimilarityThreshold("70");
          }}
        >
          Reset to defaults
        </Button>
        {save.error ? <span className="text-destructive text-xs">{save.error.message}</span> : null}
        {save.isSuccess ? <span className="text-muted-foreground text-xs">Saved.</span> : null}
      </div>
    </form>
  );
}
