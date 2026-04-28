import { notFound } from "next/navigation";
import { publicBaseUrl } from "@/lib/public-base-url";
import { SetupWizardForm } from "@/ui/setup/wizard-form";

/**
 * Dev-only preview of the setup wizard. The real `/setup-required` page
 * redirects to `/` once `setup.complete` flips, and that bit auto-flips
 * back on whenever an OAuth row exists — so visually iterating on the
 * wizard from the live route requires nuking the OAuth rows + the
 * Setting between every render.
 *
 * This route renders the same `<SetupWizardForm>` with all `has*` flags
 * set to `false` (every section visible). Clicking around through the
 * OAuth and LLM pages leaves the DB untouched; only "Finish setup" runs
 * the bootstrap mutation, so just don't click it.
 */
export default function SetupPreviewPage() {
  if (process.env.NODE_ENV === "production") {
    notFound();
  }
  const baseUrl = publicBaseUrl();
  return (
    <main className="relative min-h-screen bg-bg text-fg">
      <p className="fixed top-2 left-1/2 z-10 -translate-x-1/2 rounded-md border border-border bg-surface-alt px-3 py-1.5 text-xs text-fg-muted shadow-sm">
        Preview mode — read-only, navigation only.
      </p>
      <SetupWizardForm
        publicBaseUrl={baseUrl}
        hasGithub={false}
        hasAzureDevops={false}
        hasOpenaiChat={false}
        hasOpenaiGuardrail={false}
        previewMode
      />
    </main>
  );
}
