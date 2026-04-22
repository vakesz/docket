"""Pydantic DTOs exposed over the HTTP surface.

Converted from the internal dataclasses so the HTTP contract is decoupled
from on-disk / in-memory representations. Only fields useful to a headless
API caller are exposed — `provider_raw` for example is deliberately omitted
since it leaks Azure DevOps-specific shape.

Split into submodules by route group (`core`, `mutations`, `tui_parity`,
`setup`). Callers should import from `docket.api.schemas` and let this
package re-export; submodule imports are fine too."""

from __future__ import annotations

from docket.api.schemas.core import (
    AttachmentDTO,
    ChatRoleDTO,
    CommentDTO,
    ConversationDTO,
    ConversationHistoryDTO,
    CreateItemRequest,
    HealthDTO,
    ItemDTO,
    SendMessageRequest,
    StatusDTO,
    UsageDTO,
)
from docket.api.schemas.mutations import (
    MutationConfirmedDTO,
    ProposalDTO,
    ProposeAttachmentRequest,
    ProposeCommentRequest,
    ProposeDescriptionRequest,
    ProposeTransitionRequest,
)
from docket.api.schemas.setup import (
    SetupCompleteDTO,
    SetupCompleteRequest,
    SetupLlmEntry,
    SetupProviderEntry,
    SetupProviderFieldDTO,
    SetupProviderTypeDTO,
    SetupStatusDTO,
    SetupTestLlmRequest,
    SetupTestProviderRequest,
    SetupTestResultDTO,
)
from docket.api.schemas.tui_parity import (
    PinnedStatusDTO,
    ProjectDTO,
    ProjectUpdateRequest,
    PromptDTO,
    PromptSummaryDTO,
    PromptUpdateRequest,
    ProviderDTO,
    ProviderSwitchRequest,
    ScopeDTO,
    ScopeSwitchRequest,
    SettingsDTO,
    SettingsPatchRequest,
    SettingsUpdatedDTO,
    SuggestionDTO,
    SuggestionStageRequest,
    SyncSummaryDTO,
)

__all__ = [
    "AttachmentDTO",
    "ChatRoleDTO",
    "CommentDTO",
    "ConversationDTO",
    "ConversationHistoryDTO",
    "CreateItemRequest",
    "HealthDTO",
    "ItemDTO",
    "MutationConfirmedDTO",
    "PinnedStatusDTO",
    "ProjectDTO",
    "ProjectUpdateRequest",
    "PromptDTO",
    "PromptSummaryDTO",
    "PromptUpdateRequest",
    "ProposalDTO",
    "ProposeAttachmentRequest",
    "ProposeCommentRequest",
    "ProposeDescriptionRequest",
    "ProposeTransitionRequest",
    "ProviderDTO",
    "ProviderSwitchRequest",
    "ScopeDTO",
    "ScopeSwitchRequest",
    "SendMessageRequest",
    "SettingsDTO",
    "SettingsPatchRequest",
    "SettingsUpdatedDTO",
    "SetupCompleteDTO",
    "SetupCompleteRequest",
    "SetupLlmEntry",
    "SetupProviderEntry",
    "SetupProviderFieldDTO",
    "SetupProviderTypeDTO",
    "SetupStatusDTO",
    "SetupTestLlmRequest",
    "SetupTestProviderRequest",
    "SetupTestResultDTO",
    "StatusDTO",
    "SuggestionDTO",
    "SuggestionStageRequest",
    "SyncSummaryDTO",
    "UsageDTO",
]
