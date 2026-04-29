/**
 * Static metadata for the Azure DevOps provider type.
 *
 * Configs reaching the factory have shape:
 *   { orgUrl: string, project: string, accessToken: string }
 *
 * `orgUrl` and `project` come from the project's `providerScope` JSON column.
 * `accessToken` is injected by the server-side provider builder (it reads
 * the user's `Account.access_token` for `provider="azure_devops"` and merges
 * it into the config).
 *
 * `scopeAxes` declares the three AzDO-specific narrowing axes the view bar
 * exposes alongside the reserved assignee/state/tags chips:
 *   - `area_path`: matches `System.AreaPath` with UNDER semantics
 *     (a stored `A\B\C` matches filter `A` or `A\B`).
 *   - `iteration_path`: same UNDER semantics on `System.IterationPath`.
 *   - `team`: matches `System.NodeName` (preferred) or `System.TeamProject`.
 *
 * The matchers and extractors live below in pure-function form because they
 * read off `Item.providerRaw.fields`; `core/` stays provider-agnostic by
 * not knowing what those keys mean.
 */

import type {
  AxisExtractor,
  AxisMatcher,
  LabelTemplate,
  ProviderItemNumberCodec,
  ProviderSpec,
} from "@/core/provider";
import type { Item } from "@/core/types";
import { asPlainObject } from "@/lib/json";
import { azureDevOpsAvatarFetcher } from "@/providers/azure-devops/avatar";
import { AzureDevOpsProvider } from "@/providers/azure-devops/provider";

/**
 * Azure DevOps work item ids are bare integers, scoped per organization. The
 * URL slot carries the same digits the provider stores in `providerItemId`.
 */
const itemNumberCodec: ProviderItemNumberCodec = {
  parseItemNumber: (_scope, urlNumber) => (/^\d+$/.test(urlNumber) ? urlNumber : null),
  formatItemNumber: (providerItemId) => providerItemId,
};

const labelTemplate: LabelTemplate = (config) => {
  const orgUrl = typeof config.orgUrl === "string" ? config.orgUrl.trim() : "";
  const project = typeof config.project === "string" ? config.project.trim() : "";
  if (!orgUrl || !project) return "";
  // Strip protocol + dev.azure.com to keep labels short: "contoso/web".
  const host = orgUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const org = host.split("/").pop() ?? host;
  return `${org}/${project}`;
};

function fieldsOf(item: Item): Record<string, unknown> | null {
  const raw = item.providerRaw?.fields;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  return asPlainObject(raw);
}

function matchesPath(item: Item, fieldKey: string, expected: string): boolean {
  const fields = fieldsOf(item);
  if (!fields) return false;
  const value = fields[fieldKey];
  if (typeof value !== "string") return false;
  return value === expected || value.startsWith(`${expected}\\`);
}

const axisMatcher: AxisMatcher = (item, axisKey, expected) => {
  if (axisKey === "area_path") return matchesPath(item, "System.AreaPath", expected);
  if (axisKey === "iteration_path") return matchesPath(item, "System.IterationPath", expected);
  if (axisKey === "team") {
    const fields = fieldsOf(item);
    if (!fields) return false;
    const node = fields["System.NodeName"];
    if (typeof node === "string" && node === expected) return true;
    const team = fields["System.TeamProject"];
    return typeof team === "string" && team === expected;
  }
  return false;
};

const axisExtract: AxisExtractor = (item, axisKey) => {
  const fields = fieldsOf(item);
  if (!fields) return null;
  if (axisKey === "area_path") {
    const v = fields["System.AreaPath"];
    return typeof v === "string" && v ? v : null;
  }
  if (axisKey === "iteration_path") {
    const v = fields["System.IterationPath"];
    return typeof v === "string" && v ? v : null;
  }
  if (axisKey === "team") {
    const node = fields["System.NodeName"];
    if (typeof node === "string" && node) return node;
    const team = fields["System.TeamProject"];
    return typeof team === "string" && team ? team : null;
  }
  return null;
};

export const azureDevOpsSpec = {
  typeId: "azure_devops",
  displayName: "Azure DevOps",
  factory: (config) => new AzureDevOpsProvider(config),
  setupFields: [
    {
      key: "organization",
      label: "Organization",
      kind: "string",
      required: true,
      placeholder: "contoso",
      help: "Your Azure DevOps organization name (the segment after dev.azure.com/).",
    },
    {
      key: "project",
      label: "Project",
      kind: "string",
      required: true,
      placeholder: "Platform",
      help: "The Azure DevOps project that owns the work items you want to track.",
    },
  ],
  requiresCli: [],
  grouping: "by_kind",
  // Accept either the bare org name (the friendly form input) or a full
  // `https://dev.azure.com/<org>` URL — for backwards compatibility with
  // any project rows already storing the full URL form.
  normalizeConfig: (raw) => {
    const orgRaw =
      typeof raw.organization === "string" && raw.organization.trim()
        ? raw.organization.trim()
        : typeof raw.orgUrl === "string"
          ? raw.orgUrl.trim()
          : "";
    const project = typeof raw.project === "string" ? raw.project.trim() : "";
    if (!orgRaw) throw new Error("Azure DevOps: 'organization' is required");
    if (!project) throw new Error("Azure DevOps: 'project' is required");
    const orgUrl = /^https?:\/\//.test(orgRaw)
      ? orgRaw.replace(/\/$/, "")
      : `https://dev.azure.com/${orgRaw.replace(/^\/+|\/+$/g, "")}`;
    return { orgUrl, project };
  },
  labelTemplate,
  scopeAxes: [
    { key: "area_path", label: "Area path", discoveryStage: null },
    { key: "iteration_path", label: "Iteration", discoveryStage: null },
    { key: "team", label: "Team", discoveryStage: null },
  ],
  axisMatcher,
  axisExtract,
  itemNumberCodec,
  capabilities: {
    supportedReactions: [],
    ciStatus: false,
    pullRequestDiffs: false,
    linkedItems: true,
  },
  oauth: {
    defaultLabel: "Azure DevOps",
    defaultScopes: "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    baseUrlPlaceholder: "Entra tenant id (leave blank for `common` / multi-tenant)",
    baseUrlHelpKey: "azure_devops_tenant",
  },
  profileUrl: null,
  avatarFetcher: azureDevOpsAvatarFetcher,
} satisfies ProviderSpec;
