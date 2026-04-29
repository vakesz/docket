/**
 * Catalog of preconfigured remote MCP servers.
 *
 * Eight curated entries cover the surface most Docket users would want
 * to connect — work-item / observability / docs servers that overlap
 * with what the agent already does. The catalog is a static module
 * (not a DB table) because templates rarely change and per-project
 * customization would be overkill for the v1 use case.
 *
 * Each template knows whether it requires no auth, a static header
 * (e.g. an API key), or OAuth. The settings UI uses `authMode` to pick
 * the right input shape — masked token field vs. "Connect with OAuth"
 * button — and `defaultName` to seed the row name. The user is always
 * shown the templates as off-by-default rows; nothing connects until
 * they fill in the required input or complete OAuth.
 */

export type McpTemplateField = {
  /** Header name on the wire (case-sensitive for some servers). */
  key: string;
  label: string;
  placeholder: string;
  helpText: string;
  /** When set, the saved value is `${prefix}${trimmed input}`. */
  prefix?: string;
};

export type McpTemplate = {
  id: string;
  label: string;
  description: string;
  url: string;
  defaultName: string;
  authMode: "none" | "header" | "oauth-or-header";
  fields: McpTemplateField[];
  /** When true, the editor shows a "Connect with OAuth" button. */
  supportsOauth: boolean;
  oauthHint?: string;
  docsUrl: string;
  /** Public-served path to the brand SVG used at the chip head. */
  icon: string;
  /** Optional dark-theme variant when the light-theme SVG doesn't read on a dark background. */
  iconDark?: string;
};

