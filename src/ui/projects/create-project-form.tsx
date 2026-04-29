"use client";
import { Field, Input, Label, Switch } from "@headlessui/react";
import { useRouter } from "next/navigation";
import { type FormEvent, useMemo, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  primaryButtonClass,
  settingsPanelClass,
  switchThumbClass,
  switchTrackClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import type { ProviderTypeId } from "@/server/provider-registry";
import { SelectField } from "@/ui/forms/select-field";

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
 * into the JSON the server expects. Scope inputs are driven by
 * `ProviderSpec.setupFields` (loaded via `projects.kinds`), so a new
 * provider only needs to register its spec — no surface-side branching.
 */
export function CreateProjectForm({ defaultMakeDefault = true, onCreated }: Props = {}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const kinds = trpc.projects.kinds.useQuery();
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
        setScope({});
        onCreated({ id: project.id, name: project.name });
        return;
      }
      router.push(`/projects/${project.id}/items`);
      router.refresh();
    },
  });

  const specs = kinds.data ?? [];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerKind, setProviderKind] = useState<string>("");
  const [scope, setScope] = useState<Record<string, string>>({});
  const [makeDefault, setMakeDefault] = useState(defaultMakeDefault);

  const activeSpec = useMemo(
    () => specs.find((s) => s.typeId === providerKind) ?? specs[0] ?? null,
    [specs, providerKind],
  );
  const activeKind = activeSpec?.typeId ?? "";

  function setScopeField(key: string, value: string) {
    setScope((prev) => ({ ...prev, [key]: value }));
  }

  function buildScope(): Record<string, string> {
    if (!activeSpec) return {};
    const out: Record<string, string> = {};
    for (const f of activeSpec.setupFields) {
      out[f.key] = (scope[f.key] ?? "").trim();
    }
    return out;
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!activeSpec) return;
    // typeId comes from the registry, which the server's zod enum is built
    // from — the value is always a registered kind, but the literal-union
    // narrowing doesn't survive the JSON round-trip back to the client.
    create.mutate({
      name: name.trim(),
      description: description.trim(),
      providerKind: activeSpec.typeId as ProviderTypeId,
      providerScope: buildScope(),
    });
  }

  if (kinds.isPending) {
    return <p className="text-sm text-muted-foreground-faint">Loading providers…</p>;
  }
  if (kinds.error) {
    return <p className={errorMessageClass}>{kinds.error.message}</p>;
  }
  if (specs.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No providers registered. Configure one under Settings → OAuth providers first.
      </p>
    );
  }

  return (
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-foreground">Add project</h2>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Display name</Label>
        <Input
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme / web"
          className={fieldClass}
        />
      </Field>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-muted-foreground">Description (optional)</Label>
        <Input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className={fieldClass}
        />
      </Field>

      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Provider</span>
        <SelectField
          aria-label="Provider"
          value={activeKind}
          onChange={(e) => setProviderKind(e.target.value)}
        >
          {specs.map((s) => (
            <option key={s.typeId} value={s.typeId}>
              {s.displayName}
            </option>
          ))}
        </SelectField>
      </div>

      {activeSpec ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-3">
            {activeSpec.setupFields.map((f) => (
              <Field key={f.key} className="flex flex-1 flex-col gap-1 min-w-[12rem]">
                <Label className="text-xs text-muted-foreground">{f.label}</Label>
                <Input
                  required={f.required}
                  type={f.kind === "secret" ? "password" : f.kind === "url" ? "url" : "text"}
                  value={scope[f.key] ?? ""}
                  onChange={(e) => setScopeField(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className={fieldClass}
                />
                {f.help ? <p className="text-xs text-muted-foreground">{f.help}</p> : null}
              </Field>
            ))}
          </div>
        </div>
      ) : null}

      <Field className="inline-flex items-center gap-2 text-sm text-foreground">
        <Switch checked={makeDefault} onChange={setMakeDefault} className={switchTrackClass}>
          <span aria-hidden className={switchThumbClass} />
        </Switch>
        <Label>Set as my default project</Label>
      </Field>

      {create.error ? <p className={errorMessageClass}>{create.error.message}</p> : null}

      <button
        type="submit"
        disabled={create.isPending || setDefault.isPending || !activeSpec}
        className={`${primaryButtonClass} self-start`}
      >
        {create.isPending ? "Creating…" : "Create project"}
      </button>
    </form>
  );
}
