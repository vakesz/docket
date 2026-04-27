"use client";

import { useEffect, useMemo, useState } from "react";
import { primaryButtonClass, secondaryButtonClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

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

export function AutoAcceptPanel({ projectId }: { projectId: string }) {
  const utils = trpc.useUtils();
  const projectSettings = trpc.settings.projectList.useQuery({ projectId });

  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!projectSettings.data) return;
    const row = projectSettings.data.find((r) => r.key === "proposals.auto-accept-kinds");
    if (Array.isArray(row?.value)) {
      setSelected(new Set(row.value as string[]));
    }
  }, [projectSettings.data]);

  const save = trpc.settings.projectUpdate.useMutation({
    onSuccess: async () => {
      await utils.settings.projectList.invalidate({ projectId });
    },
  });

  const isDirty = useMemo(() => {
    const row = projectSettings.data?.find((r) => r.key === "proposals.auto-accept-kinds");
    const stored = Array.isArray(row?.value) ? new Set(row.value as string[]) : new Set<string>();
    if (stored.size !== selected.size) return true;
    for (const k of stored) if (!selected.has(k)) return true;
    return false;
  }, [projectSettings.data, selected]);

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
      projectId,
      key: "proposals.auto-accept-kinds",
      value: Array.from(selected),
    });
  };

  if (projectSettings.isPending) {
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      <p className="text-xs text-fg-muted">
        Off by default. Each toggle skips the confirm step for proposals of that kind on this
        project. Only memory writes/deletes are eligible — anything that touches the provider (state
        changes, descriptions, comments, labels/tags, assignee changes, new items) always requires
        explicit human review. Read-only mode always wins.
      </p>

      <ul className="flex flex-col gap-4">
        {KINDS.map((k) => {
          const checked = selected.has(k.key);
          return (
            <li key={k.key} className="flex flex-col gap-1">
              <label className="flex items-center gap-2 text-sm text-fg">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={save.isPending}
                  onChange={() => toggle(k.key)}
                />
                <span>{k.label}</span>
              </label>
              <p className="ml-6 text-xs text-fg-muted">{k.hint}</p>
            </li>
          );
        })}
      </ul>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onSave}
          disabled={save.isPending || !isDirty}
          className={primaryButtonClass}
        >
          {save.isPending ? "Saving…" : "Save auto-accept policy"}
        </button>
        <button
          type="button"
          disabled={save.isPending}
          className={secondaryButtonClass}
          onClick={() => setSelected(new Set())}
        >
          Disable all
        </button>
        {save.error ? <span className="text-xs text-danger-fg">{save.error.message}</span> : null}
        {save.isSuccess && !isDirty ? <span className="text-xs text-fg-muted">Saved.</span> : null}
      </div>
    </div>
  );
}
