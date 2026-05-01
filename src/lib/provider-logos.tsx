/**
 * Per-provider sign-in logo lookup.
 *
 * Each provider package owns its own `logo.tsx` (currentColor SVG, no
 * server deps) and registers it on its `ProviderSpec.logo`. This wrapper
 * reads from the shared registry so adding a third provider is one new
 * logo file plus one new spec entry — no central switch to edit.
 *
 * Returns `null` for unknown kinds, or for kinds whose spec didn't
 * register a logo, so the sign-in button degrades to label-only.
 */

import type { JSX } from "react";
import { getProviderSpec } from "@/server/provider-registry";

export function ProviderLogo({
  kind,
  className,
}: {
  kind: string;
  className?: string;
}): JSX.Element | null {
  const spec = getProviderSpec(kind);
  if (!spec?.logo) return null;
  const Logo = spec.logo;
  return className !== undefined ? <Logo className={className} /> : <Logo />;
}
