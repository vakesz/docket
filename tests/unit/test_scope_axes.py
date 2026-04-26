"""Phase 5 exit-criterion: prove the wizard has no built-in blessed axes.

Registering a third-party provider with axes nobody on the team has heard of
(`squad`, `business_unit`) should:

1. Surface those axes via `provider_type_dtos()` — the SPA's data source.
2. Apply the provider's `axis_matcher` when filtering a cached `Item` list.
3. Round-trip them through the `/setup/probe-scope` HTTP endpoint with the
   axes shape the SPA actually sends (`{"axes": {...}}`).

If any built-in code still hardcodes `team`/`area_path`/`iteration_path` we'd
either (a) silently drop the new axes or (b) blow up with an unknown-key
error — both regressions this test prevents."""

from __future__ import annotations

from collections.abc import Iterable
from datetime import datetime
from typing import Any

import pytest
from fastapi.testclient import TestClient

from docket.api._provider_setup import provider_type_dtos
from docket.api.app import create_bootstrap_app
from docket.config.paths import Paths, resolve_paths
from docket.core.model import (
    Comment,
    CreateFields,
    Item,
    ItemKind,
    ItemState,
    ScopeFilters,
    TransitionIntent,
)
from docket.core.services import visual_filter
from docket.providers import registry
from docket.providers.base import ProviderSpec, ScopeAxis, SetupField

SETUP_TOKEN = "setup-token"


class _FakeWidgetProvider:
    """Minimal provider that declares two fully made-up scope axes."""

    type_id = "fake_widget"

    def __init__(self, config: dict[str, Any], display_name: str) -> None:
        self._display_name = display_name

    @property
    def display_name(self) -> str:
        return self._display_name

    def health_check(self) -> None:
        return None

    def list_changes_since(
        self, watermark: datetime | None, filters: ScopeFilters
    ) -> Iterable[Item]:
        return []

    def get_item(self, id: str) -> Item:
        raise NotImplementedError

    def get_comments(self, id: str) -> list[Comment]:
        return []

    def get_linked(self, id: str) -> list[Item]:
        return []

    def transition(self, id: str, intent: TransitionIntent) -> Item:
        raise NotImplementedError

    def patch_description(self, id: str, new_md: str) -> Item:
        raise NotImplementedError

    def upload_attachment(self, id: str, filename: str, content: bytes, content_type: str) -> str:
        raise NotImplementedError

    def add_comment(self, id: str, body_md: str) -> Comment:
        raise NotImplementedError

    def create_item(self, kind: ItemKind, fields: CreateFields) -> Item:
        raise NotImplementedError

    def current_user_identity(self) -> str | None:
        return None


def _widget_axis_matcher(item: Item, axis_key: str, expected: str) -> bool:
    raw = item.provider_raw.get("fields")
    if not isinstance(raw, dict):
        return False
    actual = raw.get(axis_key)
    return isinstance(actual, str) and actual == expected


def _widget_spec() -> ProviderSpec:
    return ProviderSpec(
        type_id=_FakeWidgetProvider.type_id,
        display_name="Fake Widget Tracker",
        factory=_FakeWidgetProvider,
        setup_fields=(SetupField(key="endpoint", label="Endpoint"),),
        scope_axes=(
            ScopeAxis(key="squad", label="Squad", discovery_stage=None),
            ScopeAxis(key="business_unit", label="Business unit", discovery_stage=None),
        ),
        axis_matcher=_widget_axis_matcher,
    )


@pytest.fixture
def widget_spec_registered():
    spec = _widget_spec()
    registry.register(spec)
    yield spec
    # Best-effort cleanup so the test spec doesn't leak into other tests.
    registry._REGISTRY.pop(spec.type_id, None)  # type: ignore[attr-defined]


def _make_item(provider_raw_fields: dict[str, str]) -> Item:
    return Item(
        id=f"{_FakeWidgetProvider.type_id}#1",
        kind=ItemKind.TASK,
        title="Widget item",
        description_md="",
        state=ItemState.ACTIVE,
        assignee="alice@example.com",
        parent_id=None,
        provider_raw={"fields": provider_raw_fields},
    )


def test_provider_type_dtos_surfaces_third_party_axes(widget_spec_registered):
    """`provider_type_dtos` (the data source for `/setup/providers/types`)
    must expose every axis the spec declared, in declaration order — that's
    exactly what the SPA renders inputs for."""
    dtos = {dto.id: dto for dto in provider_type_dtos()}
    fake = dtos["fake_widget"]
    assert [(a.key, a.label) for a in fake.scope_axes] == [
        ("squad", "Squad"),
        ("business_unit", "Business unit"),
    ]


def test_visual_filter_uses_third_party_axis_matcher(widget_spec_registered):
    """`visual_filter.apply_to_items` must dispatch to the spec's matcher
    rather than recognizing only the built-in `team`/`area_path`/etc. keys."""
    matching = _make_item({"squad": "platform", "business_unit": "core"})
    other_squad = _make_item({"squad": "growth", "business_unit": "core"})
    other_bu = _make_item({"squad": "platform", "business_unit": "growth"})

    filters = ScopeFilters(assignee="", axes={"squad": "platform"})
    resolved = visual_filter.resolve(filters, provider=None, spec=widget_spec_registered)
    assert resolved.is_active
    out = visual_filter.apply_to_items([matching, other_squad, other_bu], resolved)
    assert [it.provider_raw["fields"]["squad"] for it in out] == ["platform", "platform"]

    # Two-axis intersection — both must match for an item to survive.
    both = ScopeFilters(assignee="", axes={"squad": "platform", "business_unit": "core"})
    resolved_both = visual_filter.resolve(both, provider=None, spec=widget_spec_registered)
    out_both = visual_filter.apply_to_items([matching, other_squad, other_bu], resolved_both)
    assert out_both == [matching]


def test_probe_scope_round_trips_third_party_axes(
    tmp_path, widget_spec_registered, monkeypatch: pytest.MonkeyPatch
):
    """`/setup/probe-scope` must accept the SPA's wire shape (`{"axes": {...}}`)
    for an arbitrary provider, validating the ScopeFilter without complaining
    about unknown keys."""
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    monkeypatch.setenv("XDG_STATE_HOME", str(tmp_path / "state"))
    monkeypatch.setenv("XDG_CACHE_HOME", str(tmp_path / "cache"))
    monkeypatch.setenv("XDG_DATA_HOME", str(tmp_path / "data"))

    paths: Paths = resolve_paths()
    paths.ensure()
    app = create_bootstrap_app(paths=paths, setup_token=SETUP_TOKEN)
    client = TestClient(app)

    r = client.post(
        "/api/setup/probe-scope",
        headers={"Authorization": f"Bearer {SETUP_TOKEN}"},
        json={
            "type": "fake_widget",
            "config": {"endpoint": "https://widgets.example"},
            "scope": {"assignee": "@me", "axes": {"squad": "platform"}},
        },
    )
    assert r.status_code == 200, r.text
    body = r.json()
    # The fake provider's `list_changes_since` returns []; the route reports
    # `count=0` rather than `None` — proving the scope validated cleanly.
    assert body["count"] == 0
    assert body.get("error") in (None, "")
