"use client";

import { useId } from "react";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
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
  const labelId = useId();
  const clientIdId = useId();
  const clientSecretId = useId();
  const tenantIdId = useId();
  const scopesId = useId();

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
          <code className="rounded bg-muted px-1 py-0.5 font-mono">{callbackUrl}</code>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={labelId} className="text-muted-foreground text-xs">
          Display label
        </Label>
        <Input
          id={labelId}
          value={state.label}
          onChange={(e) => handlers.setLabel(e.target.value)}
          placeholder="Azure DevOps"
          autoComplete="off"
          required={state.enabled}
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientIdId} className="text-muted-foreground text-xs">
            Application (client) ID
          </Label>
          <Input
            id={clientIdId}
            value={state.clientId}
            onChange={(e) => handlers.setClientId(e.target.value)}
            placeholder="11111111-2222-3333-4444-555555555555"
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-muted-foreground/70 text-xs">UUID shown on the app's Overview page.</p>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientSecretId} className="text-muted-foreground text-xs">
            Client secret value
          </Label>
          <Input
            id={clientSecretId}
            type="password"
            value={state.clientSecret}
            onChange={(e) => handlers.setClientSecret(e.target.value)}
            placeholder="A1bC~2dEfGhIjKlMnOp.QrStUvWxYz0123456789"
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-muted-foreground/70 text-xs">
            Use the <em>value</em>, not the secret id. ~40 chars, may include{" "}
            <code className="font-mono">~</code>, <code className="font-mono">-</code>,{" "}
            <code className="font-mono">.</code>.
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <Label htmlFor={tenantIdId} className="text-muted-foreground text-xs">
          Directory (tenant) ID
        </Label>
        <Input
          id={tenantIdId}
          value={state.tenantId}
          onChange={(e) => handlers.setTenantId(e.target.value)}
          placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
          className="font-mono"
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-muted-foreground/70 text-xs">
          UUID. Found on the Entra tenant overview page; required so the OAuth endpoints resolve
          correctly.
        </p>
      </div>

      <details className="flex flex-col gap-3">
        <summary className="cursor-pointer select-none font-medium text-muted-foreground text-xs hover:text-foreground">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={scopesId} className="text-muted-foreground text-xs">
              Scopes (space-separated)
            </Label>
            <Input
              id={scopesId}
              value={state.scopes}
              onChange={(e) => handlers.setScopes(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
            <p className="text-muted-foreground/70 text-xs">
              Default is the AzDO v6 work-items scope plus offline access for refresh tokens.
            </p>
          </div>
        </div>
      </details>
    </ProviderToggle>
  );
}
