"""Unit tests for the pure view-resolver helpers."""

from __future__ import annotations

import sqlite3

from docket.cli.tui.app import TuiContext
from docket.cli.tui.view_resolver import (
    active_provider_entry,
    provider_display_key,
    resolve_grouping,
    resolve_list_item_states,
    resolve_project_name,
    resolve_stale_threshold,
    resolve_sync_interval,
)
from docket.config.models import Config, ProjectEntry, ProviderEntry, ScopeFilter
from docket.core.model import ItemState, ScopeFilters, project_id_for
from tests.fakes.provider import FakeProvider


def _ctx(**overrides: object) -> TuiContext:
    return TuiContext(
        conn=sqlite3.connect(":memory:"),
        provider=FakeProvider(),
        scope=ScopeFilters(assignee=""),
        **overrides,  # type: ignore[arg-type]
    )


def test_provider_display_key_falls_back_to_class_name_when_unset() -> None:
    ctx = _ctx()
    # FakeProvider has no display_name attr → uses classname.
    assert provider_display_key(ctx) == "FakeProvider"


def test_resolve_stale_threshold_prefers_per_provider_override() -> None:
    ctx = _ctx(
        stale_threshold_days=7,
        stale_threshold_by_provider={"FakeProvider": 3},
    )
    assert resolve_stale_threshold(ctx) == 3


def test_resolve_stale_threshold_falls_back_to_global_default() -> None:
    ctx = _ctx(stale_threshold_days=7, stale_threshold_by_provider={"Other": 99})
    assert resolve_stale_threshold(ctx) == 7


def test_resolve_stale_threshold_returns_none_when_disabled() -> None:
    ctx = _ctx(stale_threshold_days=0)
    assert resolve_stale_threshold(ctx) is None


def test_resolve_sync_interval_takes_max_of_base_and_floor() -> None:
    ctx = _ctx(
        background_sync_interval_seconds=10.0,
        background_sync_min_interval_by_provider={"FakeProvider": 30.0},
    )
    assert resolve_sync_interval(ctx) == 30.0


def test_resolve_sync_interval_zero_stays_zero_even_with_floor() -> None:
    ctx = _ctx(
        background_sync_interval_seconds=0.0,
        background_sync_min_interval_by_provider={"FakeProvider": 30.0},
    )
    assert resolve_sync_interval(ctx) == 0.0


def test_resolve_list_item_states_honors_hide_done() -> None:
    assert resolve_list_item_states(_ctx(hide_done=True)) == (
        ItemState.NEW,
        ItemState.ACTIVE,
        ItemState.BLOCKED,
        ItemState.NEEDS_INFO,
    )
    assert resolve_list_item_states(_ctx(hide_done=False)) is None


def test_resolve_grouping_falls_back_when_no_config() -> None:
    assert resolve_grouping(_ctx()) == "by_kind"


def test_resolve_grouping_reads_from_registered_spec() -> None:
    from docket.providers import registry

    cfg = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/repo"},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="primary",
    )
    ctx = _ctx(config=cfg, provider_key="primary")
    spec = registry.spec("github_stub")
    assert spec is not None
    assert resolve_grouping(ctx) == spec.grouping


def test_active_provider_entry_reads_from_config() -> None:
    entry = ProviderEntry(
        type="github_stub",
        display_name="Primary",
        config={"default_repo": "example/repo"},
        scopes={"default": ScopeFilter()},
        active_scope="default",
    )
    cfg = Config(providers={"primary": entry}, active_provider="primary")
    assert active_provider_entry(_ctx(config=cfg, provider_key="primary")) is entry
    assert active_provider_entry(_ctx(config=cfg, provider_key="missing")) is None
    assert active_provider_entry(_ctx(config=None, provider_key="primary")) is None


def test_resolve_project_name_returns_entry_name() -> None:
    cfg = Config(
        providers={
            "primary": ProviderEntry(
                type="github_stub",
                display_name="Primary",
                config={"default_repo": "example/repo"},
            )
        },
        active_provider="primary",
        projects={
            project_id_for("primary"): ProjectEntry(
                provider_key="primary", name="The Primary Project"
            )
        },
    )
    ctx = _ctx(config=cfg, provider_key="primary")
    assert resolve_project_name(ctx) == "The Primary Project"


def test_resolve_project_name_empty_without_config() -> None:
    assert resolve_project_name(_ctx()) == ""
