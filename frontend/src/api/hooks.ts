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

// ---------- Providers and scopes --------------------------------------------

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
    // Every cached read is provider-scoped (items, pins, conversations, prompts
    // live against the active provider's cache slice). Blow it all away rather
    // than enumerate — missing one leaves stale rows in the UI.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }),
  });
}

export function useScopes() {
  return useQuery({
    queryKey: qk.scopes(),
    queryFn: ({ signal }) => api.get<DTO["ScopeDTO"][]>("/scopes", undefined, signal),
  });
}

export function useSetActiveScope() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DTO["ScopeSwitchRequest"]) =>
      api.put<DTO["ScopeDTO"]>("/scopes/active", body),
    // Scope changes what the next sync pulls; items, pinned status, and the
    // status footer can all shift. Keeping the net wide here matches the
    // provider-switch handler and avoids stale-row surprises.
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.all }),
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
    mutationFn: (body: DTO["MCPServerCreateRequest"]) =>
      api.post<DTO["MCPServerDTO"]>(`/projects/${encodeURIComponent(projectId ?? "")}/mcp`, body),
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

/** Test a saved server by name. Spawns the subprocess, runs the handshake,
 * lists tools, then cleans up. Blocking: may take up to the server's
 * startup timeout. */
export function useTestMcpServer(projectId: string | undefined) {
  return useMutation({
    mutationFn: (name: string) =>
      api.post<DTO["MCPServerTestResultDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/${encodeURIComponent(name)}/test`,
      ),
  });
}

/** Test a draft server config without saving it. Same blocking caveats as
 * `useTestMcpServer`; useful when iterating on a new entry. */
export function useTestMcpServerDraft(projectId: string | undefined) {
  return useMutation({
    mutationFn: (body: DTO["MCPServerTestRequest"]) =>
      api.post<DTO["MCPServerTestResultDTO"]>(
        `/projects/${encodeURIComponent(projectId ?? "")}/mcp/test`,
        body,
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
