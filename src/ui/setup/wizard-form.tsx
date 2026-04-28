"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { errorMessageClass, primaryButtonClass, secondaryButtonClass } from "@/lib/form-classes";
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
  /**
   * Visual-only mode: validation gates are bypassed (Next + Finish always
   * enabled) and Finish is a no-op so the wizard can be clicked end-to-end
   * without writing rows. Used by `/setup-preview`.
   */
  previewMode?: boolean;
};

export function SetupWizardForm({
  publicBaseUrl,
  hasGithub,
  hasAzureDevops,
  hasOpenai,
  previewMode = false,
}: Props) {
  const router = useRouter();
  const githubCallback = `${publicBaseUrl.replace(/\/$/, "")}/api/auth/callback/github`;
  const azdoCallback = `${publicBaseUrl.replace(/\/$/, "")}/api/auth/callback/azure_devops`;

  // Three-stage layout: welcome splash → OAuth page → LLM page. Splitting
  // OAuth and LLM onto separate screens keeps each step focused and lets
  // the stepper's active marker match what the user is actually looking
  // at, rather than racing ahead the moment a section becomes valid.
  const [started, setStarted] = useState(false);
  const [page, setPage] = useState<"oauth" | "llm" | "done">("oauth");

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

  const submitDone = submit.isSuccess;
  const reachedDone = page === "done" || submitDone;
  const reachedLlm = page === "llm" || reachedDone;
  const steps: StepperStep[] = [
    { title: "Welcome", done: started },
    { title: "Sign-in", done: started && reachedLlm },
    { title: "LLM", done: reachedDone },
    { title: "Finish", done: submitDone },
  ];
  const activeIndex = !started ? 0 : page === "oauth" ? 1 : page === "llm" ? 2 : 3;

  const oauthGate = previewMode || oauthSatisfied;
  const finishGate = previewMode || canSubmit;

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (previewMode) return;
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

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-screen w-full flex-col items-stretch px-8 pt-10 pb-12"
    >
      <div className="mx-auto w-full max-w-2xl">
        <WizardStepper steps={steps} activeIndex={activeIndex} />
      </div>

      <div className="mx-auto flex w-full max-w-2xl flex-1 items-center justify-center py-8">
        {!started ? (
          <WizardWelcome onStart={() => setStarted(true)} />
        ) : page === "oauth" ? (
          <section className="flex w-full flex-col gap-4">
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

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setStarted(false)}
                className={secondaryButtonClass}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!oauthGate}
                onClick={() => setPage("llm")}
                className={primaryButtonClass}
              >
                Next: LLM
              </button>
            </div>
          </section>
        ) : page === "llm" ? (
          <section className="flex w-full flex-col gap-4">
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

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setPage("oauth")}
                className={secondaryButtonClass}
              >
                Back
              </button>
              <button
                type="button"
                disabled={!(previewMode || openaiSatisfied)}
                onClick={() => setPage("done")}
                className={primaryButtonClass}
              >
                Next: Finish
              </button>
            </div>
          </section>
        ) : (
          <section className="flex w-full flex-col gap-6">
            <header className="flex flex-col gap-1">
              <h2 className="text-base font-medium text-fg">
                {submitDone ? "Setup complete" : "Review and confirm"}
              </h2>
              <p className="text-xs text-fg-muted">
                {submitDone
                  ? "You can change anything later in /settings."
                  : previewMode
                    ? "Preview only — confirming is a no-op and writes nothing to the DB."
                    : "Click confirm to apply. You can change anything later in /settings."}
              </p>
            </header>

            <dl className="flex flex-col gap-3 text-sm">
              <SummaryRow
                title="GitHub"
                value={
                  hasGithub
                    ? "Already configured"
                    : githubEnabled && githubFilled
                      ? `Enabled — ${ghLabel.trim() || "GitHub"}`
                      : "Skipped"
                }
              />
              <SummaryRow
                title="Azure DevOps"
                value={
                  hasAzureDevops
                    ? "Already configured"
                    : azdoEnabled && azdoFilled
                      ? `Enabled — ${azdoLabel.trim() || "Azure DevOps"}`
                      : "Skipped"
                }
              />
              <SummaryRow
                title="LLM"
                value={
                  hasOpenai
                    ? "Already configured"
                    : openaiEnabled && openaiFilled
                      ? `${openaiLabel.trim() || "OpenAI"} — ${openaiModel.trim() || "default model"}`
                      : "Skipped (add later in /settings)"
                }
              />
            </dl>

            {submit.error ? <p className={errorMessageClass}>{submit.error.message}</p> : null}

            <div className="flex items-center justify-between">
              <button
                type="button"
                onClick={() => setPage("llm")}
                className={secondaryButtonClass}
                disabled={submit.isPending}
              >
                Back
              </button>
              <button
                type="submit"
                disabled={!finishGate || submitDone}
                className={primaryButtonClass}
              >
                {submitDone
                  ? "Confirmed"
                  : previewMode
                    ? "Confirm (preview, no-op)"
                    : submit.isPending
                      ? "Saving…"
                      : "Confirm setup"}
              </button>
            </div>
          </section>
        )}
      </div>
    </form>
  );
}

function SummaryRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-t border-border pt-3 first:border-t-0 first:pt-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-fg-muted">{title}</dt>
      <dd className="text-sm text-fg">{value}</dd>
    </div>
  );
}
