/**
 * Typed React Query hooks grouped by resource. Each mutation invalidates the
 * cache entries it can reasonably affect — keep this list accurate when adding
 * new endpoints or the UI will silently serve stale data.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api, type DTO } from "./client";
import { qk } from "./keys";

type ItemKind = DTO["ItemKind"];
type ItemState = DTO["ItemState"];
type TransitionIntent = DTO["TransitionIntent"];

// ---------- Setup (bootstrap + full-app) -------------------------------------

export function useSetupStatus() {
  return useQuery({
    queryKey: qk.setupStatus(),
    queryFn: ({ signal }) => api.get<DTO["SetupStatusDTO"]>("/setup/status", undefined, signal),
    staleTime: 0,
  });
}

export function useProviderTypes(enabled = true) {
  return useQuery({
    queryKey: qk.setupProviderTypes(),
    queryFn: ({ signal }) =>
      api.get<DTO["SetupProviderTypeDTO"][]>("/setup/providers/types", undefined, signal),
    enabled,
  });
}

export function useTestProvider() {
  return useMutation({
    mutationFn: (body: DTO["SetupTestProviderRequest"]) =>
      api.post<DTO["SetupTestResultDTO"]>("/setup/test-provider", body),
  });
}

export function useTestLlm() {
  return useMutation({
    mutationFn: (body: DTO["SetupTestLlmRequest"]) =>
      api.post<DTO["SetupTestResultDTO"]>("/setup/test-llm", body),
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["SetupCompleteRequest"]) =>
      api.post<DTO["SetupCompleteDTO"]>("/setup/complete", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.setupStatus() }),
  });
}

export function useCliStatus(enabled = true) {
  return useQuery({
    queryKey: qk.setupCliStatus(),
    queryFn: ({ signal }) => api.get<DTO["CliStatusDTO"]>("/setup/cli-status", undefined, signal),
    enabled,
    // Probe is cheap and the user re-runs it after `gh auth login` / `az login`,
    // so don't let stale data hide a freshly-fixed session.
    staleTime: 0,
  });
}

/** Stage-driven discovery for the wizard's per-provider pickers.
 *
 * The route is provider-agnostic: each provider's `setup.discover_step`
 * decides which `stage` strings it understands and what `payload` keys
 * each stage requires. Caller maps `items[].value` (canonical
 * persistable id) into form state and reads `items[].extras` for any
 * provider-specific metadata (e.g. GitHub's `api_base_url` for hosts).
 */
export function useProviderDiscover(typeId: string) {
  return useMutation({
    mutationFn: (body: DTO["DiscoverRequest"]) =>
      api.post<DTO["DiscoverResultDTO"]>(
        `/setup/providers/${encodeURIComponent(typeId)}/discover`,
        body,
      ),
  });
}

export function useSuggestKey() {
  return useMutation({
    mutationFn: (body: DTO["SuggestKeyRequest"]) =>
      api.post<DTO["SuggestKeyDTO"]>("/setup/suggest-key", body),
  });
}

export function useSuggestLabel() {
  return useMutation({
    mutationFn: (body: DTO["SuggestLabelRequest"]) =>
      api.post<DTO["SuggestLabelDTO"]>("/setup/suggest-label", body),
  });
}

// ---------- Status / settings / identity -------------------------------------

export function useStatus(refetchIntervalMs?: number) {
  return useQuery({
    queryKey: qk.status(),
    queryFn: ({ signal }) => api.get<DTO["StatusDTO"]>("/status", undefined, signal),
    refetchInterval: refetchIntervalMs,
    staleTime: 15_000,
  });
}

export function useSettings() {
  return useQuery({
    queryKey: qk.settings(),
    queryFn: ({ signal }) => api.get<DTO["SettingsDTO"]>("/settings", undefined, signal),
  });
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["SettingsPatchRequest"]) =>
      api.patch<DTO["SettingsUpdatedDTO"]>("/settings", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRotateLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["SettingsLlmKeyRequest"]) =>
      api.post<DTO["SettingsLlmKeyDTO"]>("/settings/llm-key", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRemoveLlmKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<DTO["SettingsLlmKeyDTO"]>("/settings/llm-key"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRegenerateHttpToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.post<DTO["SettingsHttpTokenDTO"]>(
        "/settings/http-token/regenerate",
        {} as Record<string, never>,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
    },
  });
}

