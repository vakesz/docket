"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { fieldClass, primaryButtonClass, settingsPanelClass } from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";

type ProviderKind = "github" | "azure_devops";

/**
 * Create form: name + provider kind + per-kind scope inputs that assemble
 * into the JSON the server expects. The "Set as default" checkbox calls
 * `projects.setDefault` immediately after creation so the next visit to
 * `/` lands here automatically.
 */
export function CreateProjectForm() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const setDefault = trpc.projects.setDefault.useMutation({
    onSuccess: async () => {
      await utils.projects.me.invalidate();
    },
  });
  const create = trpc.projects.create.useMutation({
    onSuccess: async (project) => {
      await utils.projects.list.invalidate();
      if (makeDefault) {
        try {
          await setDefault.mutateAsync({ projectId: project.id });
        } catch {
          // The project was created; pinning is best-effort. Surface the
          // error elsewhere later if it actually matters.
        }
      }
      router.push(`/projects/${project.id}`);
      router.refresh();
    },
  });

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerKind, setProviderKind] = useState<ProviderKind>("github");
  // GitHub scope fields
  const [githubOwner, setGithubOwner] = useState("");
  const [githubRepo, setGithubRepo] = useState("");
  // Azure DevOps scope fields
  const [azdoOrg, setAzdoOrg] = useState("");
  const [azdoProject, setAzdoProject] = useState("");
  const [makeDefault, setMakeDefault] = useState(true);

  function buildScope(): Record<string, string> {
    if (providerKind === "github") {
      return { owner: githubOwner.trim(), repo: githubRepo.trim() };
    }
    return { organization: azdoOrg.trim(), project: azdoProject.trim() };
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate({
      name: name.trim(),
      description: description.trim(),
      providerKind,
      providerScope: buildScope(),
    });
  }

  return (
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-fg">Add project</h2>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Display name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme / web"
          className={fieldClass}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Description (optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={fieldClass}
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Provider</span>
        <select
          value={providerKind}
          onChange={(e) => setProviderKind(e.target.value as ProviderKind)}
          className={fieldClass}
        >
          <option value="github">GitHub</option>
          <option value="azure_devops">Azure DevOps</option>
        </select>
      </label>

      {providerKind === "github" ? (
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Owner</span>
            <input
              required
              value={githubOwner}
              onChange={(e) => setGithubOwner(e.target.value)}
              placeholder="acme"
              className={fieldClass}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Repo</span>
            <input
              required
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="web"
              className={fieldClass}
            />
          </label>
        </div>
      ) : (
        <div className="flex gap-3">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Organization</span>
            <input
              required
              value={azdoOrg}
              onChange={(e) => setAzdoOrg(e.target.value)}
              placeholder="contoso"
              className={fieldClass}
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-fg-muted">Project</span>
            <input
              required
              value={azdoProject}
              onChange={(e) => setAzdoProject(e.target.value)}
              placeholder="Platform"
              className={fieldClass}
            />
          </label>
        </div>
      )}

      <label className="inline-flex items-center gap-2 text-sm text-fg">
        <input
          type="checkbox"
          checked={makeDefault}
          onChange={(e) => setMakeDefault(e.target.checked)}
        />
        <span>Set as my default project</span>
      </label>

      {create.error ? (
        <p className="rounded-md border border-danger/40 bg-danger-bg/40 px-2 py-1 text-xs text-danger-fg">
          {create.error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={create.isPending || setDefault.isPending}
        className={`${primaryButtonClass} self-start`}
      >
        {create.isPending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
