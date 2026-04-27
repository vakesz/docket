"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import {
  errorMessageClass,
  fieldClass,
  fieldMonoClass,
  primaryButtonClass,
  settingsPanelClass,
} from "@/lib/form-classes";
import { trpc } from "@/lib/trpc-client";
import { DocketLogo } from "@/ui/setup/docket-logo";
import { ThemePicker } from "@/ui/shell/theme-picker";

const OPENAI_MODEL_SUGGESTIONS = [
  "gpt-5",
  "gpt-5-mini",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4.1",
  "gpt-4.1-mini",
] as const;

/**
 * Parse "$ per Mtok" form input into cents-per-Mtok for the bootstrap
 * mutation. Mirrors `src/ui/settings/llm-provider-form.tsx` so paste-from-
 * vendor-pricing-page works the same here.
 */
function parsePriceDollarsToCents(raw: string): number | null {
  const trimmed = raw.trim().replace(",", ".");
  if (trimmed.length === 0) return null;
  const dollars = Number(trimmed);
  if (!Number.isFinite(dollars) || dollars < 0) return null;
  return Math.round(dollars * 100);
}

type Props = {
  publicBaseUrl: string;
  /** Pre-existing rows so we can hide subsections that are already configured. */
  hasGithub: boolean;
  hasAzureDevops: boolean;
  hasOpenai: boolean;
};

