/**
 * Provider-agnostic helpers for turning short issue references inside
 * markdown / HTML descriptions (e.g. `#123`, `GH-7`, `owner/repo#42`,
 * `AB#1234`) into clickable links.
 *
 * The strategy is intentionally dumb: we infer a "base URL" from the
 * current item's `url` field instead of plumbing a provider type into
 * the Markdown renderer. If we cannot infer one we leave the reference
 * as plain text — never a broken link.
 */

export interface IssueLinkContext {
  /**
   * Resolve a short reference to an absolute URL, or `null` when no
   * sensible target exists.
   */
  resolve(ref: string): string | null;
}

const NO_OP_CONTEXT: IssueLinkContext = { resolve: () => null };

/**
 * Build a context from the active item's provider URL.
 *
 * GitHub example:
 *   url = "https://github.com/octo/widgets/issues/42"
 *   "#7"           -> "https://github.com/octo/widgets/issues/7"
 *   "octo/widgets#7" -> same
 *   "other/repo#7" -> "https://github.com/other/repo/issues/7"
 *   "GH-7"         -> "https://github.com/octo/widgets/issues/7"
 *
 * Azure DevOps example:
 *   url = "https://dev.azure.com/org/proj/_workitems/edit/1234"
 *   "#5", "AB#5"   -> "https://dev.azure.com/org/proj/_workitems/edit/5"
 */
export function issueLinkContextFromUrl(url: string | null | undefined): IssueLinkContext {
  if (!url) return NO_OP_CONTEXT;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return NO_OP_CONTEXT;
  }

  // GitHub: /<owner>/<repo>/(issues|pull)/<n>
  const githubMatch = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:issues|pull)\/\d+/);
  if (githubMatch && parsed.host.includes("github")) {
    const [, owner, repo] = githubMatch;
    const origin = `${parsed.protocol}//${parsed.host}`;
    return {
      resolve(ref) {
        const repoQual = ref.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/);
        if (repoQual) {
          return `${origin}/${repoQual[1]}/${repoQual[2]}/issues/${repoQual[3]}`;
        }
        const num = extractIssueNumber(ref);
        if (num === null) return null;
        return `${origin}/${owner}/${repo}/issues/${num}`;
      },
    };
  }

  // Azure DevOps: /<org>/<proj>/_workitems/edit/<n>
  const adoMatch = parsed.pathname.match(/^(\/[^/]+\/[^/]+\/_workitems\/edit)\/\d+/);
  if (adoMatch) {
    const base = `${parsed.protocol}//${parsed.host}${adoMatch[1]}`;
    return {
      resolve(ref) {
        const num = extractIssueNumber(ref);
        if (num === null) return null;
        return `${base}/${num}`;
      },
    };
  }

  return NO_OP_CONTEXT;
}

function extractIssueNumber(ref: string): string | null {
  // `#123`, `GH-123`, `AB#123`, `!123`
  const m = ref.match(/^(?:[A-Za-z]{1,5}[#-]|#|!)(\d+)$/);
  return m?.[1] ? m[1] : null;
}

/**
 * Pattern matching every issue-reference shape the resolver knows how
 * to handle. Used by the markdown renderer to split text nodes.
 *
 * Word boundaries in front prevent matches inside hashes like
 * `abc#123` (a fragment), email addresses, and inside identifiers.
 */
export const ISSUE_REF_PATTERN =
  /(?<![\w/-])(?:[A-Za-z][\w.-]+\/[A-Za-z][\w.-]+#\d+|[A-Za-z]{1,5}[#-]\d+|#\d+)(?![\w/-])/g;
