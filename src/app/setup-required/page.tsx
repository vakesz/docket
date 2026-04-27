import { redirect } from "next/navigation";
import { setupCardClass } from "@/lib/form-classes";
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
 * (`/`, `/settings/*`, `/projects/[projectId]/*`) calls the guard, so
 * the user can't navigate around the wizard via direct URL.
 */

export default async function SetupRequiredPage() {
  const status = await getSetupStatus(db);
  if (status.complete) {
    redirect("/");
  }

  const publicBaseUrl = (process.env.PUBLIC_BASE_URL ?? "http://localhost:3000").trim();
  const githubExisting = await db.oauthProviderConfig.findFirst({ where: { kind: "github" } });
  const azureDevopsExisting = await db.oauthProviderConfig.findFirst({
    where: { kind: "azure_devops" },
  });
  const openaiExisting = await db.llmProvider.findFirst({ where: { kind: "openai" } });

  return (
    <main className="flex min-h-screen items-start justify-center bg-bg p-8 text-fg">
      <div className={`${setupCardClass} flex flex-col gap-6`}>
        <SetupWizardForm
          publicBaseUrl={publicBaseUrl}
          hasGithub={Boolean(githubExisting)}
          hasAzureDevops={Boolean(azureDevopsExisting)}
          hasOpenai={Boolean(openaiExisting)}
        />
      </div>
    </main>
  );
}
