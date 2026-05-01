"use client";
import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";
import { LLM_KIND_LABELS, LLM_KIND_META, LLM_KINDS, type LlmKind } from "@/agent/llm/types";
import type { ProviderOauthMetadata } from "@/core/provider";
import { parsePriceDollarsToCents } from "@/lib/pricing";
import { trpc } from "@/lib/trpc-client";
import { Alert, AlertDescription } from "@/ui/primitives/alert";
import { Button } from "@/ui/primitives/button";
import { type LlmRole, type LlmStepState, StepLlm } from "@/ui/setup/step-llm";
import { type OauthStepState, StepOauth } from "@/ui/setup/step-oauth";
import { type StepperStep, WizardStepper } from "@/ui/setup/wizard-stepper";
import { WizardWelcome } from "@/ui/setup/wizard-welcome";

/**
 * Plain-data projection of an OAuth-capable provider spec, suitable for
 * the server → client boundary. The full `ProviderSpec` carries factories
 * and matchers that don't serialize, so the page hands us only the bits
 * the wizard renders.
 */
export type OauthCard = {
  typeId: string;
  displayName: string;
  oauth: ProviderOauthMetadata;
};

type Props = {
  publicBaseUrl: string;
  /**
   * One card per OAuth-capable provider spec. Iterated as-is — the order
   * here is the order the wizard renders the toggles.
   */
  oauthCards: readonly OauthCard[];
  /**
   * `{ [typeId]: alreadyConfigured }` for the OAuth side. Sections with a
   * truthy value render as locked-`already configured` toggles so the
   * operator can tell submitting again won't duplicate the row.
   */
  existingOauth: Record<string, boolean>;
  /**
   * `{ "<kind>:<role>": alreadyConfigured }` for the LLM side. Drafts
   * pointing at a configured (kind, role) pair render locked the same way.
   */
  existingLlm: Record<string, boolean>;
  /**
   * Visual-only mode: validation gates are bypassed (Next + Finish always
   * enabled) and Finish is a no-op so the wizard can be clicked end-to-end
   * without writing rows. Used by `/setup-preview`.
   */
  previewMode?: boolean;
};

type OauthDraft = OauthStepState & {
  /** Stable React key — array index would shift on remove (currently we
   *  don't remove OAuth drafts, but kept for parity with LLM drafts). */
  uid: string;
  card: OauthCard;
};

type LlmDraft = LlmStepState & {
  /** Stable key for React reconciliation — array index would shift on remove. */
  uid: string;
};

let llmDraftCounter = 0;
function nextDraftUid(): string {
  llmDraftCounter += 1;
  return `llm-${llmDraftCounter}`;
}

function newLlmDraft(role: LlmRole, kind: LlmKind = LLM_KINDS[0]): LlmDraft {
  const meta = LLM_KIND_META[kind];
  return {
    uid: nextDraftUid(),
    enabled: true,
    kind,
    role,
    label: meta.defaultLabelByRole[role],
    apiKey: "",
    model: meta.defaultModelByRole[role],
    baseUrl: "",
    inputPrice: "",
    outputPrice: "",
  };
}

function makeOauthDraft(card: OauthCard, alreadyConfigured: boolean): OauthDraft {
  return {
    uid: `oauth-${card.typeId}`,
    card,
    enabled: !alreadyConfigured,
    label: card.oauth.defaultLabel,
    clientId: "",
    clientSecret: "",
    scopes: card.oauth.defaultScopes,
    aux: "",
  };
}

function trimmedBaseUrl(publicBaseUrl: string): string {
  return publicBaseUrl.replace(/\/$/, "");
}

function isOauthDraftFilled(draft: OauthDraft): boolean {
  if (!draft.enabled) return false;
  if (!draft.clientId.trim() || !draft.clientSecret.trim()) return false;
  if (draft.card.oauth.auxRequired && !draft.aux.trim()) return false;
  return true;
}

