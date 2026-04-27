"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { errorMessageClass, primaryButtonClass, settingsPanelClass } from "@/lib/form-classes";
import { parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { StepAzdo } from "@/ui/setup/step-azdo";
import { StepGithub } from "@/ui/setup/step-github";
import { StepOpenai } from "@/ui/setup/step-openai";
import { type StepperStep, WizardStepper } from "@/ui/setup/wizard-stepper";
import { WizardWelcome } from "@/ui/setup/wizard-welcome";

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
    return <WizardWelcome onStart={() => setStarted(true)} />;
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-6">
      <WizardStepper steps={steps} activeIndex={activeIndex} />

      <section className={`${settingsPanelClass} flex flex-col gap-4`}>
        <header className="flex flex-col gap-1">
          <h2 className="text-base font-medium text-fg">Sign-in providers</h2>
          <p className="text-xs text-fg-muted">
            Pick at least one. You can add more later in{" "}
            <code className="font-mono">/settings</code>.
          </p>
        </header>

        <StepGithub
          state={{
            enabled: githubEnabled,
            label: ghLabel,
            clientId: ghClientId,
            clientSecret: ghClientSecret,
            scopes: ghScopes,
            baseUrl: ghBaseUrl,
          }}
          handlers={{
            setEnabled: setGithubEnabled,
            setLabel: setGhLabel,
            setClientId: setGhClientId,
            setClientSecret: setGhClientSecret,
            setScopes: setGhScopes,
            setBaseUrl: setGhBaseUrl,
          }}
          alreadyConfigured={hasGithub}
          callbackUrl={githubCallback}
        />

        <StepAzdo
          state={{
            enabled: azdoEnabled,
            label: azdoLabel,
            clientId: azdoClientId,
            clientSecret: azdoClientSecret,
            scopes: azdoScopes,
            tenantId: azdoTenantId,
          }}
          handlers={{
            setEnabled: setAzdoEnabled,
            setLabel: setAzdoLabel,
            setClientId: setAzdoClientId,
            setClientSecret: setAzdoClientSecret,
            setScopes: setAzdoScopes,
            setTenantId: setAzdoTenantId,
          }}
          alreadyConfigured={hasAzureDevops}
          callbackUrl={azdoCallback}
        />

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

        <StepOpenai
          state={{
            enabled: openaiEnabled,
            label: openaiLabel,
            apiKey: openaiKey,
            model: openaiModel,
            baseUrl: openaiBaseUrl,
            inputPrice: openaiInputPrice,
            outputPrice: openaiOutputPrice,
          }}
          handlers={{
            setEnabled: setOpenaiEnabled,
            setLabel: setOpenaiLabel,
            setApiKey: setOpenaiKey,
            setModel: setOpenaiModel,
            setBaseUrl: setOpenaiBaseUrl,
            setInputPrice: setOpenaiInputPrice,
            setOutputPrice: setOpenaiOutputPrice,
          }}
          alreadyConfigured={hasOpenai}
        />
      </section>

      {submit.error ? <p className={errorMessageClass}>{submit.error.message}</p> : null}

      <button type="submit" disabled={!canSubmit} className={`${primaryButtonClass} self-start`}>
        {submit.isPending ? "Saving…" : "Finish setup"}
      </button>
    </form>
  );
}
