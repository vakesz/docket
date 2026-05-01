"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useId, useMemo, useState } from "react";
import { trpc } from "@/lib/trpc-client";
import type { ProviderTypeId } from "@/server/provider-registry";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/ui/primitives/select";
import { Switch } from "@/ui/primitives/switch";

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
          await setDefault.mutateAsync({ projectSlug: project.slug });
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
      router.push(`/projects/${project.slug}/items`);
      router.refresh();
    },
  });

  const specs = kinds.data ?? [];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [providerKind, setProviderKind] = useState<string>("");
  const [scope, setScope] = useState<Record<string, string>>({});
  const [makeDefault, setMakeDefault] = useState(defaultMakeDefault);

  const nameId = useId();
  const descriptionId = useId();
  const providerId = useId();
  const makeDefaultId = useId();

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
    return <p className="text-muted-foreground/70 text-sm">Loading providers…</p>;
  }
  if (kinds.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{kinds.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (specs.length === 0) {
    return (
      <p className="text-muted-foreground text-sm">
        No providers registered. Configure one under Settings → OAuth providers first.
      </p>
    );
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex flex-col gap-4 rounded-2xl border border-border bg-card p-6 text-sm shadow-sm"
    >
      <h2 className="font-medium text-base text-foreground">Add project</h2>

      <div className="flex flex-col gap-1">
        <Label htmlFor={nameId} className="text-muted-foreground text-xs">
          Display name
        </Label>
        <Input
          id={nameId}
          required
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="acme / web"
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={descriptionId} className="text-muted-foreground text-xs">
          Description (optional)
        </Label>
        <Input
          id={descriptionId}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={providerId} className="text-muted-foreground text-xs">
          Provider
        </Label>
        <Select value={activeKind} onValueChange={setProviderKind}>
          <SelectTrigger id={providerId} aria-label="Provider" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {specs.map((s) => (
              <SelectItem key={s.typeId} value={s.typeId}>
                {s.displayName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {activeSpec ? (
        <div className="flex flex-col gap-1">
          <div className="flex flex-wrap gap-3">
            {activeSpec.setupFields.map((f) => (
              <ScopeField
                key={f.key}
                field={f}
                value={scope[f.key] ?? ""}
                onChange={(value) => setScopeField(f.key, value)}
              />
            ))}
          </div>
        </div>
      ) : null}

      <div className="inline-flex items-center gap-2 text-foreground text-sm">
        <Switch id={makeDefaultId} checked={makeDefault} onCheckedChange={setMakeDefault} />
        <Label htmlFor={makeDefaultId}>Set as my default project</Label>
      </div>

      {create.error ? (
        <Alert variant="destructive">
          <AlertDescription>{create.error.message}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="submit"
        disabled={create.isPending || setDefault.isPending || !activeSpec}
        className="self-start"
      >
        {create.isPending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

function ScopeField({
  field,
  value,
  onChange,
}: {
  field: {
    key: string;
    label: string;
    placeholder?: string;
    help?: string;
    required?: boolean;
    kind?: string;
  };
  value: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className="flex min-w-[12rem] flex-1 flex-col gap-1">
      <Label htmlFor={id} className="text-muted-foreground text-xs">
        {field.label}
      </Label>
      <Input
        id={id}
        required={field.required}
        type={field.kind === "secret" ? "password" : field.kind === "url" ? "url" : "text"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder}
      />
      {field.help ? <p className="text-muted-foreground text-xs">{field.help}</p> : null}
    </div>
  );
}
