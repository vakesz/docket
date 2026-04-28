/**
 * Public profile URL for a GitHub `Item.author` / `Item.assignee` login.
 *
 * Lives in the provider package (no `server-only`) so both the spec
 * registry and the client-safe `providerProfileUrl` dispatcher in
 * `src/lib/format.ts` share a single source of truth — same shape as
 * `src/providers/github/logo.tsx`.
 */

export function githubProfileUrl(identity: string): string | null {
  const trimmed = identity.trim();
  if (!trimmed) return null;
  return `https://github.com/${encodeURIComponent(trimmed)}`;
}
