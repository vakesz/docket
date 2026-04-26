"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { trpc } from "@/lib/trpc-client";

type ProviderKind = "github" | "azure_devops";

/**
 * Phase 2 create form: name + provider kind + per-kind scope inputs that
 * assemble into the JSON the server expects. Phase 3 swaps the manual inputs
 * for an OAuth-driven scope picker (list orgs/repos the user can see).
 */
export function CreateProjectForm() {
  const router = useRouter();
  const utils = trpc.useUtils();
  const create = trpc.projects.create.useMutation({
    onSuccess: async (project) => {
      await utils.projects.list.invalidate();
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
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-3 rounded-md border border-zinc-200 p-4 text-sm dark:border-zinc-800"
    >
      <h2 className="text-base font-medium">Add project</h2>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Display name</span>
        <input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme / web"
          className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Description (optional)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-zinc-500">Provider</span>
        <select
          value={providerKind}
          onChange={(e) => setProviderKind(e.target.value as ProviderKind)}
          className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
        >
          <option value="github">GitHub</option>
          <option value="azure_devops">Azure DevOps</option>
        </select>
      </label>

      {providerKind === "github" ? (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-zinc-500">Owner</span>
            <input
              required
              value={githubOwner}
              onChange={(e) => setGithubOwner(e.target.value)}
              placeholder="acme"
              className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-zinc-500">Repo</span>
            <input
              required
              value={githubRepo}
              onChange={(e) => setGithubRepo(e.target.value)}
              placeholder="web"
              className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>
      ) : (
        <div className="flex gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-zinc-500">Organization</span>
            <input
              required
              value={azdoOrg}
              onChange={(e) => setAzdoOrg(e.target.value)}
              placeholder="contoso"
              className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
          <label className="flex flex-1 flex-col gap-1">
            <span className="text-xs text-zinc-500">Project</span>
            <input
              required
              value={azdoProject}
              onChange={(e) => setAzdoProject(e.target.value)}
              placeholder="Platform"
              className="rounded-md border border-zinc-300 px-2 py-1 dark:border-zinc-700 dark:bg-zinc-950"
            />
          </label>
        </div>
      )}

      {create.error ? (
        <p className="rounded-md bg-red-100 px-2 py-1 text-xs text-red-900 dark:bg-red-950 dark:text-red-100">
          {create.error.message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={create.isPending}
        className="self-start rounded-full bg-zinc-900 px-4 py-1 text-xs font-medium text-white transition hover:bg-zinc-800 disabled:opacity-50 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
      >
        {create.isPending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
