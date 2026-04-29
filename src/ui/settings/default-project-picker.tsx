"use client";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

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

  const current = me.data?.defaultProjectId ?? "";

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="default-project" className="text-sm font-medium text-foreground">
        Default project
      </label>
      <p className="text-xs text-muted-foreground">
        Where <code className="rounded bg-muted px-1 text-foreground">/</code> takes you on every
        visit. Falls back to your most-recently-touched project when unset.
      </p>
      <SelectField
        id="default-project"
        value={current}
        disabled={setDefault.isPending}
        onChange={(e) => {
          const next = e.target.value || null;
          setDefault.mutate({ projectId: next });
        }}
      >
        <option value="">(none — auto-pick most recent)</option>
        {projects.data.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </SelectField>
      {setDefault.error ? (
        <p className="text-xs text-destructive">{setDefault.error.message}</p>
      ) : null}
    </div>
  );
}
