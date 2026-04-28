"use client";

import { Field, Input, Label } from "@headlessui/react";
import { fieldClass, fieldMonoClass } from "@/lib/form-classes";
import { ProviderToggle } from "@/ui/setup/provider-toggle";

export type AzdoStepState = {
  enabled: boolean;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  tenantId: string;
};

export type AzdoStepHandlers = {
  setEnabled: (next: boolean) => void;
  setLabel: (next: string) => void;
  setClientId: (next: string) => void;
  setClientSecret: (next: string) => void;
  setScopes: (next: string) => void;
  setTenantId: (next: string) => void;
};

export function StepAzdo({
  state,
  handlers,
  alreadyConfigured,
  callbackUrl,
}: {
  state: AzdoStepState;
  handlers: AzdoStepHandlers;
  alreadyConfigured: boolean;
  callbackUrl: string;
}) {
  return (
    <ProviderToggle
      label="Azure DevOps"
      checked={state.enabled}
      disabled={alreadyConfigured}
      alreadyConfigured={alreadyConfigured}
      onChange={handlers.setEnabled}
      help={
        <>
          Register an Entra app at{" "}
          <a
            className="underline underline-offset-2"
            href="https://entra.microsoft.com"
            target="_blank"
            rel="noreferrer"
          >
            entra.microsoft.com
          </a>
          . Add a Web redirect URI:{" "}
          <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">{callbackUrl}</code>
        </>
      }
    >
      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Display label</Label>
        <Input
          value={state.label}
          onChange={(e) => handlers.setLabel(e.target.value)}
          placeholder="Azure DevOps"
          className={fieldClass}
          autoComplete="off"
          required={state.enabled}
        />
      </Field>

      <div className="flex gap-3">
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-fg-muted">Application (client) ID</Label>
          <Input
            value={state.clientId}
            onChange={(e) => handlers.setClientId(e.target.value)}
            placeholder="11111111-2222-3333-4444-555555555555"
            className={fieldMonoClass}
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-fg-faint">UUID shown on the app's Overview page.</p>
        </Field>
        <Field className="flex flex-1 flex-col gap-1">
          <Label className="text-xs text-fg-muted">Client secret value</Label>
          <Input
            type="password"
            value={state.clientSecret}
            onChange={(e) => handlers.setClientSecret(e.target.value)}
            placeholder="A1bC~2dEfGhIjKlMnOp.QrStUvWxYz0123456789"
            className={fieldMonoClass}
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-fg-faint">
            Use the <em>value</em>, not the secret id. ~40 chars, may include{" "}
            <code className="font-mono">~</code>, <code className="font-mono">-</code>,{" "}
            <code className="font-mono">.</code>.
          </p>
        </Field>
      </div>

      <Field className="flex flex-col gap-1">
        <Label className="text-xs text-fg-muted">Directory (tenant) ID</Label>
        <Input
          value={state.tenantId}
          onChange={(e) => handlers.setTenantId(e.target.value)}
          placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
          className={fieldMonoClass}
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-fg-faint">
          UUID. Found on the Entra tenant overview page; required so the OAuth endpoints resolve
          correctly.
        </p>
      </Field>

      <details className="rounded-xl border border-border bg-surface p-3">
        <summary className="cursor-pointer select-none text-xs font-medium text-fg-muted">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <Field className="flex flex-col gap-1">
            <Label className="text-xs text-fg-muted">Scopes (space-separated)</Label>
            <Input
              value={state.scopes}
              onChange={(e) => handlers.setScopes(e.target.value)}
              className={fieldMonoClass}
              autoComplete="off"
            />
            <p className="text-xs text-fg-faint">
              Default is the AzDO v6 work-items scope plus offline access for refresh tokens.
            </p>
          </Field>
        </div>
      </details>
    </ProviderToggle>
  );
}
