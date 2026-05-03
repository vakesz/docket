// AreaPath / IterationPath facets use UNDER semantics: a stored `A\B\C`
// matches filter `A` or `A\B`. Matchers/extractors live here (not in
// `core/`) so the provider-agnostic core stays out of `providerRaw.fields`.

import type {
  FacetExtractor,
  FacetMatcher,
  LabelTemplate,
  ProviderItemNumberCodec,
  ProviderSpec,
} from "@/core/provider";
import type { Item, ProviderItemId } from "@/core/types";
import { asPlainObject } from "@/lib/json";
import { azureDevOpsAvatarFetcher } from "@/providers/azure-devops/avatar";
import { AzureDevOpsLogo } from "@/providers/azure-devops/logo";
import { AzureDevOpsProvider } from "@/providers/azure-devops/provider";
import { availableIntentsForState, STATE_ENCODING_TAGS } from "@/providers/azure-devops/state-map";

/**
 * Azure DevOps work item ids are bare integers, scoped per organization. The
 * URL slot carries the same digits the provider stores in `providerItemId`.
 */
const itemNumberCodec: ProviderItemNumberCodec = {
  parseItemNumber: (_scope, urlNumber) =>
    /^\d+$/.test(urlNumber) ? (urlNumber as ProviderItemId) : null,
  formatItemNumber: (providerItemId) => providerItemId,
};

const labelTemplate: LabelTemplate = (config) => {
  const orgUrl = typeof config["orgUrl"] === "string" ? config["orgUrl"].trim() : "";
  const project = typeof config["project"] === "string" ? config["project"].trim() : "";
  if (!orgUrl || !project) return "";
  // Strip protocol + dev.azure.com to keep labels short: "contoso/web".
  const host = orgUrl.replace(/^https?:\/\//, "").replace(/\/$/, "");
  const org = host.split("/").pop() ?? host;
  return `${org}/${project}`;
};

function fieldsOf(item: Item): Record<string, unknown> | null {
  const raw = item.providerRaw?.["fields"];
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

const facetMatcher: FacetMatcher = (item, facetKey, expected) => {
  if (facetKey === "area_path") return matchesPath(item, "System.AreaPath", expected);
  if (facetKey === "iteration_path") return matchesPath(item, "System.IterationPath", expected);
  if (facetKey === "team") {
    const fields = fieldsOf(item);
    if (!fields) return false;
    const node = fields["System.NodeName"];
    if (typeof node === "string" && node === expected) return true;
    const team = fields["System.TeamProject"];
    return typeof team === "string" && team === expected;
  }
  return false;
};

const facetExtract: FacetExtractor = (item, facetKey) => {
  const fields = fieldsOf(item);
  if (!fields) return null;
  if (facetKey === "area_path") {
    const v = fields["System.AreaPath"];
    return typeof v === "string" && v ? v : null;
  }
  if (facetKey === "iteration_path") {
    const v = fields["System.IterationPath"];
    return typeof v === "string" && v ? v : null;
  }
  if (facetKey === "team") {
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
  normalizeConfig: (raw) => {
    const orgRaw = typeof raw["organization"] === "string" ? raw["organization"].trim() : "";
    const project = typeof raw["project"] === "string" ? raw["project"].trim() : "";
    if (!orgRaw) throw new Error("Azure DevOps: 'organization' is required");
    if (!project) throw new Error("Azure DevOps: 'project' is required");
    const orgUrl = `https://dev.azure.com/${orgRaw.replace(/^\/+|\/+$/g, "")}`;
    return { orgUrl, project };
  },
  labelTemplate,
  scopeFacets: [
    { key: "area_path", label: "Area path", discoveryStage: null },
    { key: "iteration_path", label: "Iteration", discoveryStage: null },
    { key: "team", label: "Team", discoveryStage: null },
  ],
  facetMatcher,
  facetExtract,
  itemNumberCodec,
  capabilities: {
    supportedReactions: [],
    ciStatus: false,
    pullRequestDiffs: false,
    linkedItems: true,
    creatableKinds: ["epic", "feature", "story", "task", "bug"],
    stateEncodingTags: [...STATE_ENCODING_TAGS],
  },
  availableIntents: availableIntentsForState,
  oauth: {
    defaultLabel: "Azure DevOps",
    defaultScopes: "499b84ac-1321-427f-aa17-267ca6975798/.default offline_access",
    nextAuthProviderId: "azure_devops",
    auxLabel: "Directory (tenant) ID",
    auxRequired: true,
    auxKind: "string",
    auxPlaceholder: "00000000-0000-0000-0000-000000000000",
    auxHelp:
      "UUID. Found on the Entra tenant overview page; required so the OAuth endpoints resolve correctly.",
    auxSlot: "metadataTenant",
    registrationLabel: "entra.microsoft.com",
    registrationUrl: "https://entra.microsoft.com",
  },
  profileUrl: null,
  avatarFetcher: azureDevOpsAvatarFetcher,
  logo: AzureDevOpsLogo,
} satisfies ProviderSpec;
