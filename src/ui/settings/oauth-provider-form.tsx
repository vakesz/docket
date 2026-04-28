"use client";
import { Field, Input, Label } from "@headlessui/react";
import { type FormEvent, useId, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  secondaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

type OauthDefaults = {
  defaultLabel: string;
  defaultScopes: string;
  baseUrlPlaceholder: string;
};

const FALLBACK_DEFAULTS: OauthDefaults = {
  defaultLabel: "",
  defaultScopes: "",
  baseUrlPlaceholder: "Optional override",
};

export type OauthProviderFormInitial = {
  id: string;
  kind: string;
  label: string;
  clientId: string;
  scopes: string;
  baseUrl: string;
};

type Props =
  | { mode?: "create"; initial?: undefined; onDone?: () => void }
  | { mode: "edit"; initial: OauthProviderFormInitial; onDone?: () => void };

export function OauthProviderForm(props: Props) {
  const mode = props.mode ?? "create";
  const initial = props.initial;
  const utils = trpc.useUtils();

  // Load OAuth-capable provider kinds from the registry. Until the query
  // resolves we fall back to the spec the row was created with (edit mode)
  // or render an empty picker (create mode); both states clear once the
  // network round-trip lands and the kinds list arrives. The fetch is
  // shared with everything else that reads `projects.kinds`, so it's
  // typically already cached when this form mounts.
  const kinds = trpc.projects.kinds.useQuery(undefined, { staleTime: 5 * 60_000 });
  const oauthKinds = (kinds.data ?? []).filter((k) => k.oauth !== null);
  const defaultsByKind = new Map<string, OauthDefaults>(
    oauthKinds.flatMap((k) => (k.oauth ? [[k.typeId, k.oauth]] : [])),
  );
  const firstKind = oauthKinds[0]?.typeId ?? "";
  const initialDefaults = defaultsByKind.get(initial?.kind ?? firstKind) ?? FALLBACK_DEFAULTS;

  const create = trpc.oauthProviders.create.useMutation({
    onSuccess: async () => {
      const d = defaultsByKind.get(kind) ?? FALLBACK_DEFAULTS;
      setLabel(d.defaultLabel);
      setClientId("");
      setClientSecret("");
      setScopes(d.defaultScopes);
      setBaseUrl("");
      await utils.oauthProviders.list.invalidate();
      props.onDone?.();
    },
  });
  const update = trpc.oauthProviders.update.useMutation({
    onSuccess: async () => {
      await utils.oauthProviders.list.invalidate();
      props.onDone?.();
    },
  });

  const kindId = useId();
  const [kind, setKind] = useState<string>(initial?.kind ?? firstKind);
  const [label, setLabel] = useState(initial?.label ?? initialDefaults.defaultLabel);
  const [clientId, setClientId] = useState(initial?.clientId ?? "");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(initial?.scopes ?? initialDefaults.defaultScopes);
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");

  function onKindChange(next: string) {
    setKind(next);
    const d = defaultsByKind.get(next) ?? FALLBACK_DEFAULTS;
    setLabel(d.defaultLabel);
    setScopes(d.defaultScopes);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (mode === "edit" && initial) {
      update.mutate({
        id: initial.id,
        label: label.trim(),
        clientId: clientId.trim(),
        // Preserve existing ciphertext when the field is left blank.
        clientSecret: clientSecret.trim() ? clientSecret : undefined,
        scopes: scopes.trim(),
        baseUrl: baseUrl.trim(),
      });
      return;
    }
    create.mutate({
      kind,
      label: label.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: scopes.trim(),
      baseUrl: baseUrl.trim(),
    });
  }

  const pending = mode === "edit" ? update.isPending : create.isPending;
  const error = (mode === "edit" ? update.error : create.error)?.message;
  const baseUrlHint = (defaultsByKind.get(kind) ?? FALLBACK_DEFAULTS).baseUrlPlaceholder;

  return (
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-fg">
        {mode === "edit" ? "Edit OAuth provider" : "Add OAuth provider"}
      </h2>

      <div className="flex gap-3">
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor={kindId} className="text-xs text-fg-muted">
            Kind
          </label>
          {mode === "edit" ? (
            <Input
              id={kindId}
              value={kind.replace("_", " ")}
              readOnly
              className={`${fieldClass} cursor-not-allowed opacity-70`}
            />
          ) : (
            <SelectField id={kindId} value={kind} onChange={(e) => onKindChange(e.target.value)}>
              {oauthKinds.map((k) => (
                <option key={k.typeId} value={k.typeId}>
                  {k.displayName}
                </option>
              ))}
            </SelectField>
          )}
        </div>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-fg-muted">Label</Label>
          <Input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={fieldClass}
          />
        </Field>
      </div>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-fg-muted">Client ID</Label>
          <Input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={fieldMonoClass}
          />
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-fg-muted">
            Client secret
            {mode === "edit" ? (
              <span className="ml-1 font-normal text-fg-faint">(leave blank to keep current)</span>
            ) : null}
          </Label>
          <Input
            required={mode !== "edit"}
            type="password"
            autoComplete="off"
            placeholder={mode === "edit" ? "•••••••• (unchanged)" : undefined}
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className={fieldMonoClass}
          />
        </Field>
      </div>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Scopes (space-separated)</Label>
        <Input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          className={fieldMonoClass}
        />
        <p className="text-xs text-fg-muted">
          Pre-filled per kind. Only edit if you need extra capability beyond the defaults.
        </p>
      </Field>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Base URL / tenant (optional)</Label>
        <Input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={baseUrlHint}
          className={fieldClass}
        />
        <p className="text-xs text-fg-muted">
          GitHub Enterprise base URL (e.g.{" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">
            https://github.example.com
          </code>
          ), or the Entra tenant id for Azure DevOps. Blank ={" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">github.com</code> /
          multi-tenant <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">common</code>.
        </p>
      </Field>

      {error ? <p className={errorMessageClass}>{error}</p> : null}

      <div className="flex gap-2">
        <button type="submit" disabled={pending} className={primaryButtonClass}>
          {pending
            ? mode === "edit"
              ? "Saving…"
              : "Creating…"
            : mode === "edit"
              ? "Save"
              : "Create"}
        </button>
        {mode === "edit" ? (
          <button
            type="button"
            onClick={() => props.onDone?.()}
            disabled={pending}
            className={secondaryButtonClass}
          >
            Cancel
          </button>
        ) : null}
      </div>
    </form>
  );
}