export function useSettingsProviderTypes(enabled = true) {
  return useQuery({
    queryKey: qk.settingsProviderTypes(),
    queryFn: ({ signal }) =>
      api.get<DTO["SetupProviderTypeDTO"][]>("/settings/providers/types", undefined, signal),
    enabled,
  });
}

export function useTestSettingsProvider() {
  return useMutation({
    mutationFn: (body: DTO["SetupTestProviderRequest"]) =>
      api.post<DTO["SetupTestResultDTO"]>("/settings/providers/test", body),
  });
}

export function useAddProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["SettingsProviderAddRequest"]) =>
      api.post<DTO["SettingsUpdatedDTO"]>("/settings/providers", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.providers() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useUpdateProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: DTO["SettingsProviderUpdateRequest"] }) =>
      api.put<DTO["SettingsUpdatedDTO"]>(`/settings/providers/${encodeURIComponent(key)}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.providers() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRemoveProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.delete<DTO["SettingsUpdatedDTO"]>(`/settings/providers/${encodeURIComponent(key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.settings() });
      qc.invalidateQueries({ queryKey: qk.providers() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

// ---------- Providers --------------------------------------------------------

export function useProviders() {
  return useQuery({
    queryKey: qk.providers(),
    queryFn: ({ signal }) => api.get<DTO["ProviderDTO"][]>("/providers", undefined, signal),
  });
}

export function useSetActiveProvider() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["ProviderSwitchRequest"]) =>
      api.put<DTO["ProviderDTO"]>("/providers/active", body),
    onSuccess: () => {
      // Per-id detail caches (item / comments / linked / conversation /
      // pendingQuestion / isPinned) key on bare item id, not (provider, id).
      // The same numeric id can resolve to a different real item in a
      // different provider, and the backend's get_item_or_fetch fallback
      // will silently fetch it. Drop those entries entirely so no stale
      // cross-provider data lingers in the inactive cache.
      qc.removeQueries({ queryKey: [...qk.all, "item"] });
      // List/aggregate queries (items, pinned, status, prompts, etc.) are
      // safe to mark stale and let refetch repopulate them with the new
      // provider's data — gives a kinder UX than a flash of empty state.
      qc.invalidateQueries({ queryKey: qk.all });
    },
  });
}

// ---------- Saved views (per-provider) ---------------------------------------

export function useViews(providerKey: string | null | undefined) {
  return useQuery({
    queryKey: qk.views(providerKey ?? ""),
    queryFn: ({ signal }) =>
      api.get<DTO["SavedViewDTO"][]>(
        `/providers/${encodeURIComponent(providerKey ?? "")}/views`,
        undefined,
        signal,
      ),
    enabled: !!providerKey,
  });
}

export function useActiveView(providerKey: string | null | undefined) {
  return useQuery({
    queryKey: qk.activeView(providerKey ?? ""),
    queryFn: ({ signal }) =>
      api.get<DTO["SavedViewDTO"]>(
        `/providers/${encodeURIComponent(providerKey ?? "")}/views/active`,
        undefined,
        signal,
      ),
    enabled: !!providerKey,
  });
}

export function useSetActiveView(providerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["ViewSwitchRequest"]) =>
      api.put<DTO["SavedViewDTO"]>(
        `/providers/${encodeURIComponent(providerKey)}/views/active`,
        body,
      ),
    // View activation drops session overrides on the backend and changes
    // what `/items` and `/items/facets` return; cast a wide net like the
    // provider-switch handler.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }),
  });
}

export function useUpsertView(providerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: DTO["SavedViewWriteRequest"] }) =>
      api.put<DTO["SavedViewDTO"]>(
        `/providers/${encodeURIComponent(providerKey)}/views/${encodeURIComponent(name)}`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.views(providerKey) });
      qc.invalidateQueries({ queryKey: qk.activeView(providerKey) });
      qc.invalidateQueries({ queryKey: qk.viewOverrides() });
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
    },
  });
}

export function useDeleteView(providerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<DTO["SavedViewDTO"]>(
        `/providers/${encodeURIComponent(providerKey)}/views/${encodeURIComponent(name)}`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.views(providerKey) });
      qc.invalidateQueries({ queryKey: qk.activeView(providerKey) });
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
    },
  });
}

