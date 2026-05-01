"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { StepAzdo } from "@/ui/setup/step-azdo";
import { StepGithub } from "@/ui/setup/step-github";
import { type OpenaiRole, type OpenaiStepState, StepOpenai } from "@/ui/setup/step-openai";
import { type StepperStep, WizardStepper } from "@/ui/setup/wizard-stepper";
import { WizardWelcome } from "@/ui/setup/wizard-welcome";

type Props = {
  publicBaseUrl: string;
  /** Pre-existing rows so we can hide subsections that are already configured. */
  hasGithub: boolean;
  hasAzureDevops: boolean;
  /** Deployment already has a `kind=openai, role=chat` row — wizard skips chat slots that match. */
  hasOpenaiChat: boolean;
  /** Deployment already has a `kind=openai, role=guardrail` row. */
  hasOpenaiGuardrail: boolean;
  /**
   * Visual-only mode: validation gates are bypassed (Next + Finish always
   * enabled) and Finish is a no-op so the wizard can be clicked end-to-end
   * without writing rows. Used by `/setup-preview`.
   */
  previewMode?: boolean;
};

type LlmDraft = OpenaiStepState & {
  /** Stable key for React reconciliation — array index would shift on remove. */
  uid: string;
};

let llmDraftCounter = 0;
function nextDraftUid(): string {
  llmDraftCounter += 1;
  return `llm-${llmDraftCounter}`;
}

function newDraft(role: OpenaiRole): LlmDraft {
  return {
    uid: nextDraftUid(),
    enabled: true,
    role,
    label: role === "guardrail" ? "OpenAI guardrail" : "OpenAI",
    apiKey: "",
    model: role === "guardrail" ? "gpt-5-nano" : "gpt-5",
    baseUrl: "",
    inputPrice: "",
    outputPrice: "",
  };
}

