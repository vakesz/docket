/**
 * Per-provider sign-in logo registry. Each provider package owns its own
 * `logo.tsx` (currentColor SVG, no server deps) so adding a third provider
 * is one new logo file plus one entry here — no UI surface needs to know
 * about specific kinds.
 *
 * Returns `null` for unknown kinds so the sign-in button falls back to
 * label-only — same forgiving shape as `auth-build.ts`.
 */

import type { JSX } from "react";
import { AzureDevOpsLogo } from "@/providers/azure-devops/logo";
import { GitHubLogo } from "@/providers/github/logo";

export function ProviderLogo({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}): JSX.Element | null {
  const logoProps = className !== undefined ? { className } : {};
  switch (kind) {
    case "github":
      return <GitHubLogo {...logoProps} />;
    case "azure_devops":
      return <AzureDevOpsLogo {...logoProps} />;
    default:
      return null;
  }
}
