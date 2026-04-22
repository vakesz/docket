"""Regression tests for AzureDevOpsProvider SDK-integration quirks.

These tests don't hit the network; they stub the SDK client objects returned by
`connection.clients` and assert we pass the right shapes into the SDK. The
historical failure mode they guard against is passing a dict where the SDK
expects a model instance (see the `TeamContext` fix).
"""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from azure.devops.v7_0.work_item_tracking.models import TeamContext

from docket.core.model import ScopeFilters
from docket.providers.azure_devops.provider import AzureDevOpsProvider


@pytest.fixture
def provider(monkeypatch: pytest.MonkeyPatch) -> AzureDevOpsProvider:
    monkeypatch.setattr(
        "docket.providers.azure_devops.provider.get_ado_bearer_token",
        lambda: "fake-token",
    )
    return AzureDevOpsProvider(organization_url="https://dev.azure.com/org", project="proj")


def _stub_clients(provider: AzureDevOpsProvider, wit_client) -> None:
    """Install a fake Connection whose `clients.get_work_item_tracking_client` returns `wit_client`."""
    fake_conn = SimpleNamespace(
        clients=SimpleNamespace(
            get_work_item_tracking_client=lambda: wit_client,
            get_core_client=lambda: SimpleNamespace(get_project=lambda _: None),
        )
    )
    provider._connection = fake_conn  # type: ignore[attr-defined]


def test_list_changes_since_passes_team_context_model(provider: AzureDevOpsProvider) -> None:
    """Regression: the SDK's query_by_wiql internally reads team_context.project_id.
    Passing a plain dict raises `AttributeError: 'dict' object has no attribute 'project_id'`,
    which is how the first-launch sync used to crash."""
    wit = MagicMock()
    wit.query_by_wiql.return_value = SimpleNamespace(work_items=[])
    _stub_clients(provider, wit)

    result = list(provider.list_changes_since(None, ScopeFilters()))

    assert result == []
    assert wit.query_by_wiql.called
    _, kwargs = wit.query_by_wiql.call_args
    ctx = kwargs["team_context"]
    assert isinstance(ctx, TeamContext)
    assert ctx.project == "proj"
    # The attribute SDK reads must be accessible (None is fine, the SDK checks truthiness).
    assert ctx.project_id is None


def test_list_changes_since_batches_and_maps_items(provider: AzureDevOpsProvider) -> None:
    wit = MagicMock()
    wit.query_by_wiql.return_value = SimpleNamespace(
        work_items=[SimpleNamespace(id=1), SimpleNamespace(id=2)]
    )
    wit.get_work_items.return_value = [
        SimpleNamespace(
            id=1,
            fields={
                "System.Id": 1,
                "System.WorkItemType": "User Story",
                "System.Title": "One",
                "System.State": "Active",
                "System.ChangedDate": "2026-04-20T10:00:00Z",
            },
        ),
        SimpleNamespace(
            id=2,
            fields={
                "System.Id": 2,
                "System.WorkItemType": "Task",
                "System.Title": "Two",
                "System.State": "New",
                "System.ChangedDate": "2026-04-20T11:00:00Z",
            },
        ),
    ]
    _stub_clients(provider, wit)

    items = list(provider.list_changes_since(None, ScopeFilters()))
    assert [i.id for i in items] == ["1", "2"]
    assert [i.title for i in items] == ["One", "Two"]