// ---------- Session-only view overrides (chip bar) ---------------------------

export function useViewOverrides() {
  return useQuery({
    queryKey: qk.viewOverrides(),
    queryFn: ({ signal }) =>
      api.get<DTO["ViewOverrideDTO"]>("/runtime/view-overrides", undefined, signal),
  });
}

export function useSetViewOverrides() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["ViewOverridePatch"]) =>
      api.patch<DTO["ViewOverrideDTO"]>("/runtime/view-overrides", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.viewOverrides() });
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
    },
  });
}

export function useClearViewOverrides() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<DTO["ViewOverrideDTO"]>("/runtime/view-overrides"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.viewOverrides() });
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
    },
  });
}

// ---------- Per-project facet config (chip visibility + caps) ---------------

export function useViewConfig(providerKey: string | null | undefined) {
  return useQuery({
    queryKey: qk.viewConfig(providerKey ?? ""),
    queryFn: ({ signal }) =>
      api.get<DTO["ProjectViewConfigDTO"]>(
        `/projects/${encodeURIComponent(providerKey ?? "")}/view-config`,
        undefined,
        signal,
      ),
    enabled: !!providerKey,
  });
}

export function useUpdateViewConfig(providerKey: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["ProjectViewConfigPatch"]) =>
      api.patch<DTO["ProjectViewConfigDTO"]>(
        `/projects/${encodeURIComponent(providerKey)}/view-config`,
        body,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qk.viewConfig(providerKey) });
      qc.invalidateQueries({ queryKey: [...qk.all, "items", "facets"] });
    },
  });
}

// ---------- Facets (top-N values per chip) -----------------------------------

export function useFacets(filter: { archived?: boolean } = {}) {
  return useQuery({
    queryKey: qk.facets(filter),
    queryFn: ({ signal }) =>
      api.get<DTO["FacetDTO"][]>("/items/facets", { archived: filter.archived }, signal),
  });
}

// ---------- Items ------------------------------------------------------------

export function useItems(
  filter: {
    kind?: ItemKind | null;
    state?: ItemState[] | null;
    tag?: string | null;
    archived?: boolean;
    parent_id?: string | null;
  } = {},
) {
  return useQuery({
    queryKey: qk.items(filter),
    queryFn: ({ signal }) =>
      api.get<DTO["ItemDTO"][]>(
        "/items",
        {
          kind: filter.kind ?? undefined,
          state: filter.state && filter.state.length > 0 ? filter.state : undefined,
          tag: filter.tag ?? undefined,
          archived: filter.archived,
          parent_id: filter.parent_id ?? undefined,
        },
        signal,
      ),
  });
}

export function useItem(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.item(id) : qk.item("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["ItemDTO"]>(`/items/${encodeURIComponent(id ?? "")}`, undefined, signal),
  });
}

export function useRefreshItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.get<DTO["ItemDTO"]>(`/items/${encodeURIComponent(id)}`, { refresh: true }),
    onSuccess: (data, id) => {
      qc.setQueryData(qk.item(id), data);
      qc.invalidateQueries({ queryKey: qk.comments(id) });
      qc.invalidateQueries({ queryKey: qk.linked(id) });
    },
  });
}

export function useComments(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.comments(id) : qk.comments("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["CommentDTO"][]>(
        `/items/${encodeURIComponent(id ?? "")}/comments`,
        undefined,
        signal,
      ),
  });
}

export function useLinked(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.linked(id) : qk.linked("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["ItemDTO"][]>(`/items/${encodeURIComponent(id ?? "")}/linked`, undefined, signal),
  });
}

export function useStageItemCreate() {
  return useMutation({
    mutationFn: (body: DTO["CreateItemRequest"]) => api.post<DTO["ProposalDTO"]>("/items", body),
  });
}