export const MCP_TEMPLATES: McpTemplate[] = [
  {
    id: "github",
    label: "GitHub",
    description: "Issues, PRs, and repo content via GitHub's official remote MCP.",
    url: "https://api.githubcopilot.com/mcp/",
    defaultName: "github",
    authMode: "oauth-or-header",
    supportsOauth: true,
    oauthHint: "OAuth requires GitHub Copilot dynamic client registration to be available.",
    fields: [
      {
        key: "Authorization",
        label: "GitHub PAT",
        placeholder: "ghp_…",
        helpText: "Personal access token with `repo` and `read:org` scopes.",
        prefix: "Bearer ",
      },
    ],
    docsUrl: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp",
    icon: "/mcp-icons/github_light.svg",
    iconDark: "/mcp-icons/github_dark.svg",
  },
  {
    id: "sentry",
    label: "Sentry",
    description: "Surface errors and issue context for the work the agent is reasoning about.",
    url: "https://mcp.sentry.dev/mcp",
    defaultName: "sentry",
    authMode: "oauth-or-header",
    supportsOauth: true,
    fields: [
      {
        key: "Authorization",
        label: "Sentry user auth token",
        placeholder: "sntryu_…",
        helpText: "From Sentry → Settings → Account → API → Auth Tokens.",
        prefix: "Bearer ",
      },
    ],
    docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
    icon: "/mcp-icons/sentry.svg",
  },
  {
    id: "atlassian",
    label: "Atlassian (Jira / Confluence)",
    description: "Read and search Jira issues and Confluence pages.",
    url: "https://mcp.atlassian.com/v1/mcp/authv2",
    defaultName: "atlassian",
    authMode: "oauth-or-header",
    supportsOauth: true,
    fields: [
      {
        key: "Authorization",
        label: "Atlassian API token",
        placeholder: "ATATT3xFf…",
        helpText: "Generate at id.atlassian.com → Manage API tokens.",
        prefix: "Bearer ",
      },
    ],
    docsUrl: "https://www.atlassian.com/platform/remote-mcp-server",
    icon: "/mcp-icons/atlassian.svg",
  },
  {
    id: "linear",
    label: "Linear",
    description: "Tickets, projects, and triage for teams that mirror work in Linear.",
    url: "https://mcp.linear.app/mcp",
    defaultName: "linear",
    authMode: "oauth-or-header",
    supportsOauth: true,
    oauthHint: "Linear MCP uses OAuth 2.1 with dynamic client registration.",
    fields: [
      {
        key: "Authorization",
        label: "Linear OAuth bearer",
        placeholder: "lin_oauth_…",
        helpText: "Paste a bearer minted from a completed Linear OAuth flow.",
        prefix: "Bearer ",
      },
    ],
    docsUrl: "https://linear.app/docs/mcp",
    icon: "/mcp-icons/linear.svg",
  },
  {
    id: "notion",
    label: "Notion",
    description: "Search pages and databases — handy when product specs live in Notion.",
    url: "https://mcp.notion.com/mcp",
    defaultName: "notion",
    authMode: "oauth-or-header",
    supportsOauth: true,
    oauthHint:
      "Notion's hosted MCP requires OAuth — a static bearer alone won't work for most accounts.",
    fields: [
      {
        key: "Authorization",
        label: "Notion OAuth bearer",
        placeholder: "secret_…",
        helpText: "Paste a bearer from a completed Notion OAuth flow.",
        prefix: "Bearer ",
      },
    ],
    docsUrl: "https://developers.notion.com/docs/get-started-with-mcp",
    icon: "/mcp-icons/notion.svg",
  },
  {
    id: "context7",
    label: "Context7",
    description: "Up-to-date library docs for the agent's research path.",
    url: "https://mcp.context7.com/mcp",
    defaultName: "context7",
    authMode: "header",
    supportsOauth: false,
    fields: [
      {
        key: "CONTEXT7_API_KEY",
        label: "Context7 API key",
        placeholder: "ctx7sk_…",
        helpText: "Generate at context7.com/dashboard.",
      },
    ],
    docsUrl: "https://github.com/upstash/context7",
    icon: "/mcp-icons/mcp.svg",
  },
  {
    id: "deepwiki",
    label: "DeepWiki",
    description: "Repo-level Q&A over public GitHub repos. No auth required.",
    url: "https://mcp.deepwiki.com/mcp",
    defaultName: "deepwiki",
    authMode: "none",
    supportsOauth: false,
    fields: [],
    docsUrl: "https://cognition.ai/blog/deepwiki-mcp-server",
    icon: "/mcp-icons/mcp.svg",
  },
  {
    id: "cloudflare-docs",
    label: "Cloudflare Docs",
    description: "Cloudflare reference docs — useful for projects on Workers / CF infra.",
    url: "https://docs.mcp.cloudflare.com/mcp",
    defaultName: "cloudflare-docs",
    authMode: "none",
    supportsOauth: false,
    fields: [],
    docsUrl: "https://developers.cloudflare.com/agents/model-context-protocol/",
    icon: "/mcp-icons/cloudflare.svg",
  },
];

export function findTemplateByUrl(url: string): McpTemplate | undefined {
  const normalized = url.replace(/\/+$/, "");
  return MCP_TEMPLATES.find((t) => t.url.replace(/\/+$/, "") === normalized);
}

/**
 * Strip a template field's prefix from a stored header value so the
 * input can re-render the raw token. Round-trips with the same prefix
 * applied at save time.
 */
export function unwrapField(field: McpTemplateField, stored: string | undefined): string {
  if (!stored) return "";
  if (field.prefix && stored.startsWith(field.prefix)) {
    return stored.slice(field.prefix.length);
  }
  return stored;
}

/** Apply a template field's prefix to user input. */
export function wrapField(field: McpTemplateField, input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "";
  return field.prefix ? `${field.prefix}${trimmed}` : trimmed;
}

/**
 * True when the row's headers cover every field the template requires.
 * Used to render the "Needs configuration" badge — a row whose URL
 * matches a template but which is missing a required header is broken.
 */
export function templateHeadersComplete(
  template: McpTemplate,
  headers: Record<string, string>,
): boolean {
  if (template.fields.length === 0) return true;
  return template.fields.every((field) => {
    const value = headers[field.key];
    if (!value) return false;
    if (field.prefix) {
      return value.startsWith(field.prefix) && value.length > field.prefix.length;
    }
    return value.length > 0;
  });
}
