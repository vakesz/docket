"use client";
import type { Route } from "next";
import { useRouter, useSearchParams } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import type { StateBucket } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

type Props = {
  projectSlug: string;
};

const BUCKETS: readonly StateBucket[] = ["open", "closed", "all"];
const NO_VIEW = "__none";

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
export function ViewBar({ projectSlug }: Props) {
  const router = useRouter();
  const params = useSearchParams();
  const utils = trpc.useUtils();

  const activeViewId = params.get("viewId") ?? "";
  const bucketParam = params.get("bucket") ?? "open";
  const bucket: StateBucket = (BUCKETS as readonly string[]).includes(bucketParam)
    ? (bucketParam as StateBucket)
    : "open";

  const views = trpc.views.list.useQuery({ projectSlug });
  const create = trpc.views.create.useMutation({
    onSuccess: async (created) => {
      await utils.views.list.invalidate({ projectSlug });
      navigateWith({ viewId: created.id });
      setShowForm(false);
      setNewName("");
    },
  });
  const remove = trpc.views.delete.useMutation({
    onSuccess: async (_data, vars) => {
      await utils.views.list.invalidate({ projectSlug });
      if (vars.viewId === activeViewId) navigateWith({ viewId: undefined });
    },
  });
  const setDefault = trpc.views.setDefault.useMutation({
    onSuccess: async () => {
      await utils.views.list.invalidate({ projectSlug });
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
    router.replace(`/projects/${projectSlug}/items${qs ? `?${qs}` : ""}` as Route);
  }

  function onCreate(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!newName.trim()) return;
    create.mutate({
      projectSlug,
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
          <span className="text-muted-foreground/70 text-xs uppercase tracking-wide">View</span>
          <Select
            value={activeViewId === "" ? NO_VIEW : activeViewId}
            onValueChange={(next) => navigateWith({ viewId: next === NO_VIEW ? undefined : next })}
          >
            <SelectTrigger aria-label="View" className="min-w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_VIEW}>All items (no view)</SelectItem>
              {(views.data ?? []).map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {v.name}
                  {v.isDefault ? " ★" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={setDefault.isPending || activeView.isDefault}
                onClick={() => setDefault.mutate({ projectSlug, viewId: activeView.id })}
              >
                {activeView.isDefault ? "Default ★" : "Make default"}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="xs"
                disabled={remove.isPending}
                onClick={() => {
                  if (confirm(`Delete view “${activeView.name}”?`)) {
                    remove.mutate({ projectSlug, viewId: activeView.id });
                  }
                }}
              >
                Delete
              </Button>
            </>
          ) : (
            <Button type="button" variant="ghost" size="xs" onClick={() => setShowForm((v) => !v)}>
              {showForm ? "Cancel" : "Save current as view…"}
            </Button>
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
            className="flex-1"
          />
          <Button
            type="submit"
            variant="outline"
            size="xs"
            disabled={create.isPending || !newName.trim()}
          >
            {create.isPending ? "Saving…" : "Save"}
          </Button>
        </form>
      ) : null}
      {create.error ? (
        <Alert variant="destructive">
          <AlertDescription>{create.error.message}</AlertDescription>
        </Alert>
      ) : null}
    </section>
  );
}