export function useConfirmItemCreate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.post<DTO["MutationConfirmedDTO"]>(
        `/items/proposals/${encodeURIComponent(proposalId)}/confirm`,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
      qc.invalidateQueries({ queryKey: qk.pinned() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRejectItemCreate() {
  return useMutation({
    mutationFn: (proposalId: string) =>
      api.post<void>(`/items/proposals/${encodeURIComponent(proposalId)}/reject`),
  });
}

export function useSearchItems(
  q: string,
  opts?: { kind?: ItemKind | null; limit?: number; enabled?: boolean },
) {
  const trimmed = q.trim();
  const enabled = (opts?.enabled ?? true) && trimmed.length >= 3;
  return useQuery({
    queryKey: qk.itemSearch(trimmed, opts?.kind ?? null, opts?.limit),
    enabled,
    staleTime: 5_000,
    queryFn: ({ signal }) => {
      const params: Record<string, string | number> = { q: trimmed };
      if (opts?.kind) params.kind = opts.kind;
      if (opts?.limit) params.limit = opts.limit;
      return api.get<DTO["ItemDTO"][]>("/items/search", params, signal);
    },
  });
}

// ---------- Mutation proposals ----------------------------------------------

export function useProposeTransition() {
  return useMutation({
    mutationFn: ({ itemId, intent }: { itemId: string; intent: TransitionIntent }) =>
      api.post<DTO["ProposalDTO"]>(
        `/items/${encodeURIComponent(itemId)}/mutations/transition/propose`,
        { intent },
      ),
  });
}

export function useProposeDescription() {
  return useMutation({
    mutationFn: ({ itemId, newDescriptionMd }: { itemId: string; newDescriptionMd: string }) =>
      api.post<DTO["ProposalDTO"]>(
        `/items/${encodeURIComponent(itemId)}/mutations/description/propose`,
        { new_description_md: newDescriptionMd },
      ),
  });
}

export function useProposeAttachment() {
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: DTO["ProposeAttachmentRequest"] }) =>
      api.post<DTO["ProposalDTO"]>(
        `/items/${encodeURIComponent(itemId)}/mutations/attachment/propose`,
        body,
      ),
  });
}

export function useProposeComment() {
  return useMutation({
    mutationFn: ({ itemId, bodyMd }: { itemId: string; bodyMd: string }) =>
      api.post<DTO["ProposalDTO"]>(
        `/items/${encodeURIComponent(itemId)}/mutations/comment/propose`,
        { body_md: bodyMd } satisfies DTO["ProposeCommentRequest"],
      ),
  });
}

export function useConfirmProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, proposalId }: { itemId: string; proposalId: string }) =>
      api.post<DTO["MutationConfirmedDTO"]>(
        `/items/${encodeURIComponent(itemId)}/mutations/${encodeURIComponent(proposalId)}/confirm`,
      ),
    onSuccess: (_data, { itemId }) => {
      qc.invalidateQueries({ queryKey: qk.item(itemId) });
      qc.invalidateQueries({ queryKey: qk.comments(itemId) });
      // Provider-side automation can update linked items when a transition
      // confirms (e.g. fixed-by / closes-via links), so refetch alongside the
      // primary item to avoid a stale linked panel until the next manual
      // refresh.
      qc.invalidateQueries({ queryKey: qk.linked(itemId) });
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useRejectProposal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, proposalId }: { itemId: string; proposalId: string }) =>
      api.post<void>(
        `/items/${encodeURIComponent(itemId)}/mutations/${encodeURIComponent(proposalId)}/reject`,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.status() }),
  });
}

// ---------- Pins -------------------------------------------------------------

export function usePinned() {
  return useQuery({
    queryKey: qk.pinned(),
    queryFn: ({ signal }) => api.get<DTO["ItemDTO"][]>("/pinned", undefined, signal),
  });
}

export function useIsPinned(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.isPinned(id) : qk.isPinned("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["PinnedStatusDTO"]>(
        `/items/${encodeURIComponent(id ?? "")}/pinned`,
        undefined,
        signal,
      ),
  });
}

export function usePin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.post<DTO["PinnedStatusDTO"]>(`/items/${encodeURIComponent(id)}/pin`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: qk.pinned() });
      qc.invalidateQueries({ queryKey: qk.isPinned(id) });
    },
  });
}

