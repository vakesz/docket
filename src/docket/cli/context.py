"""Shared bootstrap for CLI commands. Each command calls `prepare()` to get a ready-to-use
context (paths, config, DB connection, providers). Keeps command bodies short and uniform."""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass, field

from docket.agent.prompt import configure_prompt_loader
from docket.config import (
    Config,
    ConfigMissingError,
    Paths,
    ProviderEntry,
    ScopeFilter,
    load_config,
    load_env,
    resolve_paths,
)
from docket.core.model import ScopeFilters
from docket.providers.base import WorkItemProvider
from docket.providers.registry import UnknownProviderError
from docket.providers.registry import build as build_provider
from docket.storage import init_db
from docket.telemetry import init_logging


@dataclass
class Context:
    paths: Paths
    config: Config
    conn: sqlite3.Connection
    providers: dict[str, WorkItemProvider] = field(default_factory=dict)
    active_provider: str = ""

    @property
    def provider(self) -> WorkItemProvider:
        """Currently-active provider. Every command path that used to read
        `ctx.provider` continues to work — the difference is that it tracks
        `config.active_provider` instead of a hard-coded ADO instance."""
        if not self.active_provider:
            raise RuntimeError("no active provider — config has no providers configured")
        return self.providers[self.active_provider]

    def provider_entry(self, name: str | None = None) -> ProviderEntry:
        key = name or self.active_provider
        if key not in self.config.providers:
            raise KeyError(f"unknown provider '{key}' (known: {sorted(self.config.providers)})")
        return self.config.providers[key]

    def scope_filter(self, name: str | None = None, *, provider: str | None = None) -> ScopeFilter:
        entry = self.provider_entry(provider)
        key = name or entry.active_scope
        if key not in entry.scopes:
            raise KeyError(
                f"unknown scope '{key}' in provider '{provider or self.active_provider}' "
                f"(known: {sorted(entry.scopes)})"
            )
        return entry.scopes[key]

    def scope_filters(
        self, name: str | None = None, *, provider: str | None = None
    ) -> ScopeFilters:
        sf = self.scope_filter(name, provider=provider)
        return ScopeFilters(
            team=sf.team,
            area_path=sf.area_path,
            iteration_path=sf.iteration_path,
            assignee=sf.assignee,
        )

    def scope_key_for(self, provider: str | None = None) -> str:
        return self.provider_entry(provider).active_scope

    def close(self) -> None:
        self.conn.close()


def prepare() -> Context:
    """Full bootstrap: resolve paths, load .env, load config, init DB, build all providers.

    Raises ConfigMissingError if no config.toml is present — callers should catch and
    dispatch to the setup wizard instead of failing.
    """
    paths = resolve_paths()
    paths.ensure()
    load_env(paths)
    init_logging(paths)
    config = load_config(paths)
    configure_prompt_loader(paths.prompts_dir)
    conn = init_db(paths.db_file)

    providers: dict[str, WorkItemProvider] = {}
    for name, entry in config.providers.items():
        try:
            providers[name] = build_provider(
                entry.type, dict(entry.config), display_name=entry.display_name
            )
        except UnknownProviderError:
            # Surfacing the error would halt the whole app over a single
            # missing plugin; skip it and let the TUI show only providers
            # it could actually build.
            continue

    active = (
        config.active_provider
        if config.active_provider in providers
        else (next(iter(providers), ""))
    )
    return Context(
        paths=paths,
        config=config,
        conn=conn,
        providers=providers,
        active_provider=active,
    )


def prepare_or_wizard() -> Context:
    """Used by command entrypoints: run the wizard if config is missing, then prepare."""
    try:
        return prepare()
    except ConfigMissingError:
        from docket.config.setup_wizard import run_wizard

        run_wizard()
        return prepare()
