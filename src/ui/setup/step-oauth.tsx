"use client";

import { useId } from "react";
import type { ProviderOauthMetadata } from "@/core/provider";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { ProviderToggle } from "@/ui/setup/provider-toggle";

export type OauthStepState = {
  enabled: boolean;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  /** Provider-specific aux value — base URL or tenant id, dispatched via spec.oauth.auxSlot. */
  aux: string;
};

export type OauthStepHandlers = {
  setEnabled: (next: boolean) => void;
  setLabel: (next: string) => void;
  setClientId: (next: string) => void;
  setClientSecret: (next: string) => void;
  setScopes: (next: string) => void;
  setAux: (next: string) => void;
};

/**
 * Generic OAuth step. The wizard renders one of these per registered
 * OAuth-capable provider. All provider-specific copy comes from the
 * `ProviderOauthMetadata` block on the spec — no `if (kind === ...)`
 * branches. Adding a new OAuth provider is one new spec entry plus one
 * new entry in the wizard's `oauthSpecs` prop.
 */
export function StepOauth({
  displayName,
  oauth,
  state,
  handlers,
  alreadyConfigured,
  callbackUrl,
}: {
  displayName: string;
  oauth: ProviderOauthMetadata;
  state: OauthStepState;
  handlers: OauthStepHandlers;
  alreadyConfigured: boolean;
  callbackUrl: string;
}) {
  const labelId = useId();
  const clientIdId = useId();
  const clientSecretId = useId();
  const scopesId = useId();
  const auxId = useId();

  return (
    <ProviderToggle
      label={displayName}
      checked={state.enabled}
      disabled={alreadyConfigured}
      alreadyConfigured={alreadyConfigured}
      onChange={handlers.setEnabled}
      help={
        <>
          Register at{" "}
          <a
            className="underline underline-offset-2"
            href={oauth.registrationUrl}
            target="_blank"
            rel="noreferrer"
          >
            {oauth.registrationLabel}
          </a>
          . Set the redirect URL to:{" "}
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
          placeholder={oauth.defaultLabel}
          autoComplete="off"
          required={state.enabled}
        />
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientIdId} className="text-muted-foreground text-xs">
            Client ID
          </Label>
          <Input
            id={clientIdId}
            value={state.clientId}
            onChange={(e) => handlers.setClientId(e.target.value)}
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientSecretId} className="text-muted-foreground text-xs">
            Client secret
          </Label>
          <Input
            id={clientSecretId}
            type="password"
            value={state.clientSecret}
            onChange={(e) => handlers.setClientSecret(e.target.value)}
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-muted-foreground/70 text-xs">Stored AES-GCM encrypted.</p>
        </div>
      </div>

      {oauth.auxRequired ? (
        <div className="flex flex-col gap-1">
          <Label htmlFor={auxId} className="text-muted-foreground text-xs">
            {oauth.auxLabel}
          </Label>
          <Input
            id={auxId}
            type={oauth.auxKind === "url" ? "url" : "text"}
            value={state.aux}
            onChange={(e) => handlers.setAux(e.target.value)}
            placeholder={oauth.auxPlaceholder}
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-muted-foreground/70 text-xs">{oauth.auxHelp}</p>
        </div>
      ) : null}

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
              Default covers the provider's standard sign-in + read scopes.
            </p>
          </div>

          {!oauth.auxRequired ? (
            <div className="flex flex-col gap-1">
              <Label htmlFor={auxId} className="text-muted-foreground text-xs">
                {oauth.auxLabel}
              </Label>
              <Input
                id={auxId}
                type={oauth.auxKind === "url" ? "url" : "text"}
                value={state.aux}
                onChange={(e) => handlers.setAux(e.target.value)}
                placeholder={oauth.auxPlaceholder}
                autoComplete="off"
              />
              <p className="text-muted-foreground/70 text-xs">{oauth.auxHelp}</p>
            </div>
          ) : null}
        </div>
      </details>
    </ProviderToggle>
  );
}