export function SetupWizardForm({ publicBaseUrl, hasGithub, hasAzureDevops, hasOpenai }: Props) {
  const router = useRouter();
  const githubCallback = `${publicBaseUrl.replace(/\/$/, "")}/api/auth/callback/github`;
  const azdoCallback = `${publicBaseUrl.replace(/\/$/, "")}/api/auth/callback/azure_devops`;

  // Two-stage layout: a "welcome" splash (logo + theme picker + start
  // button) followed by the actual configuration form. Keeps the first
  // impression simple while letting users tweak appearance before they
  // commit to filling in OAuth credentials.
  const [started, setStarted] = useState(false);

  // GitHub starts enabled if not already configured (most common path).
  const [githubEnabled, setGithubEnabled] = useState(!hasGithub);
  const [ghLabel, setGhLabel] = useState("GitHub");
  const [ghClientId, setGhClientId] = useState("");
  const [ghClientSecret, setGhClientSecret] = useState("");
  const [ghScopes, setGhScopes] = useState("read:user user:email repo");
  const [ghBaseUrl, setGhBaseUrl] = useState("");

  const [azdoEnabled, setAzdoEnabled] = useState(false);
  const [azdoLabel, setAzdoLabel] = useState("Azure DevOps");
  const [azdoClientId, setAzdoClientId] = useState("");
  const [azdoClientSecret, setAzdoClientSecret] = useState("");
  const [azdoScopes, setAzdoScopes] = useState(
    "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
  );
  const [azdoTenantId, setAzdoTenantId] = useState("");

  const [openaiEnabled, setOpenaiEnabled] = useState(!hasOpenai);
  const [openaiLabel, setOpenaiLabel] = useState("OpenAI");
  const [openaiKey, setOpenaiKey] = useState("");
  const [openaiModel, setOpenaiModel] = useState("gpt-5");
  const [openaiBaseUrl, setOpenaiBaseUrl] = useState("");
  const [openaiInputPrice, setOpenaiInputPrice] = useState("");
  const [openaiOutputPrice, setOpenaiOutputPrice] = useState("");

  const submit = trpc.setup.bootstrap.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  const githubFilled = Boolean(githubEnabled && ghClientId.trim() && ghClientSecret.trim());
  const azdoFilled = Boolean(
    azdoEnabled && azdoClientId.trim() && azdoClientSecret.trim() && azdoTenantId.trim(),
  );
  const oauthSatisfied = hasGithub || hasAzureDevops || githubFilled || azdoFilled;
  const openaiFilled = Boolean(openaiEnabled && openaiKey.trim());
  const openaiSatisfied = !openaiEnabled || openaiFilled;

  const canSubmit = !submit.isPending && oauthSatisfied && openaiSatisfied;

  const oauthDone = oauthSatisfied;
  const llmDone = hasOpenai || openaiFilled || !openaiEnabled;
  const submitDone = submit.isSuccess;
  const steps: StepperStep[] = [
    {
      title: "Sign-in",
      detail: oauthDone ? "Ready" : "At least one OAuth provider",
      done: oauthDone,
    },
    {
      title: "LLM",
      detail: hasOpenai
        ? "Configured"
        : openaiEnabled
          ? openaiFilled
            ? "Ready"
            : "Add an API key"
          : "Skipping (add later)",
      done: llmDone,
    },
    {
      title: "Finish",
      detail: submitDone ? "Done" : canSubmit ? "Submit to continue" : "Complete previous steps",
      done: submitDone,
    },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    submit.mutate({
      github:
        githubEnabled && githubFilled
          ? {
              label: ghLabel.trim(),
              clientId: ghClientId.trim(),
              clientSecret: ghClientSecret.trim(),
              scopes: ghScopes.trim(),
              baseUrl: ghBaseUrl.trim(),
            }
          : null,
      azureDevops:
        azdoEnabled && azdoFilled
          ? {
              label: azdoLabel.trim(),
              clientId: azdoClientId.trim(),
              clientSecret: azdoClientSecret.trim(),
              scopes: azdoScopes.trim(),
              tenantId: azdoTenantId.trim(),
            }
          : null,
      openai:
        openaiEnabled && openaiFilled
          ? {
              label: openaiLabel.trim(),
              apiKey: openaiKey.trim(),
              model: openaiModel.trim(),
              baseUrl: openaiBaseUrl.trim(),
              inputPriceCentsPerMtok: parsePriceDollarsToCents(openaiInputPrice),
              outputPriceCentsPerMtok: parsePriceDollarsToCents(openaiOutputPrice),
            }
          : null,
    });
  }

  if (!started) {
    return (
      <div className="flex flex-col items-center gap-8 py-6 text-center">
        <DocketLogo className="h-20 w-20" />
        <div className="flex flex-col items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight text-fg">Welcome to Docket</h1>
          <p className="max-w-md text-sm text-fg-muted">
            Browser-first work-item triage. We&rsquo;ll get you signed in and (optionally) talking
            to an LLM. Takes a minute.
          </p>
        </div>
        <div className="flex flex-col items-center gap-1.5">
          <span className="text-xs uppercase tracking-wide text-fg-faint">Theme</span>
          <ThemePicker />
        </div>
        <button type="button" onClick={() => setStarted(true)} className={primaryButtonClass}>
          Let&rsquo;s set things up
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <Stepper steps={steps} activeIndex={activeIndex} />

      <section className={`${settingsPanelClass} flex flex-col gap-4`}>
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-fg">Sign-in providers</h2>
          <p className="text-xs text-fg-muted">
            Pick at least one. You can add more later in{" "}
            <code className="font-mono">/settings</code>.
          </p>
        </header>

        <ProviderToggle
          label="GitHub OAuth App"
          checked={githubEnabled}
          disabled={hasGithub}
          alreadyConfigured={hasGithub}
          onChange={setGithubEnabled}
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
              <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">{githubCallback}</code>
            </>
          }
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Display label</span>
            <input
              value={ghLabel}
              onChange={(e) => setGhLabel(e.target.value)}
              placeholder="GitHub"
              className={fieldClass}
              autoComplete="off"
              required={githubEnabled}
            />
            <p className="text-xs text-fg-faint">
              Shown on the sign-in button. Useful when running multiple GitHub Enterprise instances.
            </p>
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Client ID</span>
              <input
                value={ghClientId}
                onChange={(e) => setGhClientId(e.target.value)}
                placeholder="Iv23liab1cd2EFG3hijK"
                className={fieldMonoClass}
                autoComplete="off"
                required={githubEnabled}
              />
              <p className="text-xs text-fg-faint">
                20 chars, starts with <code className="font-mono">Iv1.</code> (legacy) or{" "}
                <code className="font-mono">Iv23li</code> (new apps).
              </p>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Client secret</span>
              <input
                type="password"
                value={ghClientSecret}
                onChange={(e) => setGhClientSecret(e.target.value)}
                placeholder="abc1234567890def1234567890ghijklmnopqrst"
                className={fieldMonoClass}
                autoComplete="off"
                required={githubEnabled}
              />
              <p className="text-xs text-fg-faint">
                40-char hex string from the OAuth App page. Stored AES-GCM encrypted.
              </p>
            </label>
          </div>

          <details className="rounded-xl border border-border bg-surface p-3">
            <summary className="cursor-pointer select-none text-xs font-medium text-fg-muted">
              Advanced
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">Scopes (space-separated)</span>
                <input
                  value={ghScopes}
                  onChange={(e) => setGhScopes(e.target.value)}
                  className={fieldMonoClass}
                  autoComplete="off"
                />
                <p className="text-xs text-fg-faint">
                  Default covers sign-in + repo access. Trim if you only need read access.
                </p>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">Enterprise base URL</span>
                <input
                  value={ghBaseUrl}
                  onChange={(e) => setGhBaseUrl(e.target.value)}
                  placeholder="https://github.example.com"
                  className={fieldClass}
                  autoComplete="off"
                />
                <p className="text-xs text-fg-faint">
                  Leave blank for github.com. Only fill in for GitHub Enterprise Server.
                </p>
              </label>
            </div>
          </details>
        </ProviderToggle>

        <ProviderToggle
          label="Azure DevOps"
          checked={azdoEnabled}
          disabled={hasAzureDevops}
          alreadyConfigured={hasAzureDevops}
          onChange={setAzdoEnabled}
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
              <code className="rounded bg-surface-alt px-1 py-0.5 font-mono">{azdoCallback}</code>
            </>
          }
        >
          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Display label</span>
            <input
              value={azdoLabel}
              onChange={(e) => setAzdoLabel(e.target.value)}
              placeholder="Azure DevOps"
              className={fieldClass}
              autoComplete="off"
              required={azdoEnabled}
            />
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Application (client) ID</span>
              <input
                value={azdoClientId}
                onChange={(e) => setAzdoClientId(e.target.value)}
                placeholder="11111111-2222-3333-4444-555555555555"
                className={fieldMonoClass}
                autoComplete="off"
                required={azdoEnabled}
              />
              <p className="text-xs text-fg-faint">UUID shown on the app's Overview page.</p>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Client secret value</span>
              <input
                type="password"
                value={azdoClientSecret}
                onChange={(e) => setAzdoClientSecret(e.target.value)}
                placeholder="A1bC~2dEfGhIjKlMnOp.QrStUvWxYz0123456789"
                className={fieldMonoClass}
                autoComplete="off"
                required={azdoEnabled}
              />
              <p className="text-xs text-fg-faint">
                Use the <em>value</em>, not the secret id. ~40 chars, may include{" "}
                <code className="font-mono">~</code>, <code className="font-mono">-</code>,{" "}
                <code className="font-mono">.</code>.
              </p>
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Directory (tenant) ID</span>
            <input
              value={azdoTenantId}
              onChange={(e) => setAzdoTenantId(e.target.value)}
              placeholder="aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
              className={fieldMonoClass}
              autoComplete="off"
              required={azdoEnabled}
            />
            <p className="text-xs text-fg-faint">
              UUID. Found on the Entra tenant overview page; required so the OAuth endpoints resolve
              correctly.
            </p>
          </label>

          <details className="rounded-xl border border-border bg-surface p-3">
            <summary className="cursor-pointer select-none text-xs font-medium text-fg-muted">
              Advanced
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-fg-muted">Scopes (space-separated)</span>
                <input
                  value={azdoScopes}
                  onChange={(e) => setAzdoScopes(e.target.value)}
                  className={fieldMonoClass}
                  autoComplete="off"
                />
                <p className="text-xs text-fg-faint">
                  Default is the AzDO v6 work-items scope plus offline access for refresh tokens.
                </p>
              </label>
            </div>
          </details>
        </ProviderToggle>

        {!oauthSatisfied ? (
          <p className={errorMessageClass}>
            At least one sign-in provider must be enabled and filled in to continue.
          </p>
        ) : null}
      </section>

      <section className={`${settingsPanelClass} flex flex-col gap-4`}>
        <header className="flex items-baseline justify-between gap-3">
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-medium text-fg">Default LLM (optional)</h2>
            <p className="text-xs text-fg-muted">
              Powers the agent. Skip for now and add later in{" "}
              <code className="font-mono">/settings → LLM providers</code>.
            </p>
          </div>
        </header>

        <ProviderToggle
          label="OpenAI (or OpenAI-compatible)"
          checked={openaiEnabled}
          disabled={hasOpenai}
          alreadyConfigured={hasOpenai}
          onChange={setOpenaiEnabled}
          help={null}
        >
          <aside
            role="note"
            className="rounded-2xl border border-warning/40 bg-warning-bg/40 p-4 text-xs text-warning-fg"
          >
            <p className="mb-1 font-medium">Adding an Azure AI Foundry model</p>
            <p>
              Use the project&rsquo;s OpenAI v1 endpoint as the Base URL — the path must end with{" "}
              <code className="rounded bg-surface px-1 py-0.5 font-mono text-fg">/openai/v1/</code>.
              Set <span className="font-medium">Model</span> to the deployment name shown in Foundry
              &rarr; Model deployments (for example <code className="font-mono">gpt-5</code>).
            </p>
            <p className="mt-2">Template:</p>
            <code className="mt-1 block break-all rounded bg-surface px-2 py-1 font-mono text-[0.7rem] leading-snug text-fg">
              https://&lt;resource&gt;.services.ai.azure.com/api/projects/&lt;project&gt;/openai/v1/
            </code>
          </aside>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">Display label</span>
            <input
              value={openaiLabel}
              onChange={(e) => setOpenaiLabel(e.target.value)}
              placeholder="OpenAI"
              className={fieldClass}
              autoComplete="off"
              required={openaiEnabled}
            />
            <p className="text-xs text-fg-faint">
              Shown in the model picker. Useful if you'll add multiple OpenAI-compatible endpoints.
            </p>
          </label>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-fg-muted">API key</span>
            <input
              type="password"
              value={openaiKey}
              onChange={(e) => setOpenaiKey(e.target.value)}
              placeholder="sk-proj-aBc1234567890dEfGhIjKlMnOpQrStUvWxYz"
              className={fieldMonoClass}
              autoComplete="off"
              required={openaiEnabled}
            />
            <p className="text-xs text-fg-faint">
              OpenAI keys start with <code className="font-mono">sk-</code> /{" "}
              <code className="font-mono">sk-proj-</code>. Stored AES-GCM encrypted.
            </p>
          </label>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Model</span>
              <input
                value={openaiModel}
                onChange={(e) => setOpenaiModel(e.target.value)}
                placeholder="gpt-5"
                list="setup-openai-models"
                className={fieldMonoClass}
                autoComplete="off"
                required={openaiEnabled}
              />
              <datalist id="setup-openai-models">
                {OPENAI_MODEL_SUGGESTIONS.map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
              <p className="text-xs text-fg-faint">
                Pick a suggestion or type any deployment name (Azure Foundry users — paste your
                deployment id).
              </p>
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Base URL (optional)</span>
              <input
                value={openaiBaseUrl}
                onChange={(e) => setOpenaiBaseUrl(e.target.value)}
                placeholder="https://api.openai.com/v1"
                className={fieldClass}
                autoComplete="off"
              />
              <p className="text-xs text-fg-faint">
                Blank uses OpenAI's public endpoint. Set for Azure OpenAI / Foundry / Ollama / a
                proxy.
              </p>
            </label>
          </div>

          <div className="flex gap-3">
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Input price ($ / Mtok)</span>
              <input
                type="text"
                inputMode="decimal"
                value={openaiInputPrice}
                onChange={(e) => setOpenaiInputPrice(e.target.value)}
                placeholder="2.00"
                className={fieldClass}
                autoComplete="off"
              />
            </label>
            <label className="flex flex-1 flex-col gap-1">
              <span className="text-xs text-fg-muted">Output price ($ / Mtok)</span>
              <input
                type="text"
                inputMode="decimal"
                value={openaiOutputPrice}
                onChange={(e) => setOpenaiOutputPrice(e.target.value)}
                placeholder="8.00"
                className={fieldClass}
                autoComplete="off"
              />
            </label>
          </div>
          <p className="-mt-2 text-xs text-fg-faint">
            USD per million tokens — paste the vendor's published rate as-is. Leave blank if
            unknown; budget tracking will undercount until you fill them in from{" "}
            <code className="font-mono">/settings</code>.
          </p>
        </ProviderToggle>
      </section>

      {submit.error ? <p className={errorMessageClass}>{submit.error.message}</p> : null}

      <button type="submit" disabled={!canSubmit} className={`${primaryButtonClass} self-start`}>
        {submit.isPending ? "Saving…" : "Finish setup"}
      </button>
    </form>
  );
}

