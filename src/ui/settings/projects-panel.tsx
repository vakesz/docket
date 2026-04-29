"use client";
import { useRouter } from "next/navigation";
import {
  accentBadgeClass,
  badgeClass,
  emptyStateClass,
  settingsPanelClass,
  xsBorderButtonClass,
  xsDangerButtonClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { CreateProjectForm } from "@/ui/projects/create-project-form";

type ProjectRow = {
  id: string;
  name: string;
  description: string;
  providerKind: string;
  providerScope: unknown;
  scopeLabel: string;
  ownerUserId: string;
};

/**
 * Settings → You → Projects. Lists every project the caller can see and
 * mounts the create form underneath. This is the surface for adding a
 * second (or third…) repo against the same OAuth provider — the
 * landing-page form is only reachable when the user has zero projects.
 */
export function ProjectsPanel() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const list = trpc.projects.list.useQuery();
  const me = trpc.projects.me.useQuery();
  const setDefault = trpc.projects.setDefault.useMutation({
    onSuccess: async () => {
      await utils.projects.me.invalidate();
      router.refresh();
    },
  });
  const archive = trpc.projects.archive.useMutation({
    onSuccess: async () => {
      await Promise.all([utils.projects.list.invalidate(), utils.projects.me.invalidate()]);
      router.refresh();
    },
  });

  if (list.isPending) {
    return <p className="text-sm text-muted-foreground-faint">Loading projects…</p>;
  }
  if (list.error) {
    return <p className="text-sm text-destructive">{list.error.message}</p>;
  }

  const defaultId = me.data?.defaultProjectId ?? null;
  const projects: ProjectRow[] = list.data;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="text-base font-medium text-foreground">Your projects</h2>
        {projects.length === 0 ? (
          <p className={emptyStateClass}>
            No projects yet. Add one below — each project tracks one repo (GitHub) or one team
            project (Azure DevOps), and they all share the same sign-in.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {projects.map((p) => {
              const label = p.scopeLabel;
              const isDefault = defaultId === p.id;
              return (
                <li
                  key={p.id}
                  className={`${settingsPanelClass} flex flex-col gap-2 p-4 sm:flex-row sm:items-center sm:justify-between`}
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <span className={badgeClass}>{p.providerKind.replace("_", " ")}</span>
                      {isDefault ? <span className={accentBadgeClass}>default</span> : null}
                    </div>
                    {label ? (
                      <p className="font-mono text-xs text-muted-foreground">{label}</p>
                    ) : null}
                    {p.description ? (
                      <p className="text-xs text-muted-foreground">{p.description}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!isDefault ? (
                      <button
                        type="button"
                        className={xsBorderButtonClass}
                        disabled={setDefault.isPending}
                        onClick={() => setDefault.mutate({ projectId: p.id })}
                      >
                        Set default
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className={xsDangerButtonClass}
                      disabled={archive.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Archive "${p.name}"? It will disappear from project lists. The data stays in the database.`,
                          )
                        ) {
                          archive.mutate({ projectId: p.id });
                        }
                      }}
                    >
                      Archive
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {setDefault.error ? (
          <p className="text-xs text-destructive">{setDefault.error.message}</p>
        ) : null}
        {archive.error ? <p className="text-xs text-destructive">{archive.error.message}</p> : null}
      </section>

      <div aria-hidden="true" className="my-2 h-px bg-border" />

      <CreateProjectForm
        defaultMakeDefault={projects.length === 0}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
