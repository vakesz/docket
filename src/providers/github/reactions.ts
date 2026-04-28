/**
 * GitHub-specific reaction kinds.
 *
 * Lives in the provider package because the eight emoji shortcodes are part
 * of GitHub's API contract — core stays provider-agnostic and treats
 * reaction identifiers as opaque strings keyed off
 * `ProviderSpec.capabilities.supportedReactions`.
 *
 * Order is the order GitHub itself renders them on issue/comment menus, and
 * the order downstream surfaces (the reaction strip, agent tool input enum)
 * inherit by reading `capabilities.supportedReactions`.
 */
export const GITHUB_REACTION_KINDS = [
  "+1",
  "-1",
  "laugh",
  "hooray",
  "confused",
  "heart",
  "rocket",
  "eyes",
] as const;

export type GithubReactionKind = (typeof GITHUB_REACTION_KINDS)[number];

const VALID = new Set<string>(GITHUB_REACTION_KINDS);

export function isGithubReactionKind(value: string): value is GithubReactionKind {
  return VALID.has(value);
}
