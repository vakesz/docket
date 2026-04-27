"use client";
import { type FormEvent, useId, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { SelectField } from "@/ui/forms/select-field";

const KINDS = ["github", "azure_devops"] as const;
type Kind = (typeof KINDS)[number];

const DEFAULTS: Record<Kind, { label: string; scopes: string; baseUrlHint: string }> = {
  github: {
    label: "GitHub",
    scopes: "read:user user:email repo",
    baseUrlHint: "GitHub Enterprise base URL (leave blank for github.com)",
  },
  azure_devops: {
    label: "Azure DevOps",
    scopes: "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    baseUrlHint: "Entra tenant id (leave blank for `common` / multi-tenant)",
  },
};

export function OauthProviderForm() {
  const utils = trpc.useUtils();
  const create = trpc.oauthProviders.create.useMutation({
    onSuccess: async () => {
      setLabel(DEFAULTS[kind].label);
      setClientId("");
      setClientSecret("");
      setScopes(DEFAULTS[kind].scopes);
      setBaseUrl("");
      await utils.oauthProviders.list.invalidate();
    },
  });

  const kindId = useId();
  const [kind, setKind] = useState<Kind>("github");
  const [label, setLabel] = useState(DEFAULTS.github.label);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [scopes, setScopes] = useState(DEFAULTS.github.scopes);
  const [baseUrl, setBaseUrl] = useState("");

  function onKindChange(next: Kind) {
    setKind(next);
    // Reset the kind-specific defaults so the user doesn't have to remember
    // GitHub's scopes when they flip to AzDO and vice versa.
    setLabel(DEFAULTS[next].label);
    setScopes(DEFAULTS[next].scopes);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    create.mutate({
      kind,
      label: label.trim(),
      clientId: clientId.trim(),
      clientSecret: clientSecret.trim(),
      scopes: scopes.trim(),
      baseUrl: baseUrl.trim(),
    });
  }

  return (
    <form onSubmit={onSubmit} className={`${settingsPanelClass} flex flex-col gap-4 text-sm`}>
      <h2 className="text-base font-medium text-fg">Add OAuth provider</h2>

      <div className="flex gap-3">
        <div className="flex w-40 flex-col gap-1">
          <label htmlFor={kindId} className="text-xs text-fg-muted">
            Kind
          </label>
          <SelectField
            id={kindId}
            value={kind}
            onChange={(e) => onKindChange(e.target.value as Kind)}
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {k.replace("_", " ")}
              </option>
            ))}
          </SelectField>
        </div>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Label</span>
          <input
            required
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            className={fieldClass}
          />
        </label>
      </div>

      <div className="flex gap-3">
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Client ID</span>
          <input
            required
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={fieldMonoClass}
          />
        </label>
        <label className="flex flex-1 flex-col gap-1">
          <span className="text-xs text-fg-muted">Client secret</span>
          <input
            required
            type="password"
            autoComplete="off"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            className={fieldMonoClass}
          />
        </label>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Scopes (space-separated)</span>
        <input
          value={scopes}
          onChange={(e) => setScopes(e.target.value)}
          className={fieldMonoClass}
        />
        <p className="text-xs text-fg-muted">
          Pre-filled per kind. Only edit if you need extra capability beyond the defaults.
        </p>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-fg-muted">Base URL / tenant (optional)</span>
        <input
          value={baseUrl}
          onChange={(e) => setBaseUrl(e.target.value)}
          placeholder={DEFAULTS[kind].baseUrlHint}
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
      </label>

      {create.error ? <p className={errorMessageClass}>{create.error.message}</p> : null}

      <button
        type="submit"
        disabled={create.isPending}
        className={`${primaryButtonClass} self-start`}
      >
        {create.isPending ? "Creating…" : "Create"}
      </button>
    </form>
  );
}