type StepperStep = {
  title: string;
  detail: string;
  done: boolean;
};

function Stepper({ steps, activeIndex }: { steps: StepperStep[]; activeIndex: number }) {
  return (
    <ol className="flex items-stretch gap-2">
      {steps.map((step, i) => {
        const state = step.done
          ? "done"
          : i === activeIndex || (activeIndex === -1 && i === steps.length - 1)
            ? "active"
            : "pending";
        return (
          <li
            key={step.title}
            className={`flex flex-1 items-center gap-3 rounded-2xl border px-3 py-2 ${
              state === "done"
                ? "border-success-fg/30 bg-success-bg/30"
                : state === "active"
                  ? "border-accent/40 bg-surface-alt"
                  : "border-border bg-surface"
            }`}
          >
            <span
              aria-hidden
              className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${
                state === "done"
                  ? "bg-success-fg text-bg"
                  : state === "active"
                    ? "bg-accent text-bg"
                    : "bg-surface-alt text-fg-faint"
              }`}
            >
              {state === "done" ? "✓" : i + 1}
            </span>
            <span className="flex flex-col leading-tight">
              <span
                className={`text-sm font-medium ${state === "pending" ? "text-fg-muted" : "text-fg"}`}
              >
                {step.title}
              </span>
              <span className="text-xs text-fg-faint">{step.detail}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function ProviderToggle({
  label,
  checked,
  disabled,
  alreadyConfigured,
  onChange,
  help,
  children,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  alreadyConfigured: boolean;
  onChange: (next: boolean) => void;
  help: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-border bg-surface-alt p-4">
      <label className="flex items-baseline gap-3">
        <input
          type="checkbox"
          checked={checked}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked)}
          className="mt-1"
        />
        <span className="flex flex-1 flex-col gap-1">
          <span className="flex items-baseline gap-2">
            <span className="font-medium text-fg">{label}</span>
            {alreadyConfigured ? (
              <span className="text-xs uppercase tracking-wide text-success-fg">configured</span>
            ) : null}
          </span>
          {help ? <span className="text-xs text-fg-muted">{help}</span> : null}
        </span>
      </label>
      {checked && !disabled ? <div className="mt-4 flex flex-col gap-3">{children}</div> : null}
    </div>
  );
}
