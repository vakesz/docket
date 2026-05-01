"use client";
import { useRouter } from "next/navigation";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Badge } from "@/ui/primitives/badge";
import { Button } from "@/ui/primitives/button";
import { CreateProjectForm } from "@/ui/projects/create-project-form";

type ProjectRow = {
  id: string;
  slug: string;
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
    return <p className="text-muted-foreground/70 text-sm">Loading projects…</p>;
  }
  if (list.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{list.error.message}</AlertDescription>
      </Alert>
    );
  }

  const defaultId = me.data?.defaultProjectId ?? null;
  const projects: ProjectRow[] = list.data;

  return (
    <div className="flex flex-col gap-6">
      <section className="flex flex-col gap-3">
        <h2 className="font-medium text-base text-foreground">Your projects</h2>
        {projects.length === 0 ? (
          <p className="rounded-2xl border border-border border-dashed bg-card p-6 text-center text-muted-foreground text-sm">
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
                  className="flex flex-col gap-2 rounded-2xl border border-border bg-card p-4 shadow-sm sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium text-foreground">{p.name}</span>
                      <Badge variant="outline" className="uppercase tracking-wide">
                        {p.providerKind.replace("_", " ")}
                      </Badge>
                      {isDefault ? (
                        <Badge className="uppercase tracking-wide">default</Badge>
                      ) : null}
                    </div>
                    {label ? (
                      <p className="font-mono text-muted-foreground text-xs">{label}</p>
                    ) : null}
                    {p.description ? (
                      <p className="text-muted-foreground text-xs">{p.description}</p>
                    ) : null}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    {!isDefault ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="xs"
                        disabled={setDefault.isPending}
                        onClick={() => setDefault.mutate({ projectSlug: p.slug })}
                      >
                        Set default
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="destructive"
                      size="xs"
                      disabled={archive.isPending}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Archive "${p.name}"? It will disappear from project lists. The data stays in the database.`,
                          )
                        ) {
                          archive.mutate({ projectSlug: p.slug });
                        }
                      }}
                    >
                      Archive
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {setDefault.error ? (
          <Alert variant="destructive">
            <AlertDescription>{setDefault.error.message}</AlertDescription>
          </Alert>
        ) : null}
        {archive.error ? (
          <Alert variant="destructive">
            <AlertDescription>{archive.error.message}</AlertDescription>
          </Alert>
        ) : null}
      </section>

      <div aria-hidden="true" className="my-2 h-px bg-border" />

      <CreateProjectForm
        defaultMakeDefault={projects.length === 0}
        onCreated={() => router.refresh()}
      />
    </div>
  );
}