export function SetupWizardForm({
  publicBaseUrl,
  oauthCards,
  existingOauth,
  existingLlm,
  previewMode = false,
}: Props) {
  const router = useRouter();
  const baseUrl = trimmedBaseUrl(publicBaseUrl);

  // Three-stage layout: welcome splash → OAuth page → LLM page. Splitting
  // OAuth and LLM onto separate screens keeps each step focused and lets
  // the stepper's active marker match what the user is actually looking
  // at, rather than racing ahead the moment a section becomes valid.
  const [started, setStarted] = useState(false);
  const [page, setPage] = useState<"oauth" | "llm" | "done">("oauth");

  // One draft per OAuth-capable spec. The first un-configured card defaults
  // to enabled (most common path is "operator picks one and ignores the
  // other"); cards already in the DB stay disabled+`already configured`.
  const [oauthDrafts, setOauthDrafts] = useState<OauthDraft[]>(() => {
    let primaryAssigned = false;
    return oauthCards.map((card) => {
      const alreadyConfigured = existingOauth[card.typeId] ?? false;
      const draft = makeOauthDraft(card, alreadyConfigured);
      if (!alreadyConfigured && !primaryAssigned) {
        primaryAssigned = true;
        draft.enabled = true;
      } else if (!alreadyConfigured) {
        draft.enabled = false;
      }
      return draft;
    });
  });

  function isLlmAlreadyConfigured(kind: LlmKind, role: LlmRole): boolean {
    return existingLlm[`${kind}:${role}`] ?? false;
  }

  // Initial LLM lineup: just a chat draft. The "+ Add another LLM" button
  // appends extras (e.g. guardrail) when the operator wants more — most
  // deployments only need a chat row up front and add the guardrail later
  // from /settings.
  const [llms, setLlms] = useState<LlmDraft[]>(() => {
    const draft = newLlmDraft("chat");
    draft.enabled = !isLlmAlreadyConfigured(draft.kind, draft.role);
    return [draft];
  });

  const submit = trpc.setup.bootstrap.useMutation({
    onSuccess: () => {
      router.refresh();
    },
  });

  const filledOauth = oauthDrafts.filter(isOauthDraftFilled);
  const anyExistingOauth = oauthCards.some((card) => existingOauth[card.typeId]);
  const oauthSatisfied = anyExistingOauth || filledOauth.length > 0;

  function llmDraftFilled(d: LlmDraft): boolean {
    if (!d.enabled) return false;
    if (isLlmAlreadyConfigured(d.kind, d.role)) return false;
    return d.apiKey.trim().length > 0;
  }

  // A draft is "valid for submit" if it's either skipped (disabled / pre-configured)
  // or fully filled. Half-filled drafts (toggle on but no apiKey) gate the Next button.
  const llmsAllValid = llms.every((d) => {
    if (!d.enabled) return true;
    if (isLlmAlreadyConfigured(d.kind, d.role)) return true;
    return d.apiKey.trim().length > 0;
  });
  // Block "two enabled drafts pointing at the same (kind, role)" — bootstrap
  // would skip the second one anyway, but the operator deserves a clearer signal.
  const seenKindRoles = new Set<string>();
  let llmsHaveRoleConflict = false;
  for (const d of llms) {
    if (!d.enabled || isLlmAlreadyConfigured(d.kind, d.role)) continue;
    const key = `${d.kind}:${d.role}`;
    if (seenKindRoles.has(key)) {
      llmsHaveRoleConflict = true;
      break;
    }
    seenKindRoles.add(key);
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

  function updateOauth(uid: string, patch: Partial<OauthStepState>) {
    setOauthDrafts((prev) => prev.map((d) => (d.uid === uid ? { ...d, ...patch } : d)));
  }

  function updateLlm(index: number, patch: Partial<LlmStepState>) {
    setLlms((prev) => {
      return prev.map((d, i) => {
        if (i !== index) return d;
        const next = { ...d, ...patch };
        // Switching kind or role retargets the per-(kind, role) defaults, but
        // only for fields the operator hasn't customized. We compare label /
        // model against the *previous* (kind, role)'s default to detect that.
        const kindChanged = patch.kind !== undefined && patch.kind !== d.kind;
        const roleChanged = patch.role !== undefined && patch.role !== d.role;
        if (kindChanged || roleChanged) {
          const prevMeta = LLM_KIND_META[d.kind];
          const nextMeta = LLM_KIND_META[next.kind];
          if (next.label === prevMeta.defaultLabelByRole[d.role]) {
            next.label = nextMeta.defaultLabelByRole[next.role];
          }
          if (next.model === prevMeta.defaultModelByRole[d.role]) {
            next.model = nextMeta.defaultModelByRole[next.role];
          }
        }
        return next;
      });
    });
  }

  function addLlm() {
    setLlms((prev) => {
      // Prefer a guardrail draft when none exists yet — most operators reach
      // for "add another" specifically because they want to fill the other
      // role. Default kind matches whatever the chat draft uses, so single-
      // vendor deployments don't have to flip the picker every time.
      const hasGuardrailDraft = prev.some((d) => d.role === "guardrail");
      const nextRole: LlmRole = hasGuardrailDraft ? "chat" : "guardrail";
      const baseKind: LlmKind = prev[0]?.kind ?? LLM_KINDS[0];
      return [...prev, newLlmDraft(nextRole, baseKind)];
    });
  }
  function removeLlm(index: number) {
    setLlms((prev) => prev.filter((_, i) => i !== index));
  }

  const filledLlms = llms.filter(llmDraftFilled);
  const enabledLlms = llms.filter((d) => d.enabled && !isLlmAlreadyConfigured(d.kind, d.role));

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (previewMode) return;
    submit.mutate({
      oauthProviders: filledOauth.map((d) => ({
        typeId: d.card.typeId,
        label: d.label.trim() || d.card.oauth.defaultLabel,
        clientId: d.clientId.trim(),
        clientSecret: d.clientSecret.trim(),
        scopes: d.scopes.trim(),
        aux: d.aux.trim(),
      })),
      llms: filledLlms.map((d) => {
        const meta = LLM_KIND_META[d.kind];
        return {
          kind: d.kind,
          role: d.role,
          label: d.label.trim() || meta.defaultLabelByRole[d.role],
          apiKey: d.apiKey.trim(),
          model: d.model.trim() || meta.defaultModelByRole[d.role],
          baseUrl: d.baseUrl.trim(),
          inputPriceCentsPerMtok: parsePriceDollarsToCents(d.inputPrice),
          outputPriceCentsPerMtok: parsePriceDollarsToCents(d.outputPrice),
        };
      }),
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

            {oauthDrafts.map((draft) => {
              const callbackUrl = `${baseUrl}/api/auth/callback/${draft.card.oauth.nextAuthProviderId}`;
              const alreadyConfigured = existingOauth[draft.card.typeId] ?? false;
              return (
                <StepOauth
                  key={draft.uid}
                  displayName={draft.card.displayName}
                  oauth={draft.card.oauth}
                  state={draft}
                  handlers={{
                    setEnabled: (next) => updateOauth(draft.uid, { enabled: next }),
                    setLabel: (next) => updateOauth(draft.uid, { label: next }),
                    setClientId: (next) => updateOauth(draft.uid, { clientId: next }),
                    setClientSecret: (next) => updateOauth(draft.uid, { clientSecret: next }),
                    setScopes: (next) => updateOauth(draft.uid, { scopes: next }),
                    setAux: (next) => updateOauth(draft.uid, { aux: next }),
                  }}
                  alreadyConfigured={alreadyConfigured}
                  callbackUrl={callbackUrl}
                />
              );
            })}

            {!oauthSatisfied ? (
              <Alert variant="warning">
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
              <StepLlm
                key={draft.uid}
                {...(llms.length > 1 ? { index: i + 1 } : {})}
                state={draft}
                handlers={{
                  setEnabled: (next) => updateLlm(i, { enabled: next }),
                  setKind: (next) => updateLlm(i, { kind: next }),
                  setRole: (next) => updateLlm(i, { role: next }),
                  setLabel: (next) => updateLlm(i, { label: next }),
                  setApiKey: (next) => updateLlm(i, { apiKey: next }),
                  setModel: (next) => updateLlm(i, { model: next }),
                  setBaseUrl: (next) => updateLlm(i, { baseUrl: next }),
                  setInputPrice: (next) => updateLlm(i, { inputPrice: next }),
                  setOutputPrice: (next) => updateLlm(i, { outputPrice: next }),
                }}
                alreadyConfigured={isLlmAlreadyConfigured(draft.kind, draft.role)}
                {...(llms.length > 1 ? { onRemove: () => removeLlm(i) } : {})}
              />
            ))}

            {llmsHaveRoleConflict ? (
              <Alert variant="destructive">
                <AlertDescription>
                  Two enabled drafts share the same (kind, role). Disable one or change its role —
                  the wizard writes at most one row per (kind, role) pair.
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
              {oauthDrafts.map((draft) => {
                const alreadyConfigured = existingOauth[draft.card.typeId] ?? false;
                const filled = isOauthDraftFilled(draft);
                let value: string;
                if (alreadyConfigured) {
                  value = "Already configured";
                } else if (filled) {
                  value = `Enabled — ${draft.label.trim() || draft.card.oauth.defaultLabel}`;
                } else {
                  value = "Skipped";
                }
                return <SummaryRow key={draft.uid} title={draft.card.displayName} value={value} />;
              })}
              {LLM_KINDS.flatMap((kind) =>
                (["chat", "guardrail"] as const).map((role) => (
                  <SummaryRow
                    key={`${kind}:${role}`}
                    title={`${LLM_KIND_LABELS[kind]} — ${role === "guardrail" ? "Guardrail" : "Chat"}`}
                    value={summarizeLlmFor(
                      kind,
                      role,
                      filledLlms,
                      enabledLlms,
                      isLlmAlreadyConfigured(kind, role),
                    )}
                  />
                )),
              )}
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
  kind: LlmKind,
  role: LlmRole,
  filled: readonly LlmDraft[],
  enabled: readonly LlmDraft[],
  alreadyConfigured: boolean,
): string {
  if (alreadyConfigured) return "Already configured";
  const meta = LLM_KIND_META[kind];
  const filledMatch = filled.find((d) => d.kind === kind && d.role === role);
  if (filledMatch) {
    const label = filledMatch.label.trim() || meta.defaultLabelByRole[role];
    const fallbackModel = meta.defaultModelByRole[role];
    return `${label} — ${filledMatch.model.trim() || fallbackModel}`;
  }
  // Toggle on but apiKey blank — surfaces a "won't be created" hint instead of a silent skip.
  const enabledMatch = enabled.find((d) => d.kind === kind && d.role === role);
  if (enabledMatch && !enabledMatch.apiKey.trim()) return "Skipped (API key blank)";
  return "Skipped (add later in /settings)";
}
