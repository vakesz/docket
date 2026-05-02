import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { LLM_KINDS } from "@/agent/llm/types";
import { db } from "@/db";
import { llmProviders, oauthProviderConfigs } from "@/db/schema";
import { publicBaseUrl } from "@/lib/public-base-url";
import { listProviderSpecs } from "@/server/provider-registry";
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
 *
 * The page iterates the provider registry and `LLM_KINDS` so adding a new
 * OAuth- or LLM-capable provider lights up the wizard automatically.
 */

export default async function SetupRequiredPage() {
  const status = await getSetupStatus(db);
  if (status.complete) {
    redirect("/");
  }

  const baseUrl = publicBaseUrl();
  const oauthSpecs = listProviderSpecs().filter(
    (spec): spec is typeof spec & { oauth: NonNullable<typeof spec.oauth> } => spec.oauth !== null,
  );

  // Existence checks fire in parallel — one query per OAuth-capable spec
  // and one per (LLM kind × role) pair. The wizard hides any section that
  // already has a row so resuming an interrupted setup doesn't show
  // duplicate fields.
  const [existingOauthByTypeId, existingLlmByKindRole] = await Promise.all([
    Promise.all(
      oauthSpecs.map((spec) =>
        db.query.oauthProviderConfigs
          .findFirst({
            where: eq(oauthProviderConfigs.kind, spec.typeId),
            columns: { id: true },
          })
          .then((row) => [spec.typeId, row !== undefined] as const),
      ),
    ),
    Promise.all(
      LLM_KINDS.flatMap((kind) =>
        (["chat", "guardrail"] as const).map((role) =>
          db.query.llmProviders
            .findFirst({
              where: and(eq(llmProviders.kind, kind), eq(llmProviders.role, role)),
              columns: { id: true },
            })
            .then((row) => [`${kind}:${role}`, row !== undefined] as const),
        ),
      ),
    ),
  ]);

  const existingOauth = Object.fromEntries(existingOauthByTypeId);
  const existingLlm = Object.fromEntries(existingLlmByKindRole);

  // Plain-data projection so the server → client serialization boundary
  // doesn't have to care about the full `ProviderSpec` (which carries
  // factories and matchers that aren't serializable). The wizard only needs
  // displayName + the OAuth metadata block.
  const oauthCards = oauthSpecs.map((spec) => ({
    typeId: spec.typeId,
    displayName: spec.displayName,
    oauth: spec.oauth,
  }));

  return (
    <main className="h-full overflow-y-auto bg-background text-foreground">
      <SetupWizardForm
        publicBaseUrl={baseUrl}
        oauthCards={oauthCards}
        existingOauth={existingOauth}
        existingLlm={existingLlm}
      />
    </main>
  );
}
