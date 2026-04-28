/**
 * Build the relative URL for an avatar served by the local route handler at
 * `/api/avatars/[providerKind]/[identifier]`. The route streams cached bytes
 * out of Postgres (see `src/server/avatars/`), populates lazily for providers
 * with a public fetcher, and returns 404 when nothing is cached so the UI
 * can fall back to an initial chip.
 *
 * Pure string template kept under `src/lib/` (no `server-only`) so the UI
 * filter chips and the account menu can build the URL without dragging in
 * the server-only avatar service.
 */
export function avatarUrl(providerKind: string, identifier: string): string {
  return `/api/avatars/${encodeURIComponent(providerKind)}/${encodeURIComponent(identifier)}`;
}
