"use client";
import { Field, Input, Label, Switch } from "@headlessui/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  primaryButtonClass,
  settingsPanelClass,
  switchThumbClass,
  switchTrackClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type ProviderKind = "github" | "azure_devops";

type Props = {
  /**
   * Initial state of the "Set as my default project" checkbox. The first-
   * project landing flips it on; the settings-panel mount leaves it off so
   * adding a second repo doesn't quietly steal the user's landing page.
   */
  defaultMakeDefault?: boolean;
  /**
   * Called after a successful create (and optional setDefault). When
   * omitted, the form navigates to the new project's items shell — the
   * landing-page behavior. When provided, the caller decides what happens
   * next (typically: stay in place, refresh the projects list).
   */
  onCreated?: (project: { id: string; name: string }) => void;
};

/**
 * Create form: name + provider kind + per-kind scope inputs that assemble
 * into the JSON the server expects. The "Set as default" checkbox calls
 * `projects.setDefault` immediately after creation so the next visit to
 * `/` lands here automatically.
 */
export function CreateProjectForm({ defaultMakeDefault = true, onCreated }: Props = {}) {
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
      if (onCreated) {
        setName("");
        setDescription("");
        setGithubOwner("");
        setGithubRepo("");
        setAzdoOrg("");
        setAzdoProject("");
        onCreated({ id: project.id, name: project.name });
        return;
      }
      router.push(`/projects/${project.id}/items`);
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
  const [makeDefault, setMakeDefault] = useState(defaultMakeDefault);

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

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Display name</Label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme / web"
          className={fieldClass}
        />
      </Field>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Description (optional)</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={fieldClass}
        />
      </Field>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Provider</span>
        <SelectField
          aria-label="Provider"
          value={providerKind}
          onChange={(e) => setProviderKind(e.target.value as ProviderKind)}
        >
          <option value="github">GitHub</option>
          <option value="azure_devops">Azure DevOps</option>
        </SelectField>
      </div>

      {providerKind === "github" ? (
        <div className="flex flex-col gap-1">
          <div className="flex gap-3">
            <Field className="flex flex-1 flex-col gap-1">
              <Label className="text-xs text-fg-muted">Owner</Label>
              <Input
                required
                value={githubOwner}
                onChange={(e) => setGithubOwner(e.target.value)}
                placeholder="acme"
                className={fieldClass}
              />
            </Field>
            <Field className="flex flex-1 flex-col gap-1">
              <Label className="text-xs text-fg-muted">Repo</Label>
              <Input
                required
                value={githubRepo}
                onChange={(e) => setGithubRepo(e.target.value)}
                placeholder="web"
                className={fieldClass}
              />
            </Field>
          </div>
          <p className="text-xs text-fg-muted">
            From the repo URL{" "}
            <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">
              github.com/{`{owner}/{repo}`}
            </code>
            . One project tracks one repo.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1">
          <div className="flex gap-3">
            <Field className="flex flex-1 flex-col gap-1">
              <Label className="text-xs text-fg-muted">Organization</Label>
              <Input
                required
                value={azdoOrg}
                onChange={(e) => setAzdoOrg(e.target.value)}
                placeholder="contoso"
                className={fieldClass}
              />
            </Field>
            <Field className="flex flex-1 flex-col gap-1">
              <Label className="text-xs text-fg-muted">Project</Label>
              <Input
                required
                value={azdoProject}
                onChange={(e) => setAzdoProject(e.target.value)}
                placeholder="Platform"
                className={fieldClass}
              />
            </Field>
          </div>
          <p className="text-xs text-fg-muted">
            From{" "}
            <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">
              dev.azure.com/{`{organization}/{project}`}
            </code>
            .
          </p>
        </div>
      )}

      <Field className="inline-flex items-center gap-2 text-sm text-fg">
        <Switch checked={makeDefault} onChange={setMakeDefault} className={switchTrackClass}>
          <span aria-hidden className={switchThumbClass} />
        </Switch>
        <Label>Set as my default project</Label>
      </Field>

      {create.error ? <p className={errorMessageClass}>{create.error.message}</p> : null}

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
