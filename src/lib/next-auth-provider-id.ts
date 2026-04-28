/**
 * Translate an `OauthProviderConfig.kind` (and the matching
 * `Project.providerKind`) into the NextAuth `Account.provider` id and
 * its callback URL slug.
 *
 * NextAuth stamps its provider's `id` field into the `Account.provider`
 * column when an OAuth sign-in lands, and the callback URL is
 * `/api/auth/callback/<id>`. By convention every provider's auth
 * wrapper sets that id to match its registry kind (built-in
 * `GitHub({...})` defaults to `"github"`; `azureDevOpsProvider({...})`
 * sets `id: "azure_devops"`), so this is currently the identity function.
 *
 * Centralizing the call site means a future provider whose NextAuth id
 * has to diverge from its kind (e.g. an OIDC issuer whose `id` is
 * already taken by a built-in NextAuth provider) only updates this one
 * file — the server-side `Account` lookup and the client-side callback
 * URL display stay neutral.
 *
 * Lives in `src/lib/` (no `server-only`) so the OAuth-providers panel
 * can render the callback URL the operator must register with each
 * vendor without round-tripping to the server.
 */

export function nextAuthProviderId(kind: string): string {
  return kind;
}

export function nextAuthCallbackPath(kind: string): string {
  return `/api/auth/callback/${nextAuthProviderId(kind)}`;
}
