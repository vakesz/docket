"use client";
import { Input } from "@headlessui/react";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import type { StateBucket } from "@/core/types";
import {
  errorMessageClass,
  fieldClass,
  metaLabelFaintClass,
  xsBorderButtonClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { SelectField } from "@/ui/forms/select-field";

type Props = {
  projectId: string;
};

const BUCKETS: readonly StateBucket[] = ["open", "closed", "all"];

/**
 * View bar for the items page.
 *
 * Drives `?viewId`, `?bucket`, `?assignees`, `?axes` URL params — the
 * server-rendered items page reads them back and feeds them into
 * `items.list`. Keeping the URL as the source of truth means a saved view
 * is shareable (paste the URL, get the same filtered list) and survives
 * refresh, which the ad-hoc client-state version wouldn't.
 *
 * Today this surface only wires the saved-view picker + bucket pills + a
 * minimal save-as-view form. Per-axis chips with top-N popovers are a
 * follow-up — the underlying router + view filter already support them.
 */
export function ViewBar({ projectId }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const utils = trpc.useUtils();

  const activeViewId = params.get("viewId") ?? "";
  const bucketParam = params.get("bucket") ?? "open";
  const bucket: StateBucket = (BUCKETS as readonly string[]).includes(bucketParam)
    ? (bucketParam as StateBucket)
    : "open";

  const views = trpc.views.list.useQuery({ projectId });
  const create = trpc.views.create.useMutation({
    onSuccess: async (created) => {
      await utils.views.list.invalidate({ projectId });
      navigateWith({ viewId: created.id });
      setShowForm(false);
      setNewName("");
    },
  });
  const remove = trpc.views.delete.useMutation({
    onSuccess: async (_data, vars) => {
      await utils.views.list.invalidate({ projectId });
      if (vars.viewId === activeViewId) navigateWith({ viewId: undefined });
    },
  });
  const setDefault = trpc.views.setDefault.useMutation({
    onSuccess: async () => {
      await utils.views.list.invalidate({ projectId });
    },
  });

  const [showForm, setShowForm] = useState(false);
  const [newName, setNewName] = useState("");

  const activeView = useMemo(
    () => views.data?.find((v) => v.id === activeViewId) ?? null,
    [views.data, activeViewId],
  );

  function navigateWith(patch: { viewId?: string | undefined; bucket?: StateBucket }) {
    const next = new URLSearchParams(params.toString());
    if (patch.viewId === undefined) {
      next.delete("viewId");
    } else if (patch.viewId === "") {
      next.delete("viewId");
    } else {
      next.set("viewId", patch.viewId);
    }
    if (patch.bucket) {
      next.set("bucket", patch.bucket);
    }
    const qs = next.toString();
    router.replace(`/projects/${projectId}/items${qs ? `?${qs}` : ""}`);
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newName.trim()) return;
    create.mutate({
      projectId,
      name: newName.trim(),
      // Snapshot whatever the URL currently encodes — bucket today; later,
      // assignees/axes too.
      stateBucket: bucket,
      assignees: [],
      axes: {},
      isDefault: false,
    });
  }

  return (
    <section className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-3 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className={metaLabelFaintClass}>View</span>
          <SelectField
            aria-label="View"
            value={activeViewId}
            onChange={(e) => navigateWith({ viewId: e.target.value || undefined })}
          >
            <option value="">All items (no view)</option>
            {(views.data ?? []).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
                {v.isDefault ? " ★" : ""}
              </option>
            ))}
          </SelectField>
        </div>

        <nav className="flex items-center gap-1">
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => navigateWith({ bucket: b })}
              className={cn(
                "rounded-full px-3 py-1 text-xs transition-colors",
                bucket === b
                  ? "bg-primary text-primary-foreground"
                  : "border border-border text-muted-foreground hover:bg-muted",
              )}
              disabled={activeView !== null}
              title={
                activeView
                  ? "State bucket is fixed by the active view; switch to ‘All items’ to override"
                  : undefined
              }
            >
              {b}
            </button>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-2 text-xs">
          {activeView ? (
            <>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={setDefault.isPending || activeView.isDefault}
                onClick={() => setDefault.mutate({ projectId, viewId: activeView.id })}
              >
                {activeView.isDefault ? "Default ★" : "Make default"}
              </button>
              <button
                type="button"
                className="text-destructive hover:opacity-80 disabled:opacity-50"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete view “${activeView.name}”?`)) {
                    remove.mutate({ projectId, viewId: activeView.id });
                  }
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? "Cancel" : "Save current as view…"}
            </button>
          )}
        </div>
      </div>

      {showForm ? (
        <form onSubmit={onCreate} className="flex items-center gap-2">
          <Input
            type="text"
            placeholder="View name (e.g. ‘My open work’)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className={`${fieldClass} flex-1`}
          />
          <button
            type="submit"
            disabled={create.isPending || !newName.trim()}
            className={xsBorderButtonClass}
          >
            {create.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}
      {create.error ? <p className={errorMessageClass}>{create.error.message}</p> : null}
    </section>
  );
}
