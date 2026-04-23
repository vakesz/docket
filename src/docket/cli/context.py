"""Shared bootstrap for CLI commands. Each command calls `prepare()` to get a ready-to-use
context (paths, config, DB connection, providers). Keeps command bodies short and uniform."""

from __future__ import annotations

import logging
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
from docket.core.model import Project, ScopeFilters, project_id_for
from docket.core.services import project_service
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
        `config.active_provider` instead of a hard-coded Azure DevOps instance."""
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
        return self.scope_filter(name, provider=provider).to_core()

    def scope_key_for(self, provider: str | None = None) -> str:
        return self.provider_entry(provider).active_scope

    @property
    def project_id(self) -> str:
        """Derived id for the currently-active project (= provider key).

        Stable across renames; safe to use as a foreign key for memory,
        sources, sub-agents, and any future per-project state. Scopes
        don't split project identity — they're visual filters over the
        same cached set."""
        return project_id_for(self.active_provider)

    def active_project(self) -> Project:
        """Get-or-create the project row for the active provider."""
        return project_service.activate(
            self.config,
            self.paths,
            self.conn,
            provider_key=self.active_provider,
        )

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
    # Bring up logging immediately at the verbose default so anything that
    # raises during config load is captured. Once the config is in hand we
    # re-init with the user-resolved telemetry setting (no-op if unchanged).
    init_logging(paths)
    config = load_config(paths)
    init_logging(
        paths,
        enabled=config.telemetry.enabled,
        level=logging.getLevelName(config.telemetry.level),
    )
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
    ctx = Context(
        paths=paths,
        config=config,
        conn=conn,
        providers=providers,
        active_provider=active,
    )
    # Mirror config.projects -> SQLite so memory/sources/sub-agents have a
    # valid FK target. Lazily seed an entry for the active (provider, scope)
    # if the user has not declared one explicitly yet.
    project_service.mirror_into_db(config, conn)
    if active and active in config.providers:
        project_service.activate(
            config,
            paths,
            conn,
            provider_key=active,
        )
    return ctx


def prepare_or_wizard() -> Context:
    """Used by command entrypoints: run the wizard if config is missing, then prepare."""
    try:
        return prepare()
    except ConfigMissingError:
        from docket.config.setup_wizard import run_wizard

        run_wizard()
        return prepare()
