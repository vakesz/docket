"use client";
import { fieldClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

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
    return <p className="text-sm text-fg-faint">Loading…</p>;
  }
  if (me.error || projects.error) {
    return (
      <p className="text-sm text-danger-fg">
        {me.error?.message ?? projects.error?.message ?? "failed to load profile"}
      </p>
    );
  }

  const current = me.data?.defaultProjectId ?? "";

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor="default-project" className="text-sm font-medium text-fg">
        Default project
      </label>
      <p className="text-xs text-fg-muted">
        Where <code className="rounded bg-surface-alt px-1 text-fg">/</code> takes you on every
        visit. Falls back to your most-recently-touched project when unset.
      </p>
      <select
        id="default-project"
        value={current}
        disabled={setDefault.isPending}
        onChange={(e) => {
          const next = e.target.value || null;
          setDefault.mutate({ projectId: next });
        }}
        className={fieldClass}
      >
        <option value="">(none — auto-pick most recent)</option>
        {projects.data.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
      {setDefault.error ? (
        <p className="text-xs text-danger-fg">{setDefault.error.message}</p>
      ) : null}
    </div>
  );
}
