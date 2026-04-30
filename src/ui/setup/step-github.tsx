"use client";

import { useId } from "react";
import { Input } from "@/ui/primitives/input";
import { Label } from "@/ui/primitives/label";
import { ProviderToggle } from "@/ui/setup/provider-toggle";

export type GithubStepState = {
  enabled: boolean;
  label: string;
  clientId: string;
  clientSecret: string;
  scopes: string;
  baseUrl: string;
};

export type GithubStepHandlers = {
  setEnabled: (next: boolean) => void;
  setLabel: (next: string) => void;
  setClientId: (next: string) => void;
  setClientSecret: (next: string) => void;
  setScopes: (next: string) => void;
  setBaseUrl: (next: string) => void;
};

export function StepGithub({
  state,
  handlers,
  alreadyConfigured,
  callbackUrl,
}: {
  state: GithubStepState;
  handlers: GithubStepHandlers;
  alreadyConfigured: boolean;
  callbackUrl: string;
}) {
  const labelId = useId();
  const clientIdId = useId();
  const clientSecretId = useId();
  const scopesId = useId();
  const baseUrlId = useId();

  return (
    <ProviderToggle
      label="GitHub OAuth App"
      checked={state.enabled}
      disabled={alreadyConfigured}
      alreadyConfigured={alreadyConfigured}
      onChange={handlers.setEnabled}
      help={
        <>
          Register at{" "}
          <a
            className="underline underline-offset-2"
            href="https://github.com/settings/developers"
            target="_blank"
            rel="noreferrer"
          >
            github.com/settings/developers
          </a>
          . Set the Authorization callback URL to:{" "}
          <code className="rounded bg-muted px-1 py-0.5 font-mono">{callbackUrl}</code>
        </>
      }
    >
      <div className="flex flex-col gap-1">
        <Label htmlFor={labelId} className="text-xs text-muted-foreground">
          Display label
        </Label>
        <Input
          id={labelId}
          value={state.label}
          onChange={(e) => handlers.setLabel(e.target.value)}
          placeholder="GitHub"
          autoComplete="off"
          required={state.enabled}
        />
        <p className="text-xs text-muted-foreground/70">
          Shown on the sign-in button. Useful when running multiple GitHub Enterprise instances.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientIdId} className="text-xs text-muted-foreground">
            Client ID
          </Label>
          <Input
            id={clientIdId}
            value={state.clientId}
            onChange={(e) => handlers.setClientId(e.target.value)}
            placeholder="Iv23liab1cd2EFG3hijK"
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-muted-foreground/70">
            20 chars, starts with <code className="font-mono">Iv1.</code> (legacy) or{" "}
            <code className="font-mono">Iv23li</code> (new apps).
          </p>
        </div>
        <div className="flex flex-1 flex-col gap-1">
          <Label htmlFor={clientSecretId} className="text-xs text-muted-foreground">
            Client secret
          </Label>
          <Input
            id={clientSecretId}
            type="password"
            value={state.clientSecret}
            onChange={(e) => handlers.setClientSecret(e.target.value)}
            placeholder="abc1234567890def1234567890ghijklmnopqrst"
            className="font-mono"
            autoComplete="off"
            required={state.enabled}
          />
          <p className="text-xs text-muted-foreground/70">
            40-char hex string from the OAuth App page. Stored AES-GCM encrypted.
          </p>
        </div>
      </div>

      <details className="flex flex-col gap-3">
        <summary className="cursor-pointer select-none text-xs font-medium text-muted-foreground hover:text-foreground">
          Advanced
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor={scopesId} className="text-xs text-muted-foreground">
              Scopes (space-separated)
            </Label>
            <Input
              id={scopesId}
              value={state.scopes}
              onChange={(e) => handlers.setScopes(e.target.value)}
              className="font-mono"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground/70">
              Default covers sign-in + repo access. Trim if you only need read access.
            </p>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={baseUrlId} className="text-xs text-muted-foreground">
              Enterprise base URL
            </Label>
            <Input
              id={baseUrlId}
              value={state.baseUrl}
              onChange={(e) => handlers.setBaseUrl(e.target.value)}
              placeholder="https://github.example.com"
              autoComplete="off"
            />
            <p className="text-xs text-muted-foreground/70">
              Leave blank for github.com. Only fill in for GitHub Enterprise Server.
            </p>
          </div>
        </div>
      </details>
    </ProviderToggle>
  );
}