export function useUnpin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/items/${encodeURIComponent(id)}/pin`),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: qk.pinned() });
      qc.invalidateQueries({ queryKey: qk.isPinned(id) });
    },
  });
}

// ---------- Suggestions ------------------------------------------------------

export function useSuggestion() {
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<DTO["SuggestionDTO"]>(`/items/${encodeURIComponent(itemId)}/suggestion`),
  });
}

export function useStageSuggestion() {
  return useMutation({
    mutationFn: ({ itemId, body }: { itemId: string; body: DTO["SuggestionStageRequest"] }) =>
      api.post<DTO["ProposalDTO"][]>(`/items/${encodeURIComponent(itemId)}/suggestion/stage`, body),
  });
}

// ---------- Conversation ----------------------------------------------------

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.conversation(id) : qk.conversation("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["ConversationHistoryDTO"]>(
        `/items/${encodeURIComponent(id ?? "")}/conversation`,
        undefined,
        signal,
      ),
  });
}

export function useStartThread() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (itemId: string) =>
      api.post<DTO["ConversationDTO"]>(`/items/${encodeURIComponent(itemId)}/conversation/thread`),
    onSuccess: (_data, itemId) => {
      void qc.invalidateQueries({ queryKey: qk.conversation(itemId) });
      void qc.invalidateQueries({ queryKey: qk.pendingQuestion(itemId) });
    },
  });
}

export function usePendingQuestion(id: string | undefined) {
  return useQuery({
    queryKey: id ? qk.pendingQuestion(id) : qk.pendingQuestion("__none__"),
    enabled: Boolean(id),
    queryFn: ({ signal }) =>
      api.get<DTO["QuestionDTO"] | null>(
        `/items/${encodeURIComponent(id ?? "")}/conversation/pending_question`,
        undefined,
        signal,
      ),
  });
}

// ---------- Prompts ----------------------------------------------------------

export function usePrompts() {
  return useQuery({
    queryKey: qk.prompts(),
    queryFn: ({ signal }) => api.get<DTO["PromptSummaryDTO"][]>("/prompts", undefined, signal),
  });
}

export function usePrompt(key: string | undefined) {
  return useQuery({
    queryKey: key ? qk.prompt(key) : qk.prompt("__none__"),
    enabled: Boolean(key),
    queryFn: ({ signal }) =>
      api.get<DTO["PromptDTO"]>(`/prompts/${encodeURIComponent(key ?? "")}`, undefined, signal),
  });
}

export function usePutPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, contentMd }: { key: string; contentMd: string }) =>
      api.put<DTO["PromptDTO"]>(`/prompts/${encodeURIComponent(key)}`, {
        content_md: contentMd,
      }),
    onSuccess: (_data, { key }) => {
      qc.invalidateQueries({ queryKey: qk.prompts() });
      qc.invalidateQueries({ queryKey: qk.prompt(key) });
    },
  });
}

export function useResetPrompt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string) =>
      api.delete<DTO["PromptDTO"]>(`/prompts/${encodeURIComponent(key)}`),
    onSuccess: (_data, key) => {
      qc.invalidateQueries({ queryKey: qk.prompts() });
      qc.invalidateQueries({ queryKey: qk.prompt(key) });
    },
  });
}

// ---------- Projects ---------------------------------------------------------

export function useActiveProject() {
  return useQuery({
    queryKey: qk.activeProject(),
    queryFn: ({ signal }) => api.get<DTO["ProjectDTO"]>("/projects/active", undefined, signal),
  });
}

// ---------- MCP --------------------------------------------------------------

export function useMcpServers(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? qk.mcpServers(projectId) : qk.mcpServers("__none__"),
    enabled: Boolean(projectId),
    queryFn: ({ signal }) =>
      api.get<DTO["MCPServerListDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp`,
        undefined,
        signal,
      ),
  });
}

export function useCreateMcpServer(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: DTO["MCPServerEntry"] }) =>
      api.post<DTO["MCPServerDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/${encodeURIComponent(name)}`,
        body,
      ),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.mcpServers(projectId) });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useUpdateMcpServer(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body: DTO["MCPServerUpdateRequest"] }) =>
      api.patch<DTO["MCPServerDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/${encodeURIComponent(name)}`,
        body,
      ),
    onSuccess: (_data, { name }) => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.mcpServers(projectId) });
      qc.invalidateQueries({ queryKey: qk.mcpServer(projectId, name) });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