export function SetupWizardForm({
  publicBaseUrl,
  hasGithub,
  hasAzureDevops,
  hasOpenaiChat,
  hasOpenaiGuardrail,
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

  // Initial LLM lineup: just the chat draft. The "+ Add another LLM" button
  // appends extra drafts (e.g. guardrail) when the operator wants more —
  // most deployments only need a chat row up front and add the guardrail
  // later from /settings, so we don't pre-populate it here. The chat draft
  // starts disabled when a chat row already exists so the form doesn't
  // pretend to ask for something bootstrap will skip anyway.
  const [llms, setLlms] = useState<LlmDraft[]>(() => [
    { ...newDraft("chat"), enabled: !hasOpenaiChat },
  ]);

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

  function isAlreadyConfiguredFor(role: OpenaiRole): boolean {
    return role === "guardrail" ? hasOpenaiGuardrail : hasOpenaiChat;
  }
  function llmDraftFilled(d: LlmDraft): boolean {
    return Boolean(d.enabled && !isAlreadyConfiguredFor(d.role) && d.apiKey.trim());
  }
  // A draft is "valid for submit" if it's either skipped (disabled / pre-configured)
  // or fully filled. Half-filled drafts (toggle on but no apiKey) gate the Next button.
  const llmsAllValid = llms.every((d) => {
    if (!d.enabled) return true;
    if (isAlreadyConfiguredFor(d.role)) return true;
    return d.apiKey.trim().length > 0;
  });
  // Block "two enabled chat drafts" / "two enabled guardrail drafts" — bootstrap
  // would skip the second one anyway, but the operator deserves a clearer signal.
  const seenRoles = new Set<OpenaiRole>();
  let llmsHaveRoleConflict = false;
  for (const d of llms) {
    if (!d.enabled || isAlreadyConfiguredFor(d.role)) continue;
    if (seenRoles.has(d.role)) {
      llmsHaveRoleConflict = true;
      break;
    }
    seenRoles.add(d.role);
  }
  const llmsSatisfied = llmsAllValid && !llmsHaveRoleConflict;

  const canSubmit = !submit.isPending && oauthSatisfied && llmsSatisfied;

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
  const llmGate = previewMode || llmsSatisfied;
  const finishGate = previewMode || canSubmit;

  function updateLlm(index: number, patch: Partial<LlmDraft>) {
    setLlms((prev) => prev.map((d, i) => (i === index ? { ...d, ...patch } : d)));
  }
  function addLlm() {
    setLlms((prev) => {
      // Prefer guardrail when none exists yet — most operators reach for
      // "add another" specifically because they want to fill the other role.
      const hasGuardrailDraft = prev.some((d) => d.role === "guardrail");
      const nextRole: OpenaiRole = hasGuardrailDraft ? "chat" : "guardrail";
      return [...prev, newDraft(nextRole)];
    });
  }
  function removeLlm(index: number) {
    setLlms((prev) => prev.filter((_, i) => i !== index));
  }

  const filledLlms = llms.filter(llmDraftFilled);
  const enabledLlms = llms.filter((d) => d.enabled && !isAlreadyConfiguredFor(d.role));

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
      llms: filledLlms.map((d) => ({
        role: d.role,
        label: d.label.trim(),
        apiKey: d.apiKey.trim(),
        model: d.model.trim(),
        baseUrl: d.baseUrl.trim(),
        inputPriceCentsPerMtok: parsePriceDollarsToCents(d.inputPrice),
        outputPriceCentsPerMtok: parsePriceDollarsToCents(d.outputPrice),
      })),
    });
  }

  return (
    <form
      onSubmit={onSubmit}
      className="flex min-h-full w-full flex-col items-stretch px-8 pt-10 pb-12"
    >
      <div className="mx-auto w-full max-w-2xl">
        <WizardStepper steps={steps} activeIndex={activeIndex} />
      </div>

      <div className="justify-center-safe mx-auto flex w-full max-w-2xl flex-1 items-center py-8">
        {!started ? (
          <WizardWelcome onStart={() => setStarted(true)} />
        ) : page === "oauth" ? (
          <section className="flex w-full flex-col gap-4">
            <header className="flex flex-col gap-1">
              <h2 className="font-medium text-base text-foreground">Sign-in providers</h2>
              <p className="text-muted-foreground text-xs">
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
              <Alert variant="destructive">
                <AlertDescription>
                  At least one sign-in provider must be enabled and filled in to continue.
                </AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" onClick={() => setStarted(false)}>
                Back
              </Button>
              <Button type="button" disabled={!oauthGate} onClick={() => setPage("llm")}>
                Next: LLM
              </Button>
            </div>
          </section>
        ) : page === "llm" ? (
          <section className="flex w-full flex-col gap-4">
            <header className="flex items-baseline justify-between gap-3">
              <div className="flex flex-col gap-1">
                <h2 className="font-medium text-base text-foreground">LLM providers (optional)</h2>
                <p className="text-muted-foreground text-xs">
                  Powers the agent (chat) and the prompt-injection / topic-scope classifier
                  (guardrail). Skip any role for now and add later in{" "}
                  <code className="font-mono">/settings → LLM providers</code>.
                </p>
              </div>
            </header>

            {llms.map((draft, i) => (
              <StepOpenai
                key={draft.uid}
                {...(llms.length > 1 ? { index: i + 1 } : {})}
                state={draft}
                handlers={{
                  setEnabled: (next) => updateLlm(i, { enabled: next }),
                  setRole: (next) => updateLlm(i, { role: next }),
                  setLabel: (next) => updateLlm(i, { label: next }),
                  setApiKey: (next) => updateLlm(i, { apiKey: next }),
                  setModel: (next) => updateLlm(i, { model: next }),
                  setBaseUrl: (next) => updateLlm(i, { baseUrl: next }),
                  setInputPrice: (next) => updateLlm(i, { inputPrice: next }),
                  setOutputPrice: (next) => updateLlm(i, { outputPrice: next }),
                }}
                alreadyConfigured={isAlreadyConfiguredFor(draft.role)}
                {...(llms.length > 1 ? { onRemove: () => removeLlm(i) } : {})}
              />
            ))}

            {llmsHaveRoleConflict ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Two enabled drafts share the same role. Disable one or change its role — the
                  wizard writes at most one row per role.
                </AlertDescription>
              </Alert>
            ) : null}

            <Button
              type="button"
              variant="outline"
              size="xs"
              onClick={addLlm}
              className="self-start"
            >
              + Add another LLM
            </Button>

            <div className="flex items-center justify-between">
              <Button type="button" variant="outline" onClick={() => setPage("oauth")}>
                Back
              </Button>
              <Button type="button" disabled={!llmGate} onClick={() => setPage("done")}>
                Next: Finish
              </Button>
            </div>
          </section>
        ) : (
          <section className="flex w-full flex-col gap-6">
            <header className="flex flex-col gap-1">
              <h2 className="font-medium text-base text-foreground">
                {submitDone ? "Setup complete" : "Review and confirm"}
              </h2>
              <p className="text-muted-foreground text-xs">
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
                title="Chat LLM"
                value={summarizeLlmFor("chat", filledLlms, enabledLlms, hasOpenaiChat)}
              />
              <SummaryRow
                title="Guardrail LLM"
                value={summarizeLlmFor("guardrail", filledLlms, enabledLlms, hasOpenaiGuardrail)}
              />
            </dl>

            {submit.error ? (
              <Alert variant="destructive">
                <AlertDescription>{submit.error.message}</AlertDescription>
              </Alert>
            ) : null}

            <div className="flex items-center justify-between">
              <Button
                type="button"
                variant="outline"
                onClick={() => setPage("llm")}
                disabled={submit.isPending}
              >
                Back
              </Button>
              <Button type="submit" disabled={!finishGate || submitDone}>
                {submitDone
                  ? "Confirmed"
                  : previewMode
                    ? "Confirm (preview, no-op)"
                    : submit.isPending
                      ? "Saving…"
                      : "Confirm setup"}
              </Button>
            </div>
          </section>
        )}
      </div>
    </form>
  );
}

function SummaryRow({ title, value }: { title: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-border border-t pt-3 first:border-t-0 first:pt-0">
      <dt className="font-medium text-muted-foreground text-xs uppercase tracking-wide">{title}</dt>
      <dd className="text-foreground text-sm">{value}</dd>
    </div>
  );
}

function summarizeLlmFor(
  role: OpenaiRole,
  filled: readonly LlmDraft[],
  enabled: readonly LlmDraft[],
  alreadyConfigured: boolean,
): string {
  if (alreadyConfigured) return "Already configured";
  const filledMatch = filled.find((d) => d.role === role);
  if (filledMatch) {
    const label =
      filledMatch.label.trim() || (role === "guardrail" ? "OpenAI guardrail" : "OpenAI");
    const fallbackModel = role === "guardrail" ? "gpt-5-nano" : "gpt-5";
    return `${label} — ${filledMatch.model.trim() || fallbackModel}`;
  }
  // Toggle on but apiKey blank — surfaces a "won't be created" hint instead of a silent skip.
  const enabledMatch = enabled.find((d) => d.role === role);
  if (enabledMatch && !enabledMatch.apiKey.trim()) return "Skipped (API key blank)";
  return "Skipped (add later in /settings)";
}
