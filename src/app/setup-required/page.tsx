import { redirect } from "next/navigation";
import { publicBaseUrl } from "@/lib/public-base-url";
import { db } from "@/server/db";
import { getSetupStatus } from "@/server/setup/status";
import { SetupWizardForm } from "@/ui/setup/wizard-form";

/**
 * In-browser bootstrap wizard. Replaces the env-edit-and-restart loop:
 * the operator runs `docker compose up`, opens this page, fills in at
 * least one OAuth provider (LLM is optional), and the same submit
 * flips `setup.complete` so the next page load lands on `/`.
 *
 * Notably this page does NOT call `requireSetupComplete()` itself; that
 * would bounce the redirect against itself. Every other top-level route
 * (`/`, `/settings/*`, `/projects/[projectSlug]/*`) calls the guard, so
 * the user can't navigate around the wizard via direct URL.
 */

export default async function SetupRequiredPage() {
  const status = await getSetupStatus(db);
  if (status.complete) {
    redirect("/");
  }

  const baseUrl = publicBaseUrl();
  const githubExisting = await db.oauthProviderConfig.findFirst({ where: { kind: "github" } });
  const azureDevopsExisting = await db.oauthProviderConfig.findFirst({
    where: { kind: "azure_devops" },
  });
  const openaiChatExisting = await db.llmProvider.findFirst({
    where: { kind: "openai", role: "chat" },
  });
  const openaiGuardrailExisting = await db.llmProvider.findFirst({
    where: { kind: "openai", role: "guardrail" },
  });

  return (
    <main className="min-h-screen bg-background text-foreground">
      <SetupWizardForm
        publicBaseUrl={baseUrl}
        hasGithub={Boolean(githubExisting)}
        hasAzureDevops={Boolean(azureDevopsExisting)}
        hasOpenaiChat={Boolean(openaiChatExisting)}
        hasOpenaiGuardrail={Boolean(openaiGuardrailExisting)}
      />
    </main>
  );
}
