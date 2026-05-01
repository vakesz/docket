"use client";

import { useEffect, useId, useRef, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import { Button } from "@/ui/primitives/button";
import { Label } from "@/ui/primitives/label";
import { Switch } from "@/ui/primitives/switch";

/**
 * Per-project auto-accept policy.
 *
 * Lets the user opt-in to skipping the human-in-the-loop confirmation step
 * for low-stakes proposal kinds. Tier C kinds (state changes, description
 * rewrites, comments, item creation) are deliberately not surfaced — they
 * have non-recoverable user-visible blast radius and the catalog validator
 * rejects them server-side regardless.
 */

type AutoAcceptKind = {
  key: "memory_write" | "memory_delete";
  label: string;
  hint: string;
};

const KINDS: readonly AutoAcceptKind[] = [
  {
    key: "memory_write",
    label: "Memory writes (create / update)",
    hint: "Agent-staged additions to project memory land immediately. Local DB only — no provider write.",
  },
  {
    key: "memory_delete",
    label: "Memory deletes",
    hint: "Removes a memory entry without a tap. Local DB only — no provider write.",
  },
];

export function AutoAcceptPanel({ projectSlug }: { projectSlug: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectSlug });

  const [selected, setSelected] = useState<Set<string>>(new Set());

  // Seed once per project. A refetch from a sibling save would otherwise
  // replace the user's in-progress toggle changes with the unchanged
  // stored set; switching projects in-place must re-seed from the new
  // project's settings instead of keeping the previous project's state.
  const seededForRef = useRef<string | null>(null);
  useEffect(() => {
    if (seededForRef.current === projectSlug) return;
    if (!projectSettings.data) return;
    const row = projectSettings.data.find((r) => r.key === "proposals.auto-accept-kinds");
    setSelected(Array.isArray(row?.value) ? new Set(row.value as string[]) : new Set<string>());
    seededForRef.current = projectSlug;
  }, [projectSettings.data, projectSlug]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectSlug });
    },
  });

  const isDirty = (() => {
    const row = projectSettings.data?.find((r) => r.key === "proposals.auto-accept-kinds");
    const stored = Array.isArray(row?.value) ? new Set(row.value as string[]) : new Set<string>();
    if (stored.size !== selected.size) return true;
    for (const k of stored) if (!selected.has(k)) return true;
    return false;
  })();

  const toggle = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const onSave = async () => {
    await save.mutateAsync({
      projectSlug,
      key: "proposals.auto-accept-kinds",
      value: Array.from(selected),
    });
  };

  if (projectSettings.isPending) {
    return <p className="text-muted-foreground/70 text-sm">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-muted-foreground text-xs">
        Off by default. Each toggle skips the confirm step for proposals of that kind on this
        project. Only memory writes/deletes are eligible — anything that touches the provider (state
        changes, descriptions, comments, labels/tags, assignee changes, new items) always requires
        explicit human review. Read-only mode always wins.
      </p>

      <ul className="flex flex-col gap-4">
        {KINDS.map((k) => (
          <AutoAcceptRow
            key={k.key}
            kind={k}
            checked={selected.has(k.key)}
            disabled={save.isPending}
            onToggle={() => toggle(k.key)}
          />
        ))}
      </ul>

      <div className="flex items-center gap-3">
        <Button type="button" onClick={onSave} disabled={save.isPending || !isDirty}>
          {save.isPending ? "Saving…" : "Save auto-accept policy"}
        </Button>
        <Button
          type="button"
          variant="secondary"
          disabled={save.isPending}
          onClick={() => setSelected(new Set())}
        >
          Disable all
        </Button>
        {save.error ? <span className="text-destructive text-xs">{save.error.message}</span> : null}
        {save.isSuccess && !isDirty ? (
          <span className="text-muted-foreground text-xs">Saved.</span>
        ) : null}
      </div>
    </div>
  );
}

function AutoAcceptRow({
  kind,
  checked,
  disabled,
  onToggle,
}: {
  kind: AutoAcceptKind;
  checked: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const id = useId();
  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center gap-2 text-foreground text-sm">
        <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onToggle} />
        <Label htmlFor={id}>{kind.label}</Label>
      </div>
      <p className="ml-6 text-muted-foreground text-xs">{kind.hint}</p>
    </li>
  );
}