export function useDeleteMcpServer(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<void>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/${encodeURIComponent(name)}`,
      ),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.mcpServers(projectId) });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

/** Spawn a subprocess for an MCP server, run the handshake, list tools,
 * then clean up. With `body`, validates a draft entry without persisting
 * (used by the Settings UI before save). Without `body`, looks up the
 * saved entry by `name`. Blocking — may take up to the startup timeout. */
export function useTestMcpServer(projectId: string | undefined) {
  return useMutation({
    mutationFn: ({ name, body }: { name: string; body?: DTO["MCPServerEntry"] | null }) =>
      api.post<DTO["MCPServerTestResultDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/${encodeURIComponent(name)}/test`,
        body ?? undefined,
      ),
  });
}

export function useMcpPresets() {
  return useQuery({
    queryKey: qk.mcpPresets(),
    queryFn: ({ signal }) => api.get<DTO["MCPPresetListDTO"]>("/mcp/presets", undefined, signal),
  });
}

export function useApplyMcpPreset(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ presetId, body }: { presetId: string; body: DTO["MCPPresetApplyRequest"] }) =>
      api.post<DTO["MCPServerDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/presets/${encodeURIComponent(
          presetId,
        )}/apply`,
        body,
      ),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.mcpServers(projectId) });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}

// ---------- Memory -----------------------------------------------------------

export function useMemoryList(projectId: string | undefined) {
  return useQuery({
    queryKey: projectId ? qk.memoryList(projectId) : qk.memoryList("__none__"),
    enabled: Boolean(projectId),
    queryFn: ({ signal }) =>
      api.get<DTO["MemoryListDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/memory`,
        undefined,
        signal,
      ),
  });
}

export function useCreateMemory(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["MemoryCreateRequest"]) =>
      api.post<DTO["MemoryDTO"]>(`/projects/${encodeURIComponent(projectId ?? "")}/memory`, body),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.memoryList(projectId) });
    },
  });
}

export function useUpdateMemory(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ memoryId, body }: { memoryId: string; body: DTO["MemoryUpdateRequest"] }) =>
      api.patch<DTO["MemoryDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/memory/${encodeURIComponent(memoryId)}`,
        body,
      ),
    onSuccess: (_data, { memoryId }) => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.memoryList(projectId) });
      qc.invalidateQueries({ queryKey: qk.memoryEntry(projectId, memoryId) });
    },
  });
}

export function useDeleteMemory(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (memoryId: string) =>
      api.delete<void>(
        `/projects/${encodeURIComponent(projectId ?? "")}/memory/${encodeURIComponent(memoryId)}`,
      ),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: qk.memoryList(projectId) });
    },
  });
}

// ---------- Sources ----------------------------------------------------------

export function useSourcesList(projectId: string | undefined, kind?: string | null) {
  return useQuery({
    queryKey: projectId ? qk.sourcesList(projectId, kind) : qk.sourcesList("__none__"),
    enabled: Boolean(projectId),
    queryFn: ({ signal }) =>
      api.get<DTO["SourceListDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/sources`,
        kind ? { kind } : undefined,
        signal,
      ),
  });
}

export function useCreateSource(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["SourceCreateRequest"]) =>
      api.post<DTO["SourceDTO"]>(`/projects/${encodeURIComponent(projectId ?? "")}/sources`, body),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: [...qk.all, "sources", projectId] });
    },
  });
}

export function useUpdateSource(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, body }: { sourceId: string; body: DTO["SourceUpdateRequest"] }) =>
      api.patch<DTO["SourceDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/sources/${encodeURIComponent(sourceId)}`,
        body,
      ),
    onSuccess: (_data, { sourceId }) => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: [...qk.all, "sources", projectId] });
      qc.invalidateQueries({ queryKey: qk.sourceEntry(projectId, sourceId) });
    },
  });
}

export function useDeleteSource(projectId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (sourceId: string) =>
      api.delete<void>(
        `/projects/${encodeURIComponent(projectId ?? "")}/sources/${encodeURIComponent(sourceId)}`,
      ),
    onSuccess: () => {
      if (!projectId) return;
      qc.invalidateQueries({ queryKey: [...qk.all, "sources", projectId] });
    },
  });
}

// ---------- Sync -------------------------------------------------------------

export function useManualSync() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ full = false }: { full?: boolean } = {}) =>
      api.post<DTO["SyncSummaryDTO"]>("/sync", undefined, full ? { full: true } : undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...qk.all, "items"] });
      qc.invalidateQueries({ queryKey: qk.pinned() });
      qc.invalidateQueries({ queryKey: qk.status() });
    },
  });
}
