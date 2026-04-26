"use client";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import type { StateBucket } from "@/core/types";
import { trpc } from "@/lib/trpc-client";

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
    <section className="flex flex-col gap-3 rounded-md border border-zinc-200 p-3 text-sm dark:border-zinc-800">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-zinc-500">View</span>
          <select
            className="rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
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
          </select>
        </label>

        <nav className="flex items-center gap-1">
          {BUCKETS.map((b) => (
            <button
              key={b}
              type="button"
              onClick={() => navigateWith({ bucket: b })}
              className={
                bucket === b
                  ? "rounded-full bg-zinc-900 px-3 py-1 text-xs text-white dark:bg-white dark:text-black"
                  : "rounded-full border border-zinc-300 px-3 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }
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
                className="text-zinc-500 hover:text-zinc-800 disabled:opacity-50 dark:hover:text-zinc-200"
                disabled={setDefault.isPending || activeView.isDefault}
                onClick={() => setDefault.mutate({ projectId, viewId: activeView.id })}
              >
                {activeView.isDefault ? "Default ★" : "Make default"}
              </button>
              <button
                type="button"
                className="text-red-600 hover:text-red-800 disabled:opacity-50"
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
              className="text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200"
              onClick={() => setShowForm((v) => !v)}
            >
              {showForm ? "Cancel" : "Save current as view…"}
            </button>
          )}
        </div>
      </div>

      {showForm ? (
        <form onSubmit={onCreate} className="flex items-center gap-2">
          <input
            type="text"
            placeholder="View name (e.g. ‘My open work’)"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="flex-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
          <button
            type="submit"
            disabled={create.isPending || !newName.trim()}
            className="rounded-md border border-zinc-300 px-3 py-1 text-xs disabled:opacity-50 dark:border-zinc-700"
          >
            {create.isPending ? "Saving…" : "Save"}
          </button>
        </form>
      ) : null}
      {create.error ? <p className="text-xs text-red-600">{create.error.message}</p> : null}
    </section>
  );
}
