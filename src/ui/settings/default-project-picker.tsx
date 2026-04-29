"use client";
import { useId } from "react";
import { trpc } from "@/lib/trpc-client";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";

const NONE = "__none";

/**
 * Per-user landing-project picker. The selected project becomes the redirect
 * target of `/`. Choosing "(none)" clears the pin so landing falls back to
 * the most-recently-touched membership.
 */
export function DefaultProjectPicker() {
  const utils = trpc.useUtils();
  const me = trpc.projects.me.useQuery();
  const projects = trpc.projects.list.useQuery();
  const setDefault = trpc.projects.setDefault.useMutation({
    onSuccess: async () => {
      await utils.projects.me.invalidate();
    },
  });
  const fieldId = useId();

  if (me.isPending || projects.isPending) {
    return <p className="text-sm text-muted-foreground-faint">Loading…</p>;
  }
  if (me.error || projects.error) {
    return (
      <p className="text-sm text-destructive">
        {me.error?.message ?? projects.error?.message ?? "failed to load profile"}
      </p>
    );
  }

  const currentId = me.data?.defaultProjectId ?? null;
  const currentSlug = currentId
    ? (projects.data.find((p) => p.id === currentId)?.slug ?? null)
    : null;

  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={fieldId} className="text-sm font-medium text-foreground">
        Default project
      </Label>
      <p className="text-xs text-muted-foreground">
        Where <code className="rounded bg-muted px-1 text-foreground">/</code> takes you on every
        visit. Falls back to your most-recently-touched project when unset.
      </p>
      <Select
        value={currentSlug ?? NONE}
        disabled={setDefault.isPending}
        onValueChange={(value) => {
          const next = value === NONE ? null : value;
          setDefault.mutate({ projectSlug: next });
        }}
      >
        <SelectTrigger id={fieldId} className="w-full max-w-md">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>(none — auto-pick most recent)</SelectItem>
          {projects.data.map((p) => (
            <SelectItem key={p.id} value={p.slug}>
              {p.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {setDefault.error ? (
        <p className="text-xs text-destructive">{setDefault.error.message}</p>
      ) : null}
    </div>
  );
}
