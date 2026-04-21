"""Shared bootstrap for CLI commands. Each command calls `prepare()` to get a ready-to-use
context (paths, config, DB connection, provider). Keeps command bodies short and uniform."""
from __future__ import annotations

import sqlite3
from dataclasses import dataclass

from docket.agent.prompt import configure_prompt_loader
from docket.config import (
    Config,
    ConfigMissingError,
    Paths,
    ScopeFilter,
    load_config,
    load_env,
    load_project_env,
    resolve_paths,
)
from docket.core.model import ScopeFilters
from docket.providers.azure_devops import AzureDevOpsProvider
from docket.providers.base import WorkItemProvider
from docket.storage import init_db
from docket.telemetry import init_logging


@dataclass
class Context:
    paths: Paths
    config: Config
    conn: sqlite3.Connection
    provider: WorkItemProvider

    def scope_filter(self, name: str | None = None) -> ScopeFilter:
        key = name or self.config.active_scope
        if key not in self.config.scopes:
            raise KeyError(f"unknown scope '{key}' (known: {sorted(self.config.scopes)})")
        return self.config.scopes[key]

    def scope_filters(self, name: str | None = None) -> ScopeFilters:
        sf = self.scope_filter(name)
        return ScopeFilters(
            team=sf.team,
            area_path=sf.area_path,
            iteration_path=sf.iteration_path,
            assignee=sf.assignee,
        )

    def close(self) -> None:
        self.conn.close()


def prepare() -> Context:
    """Full bootstrap: resolve paths, load .env, load config, init DB, build provider.

    Raises ConfigMissingError if no config.toml is present — callers should catch and
    dispatch to the setup wizard instead of failing.
    """
    load_project_env()  # honor repo-local .env overrides (XDG_*, keys) before resolving
    paths = resolve_paths()
    paths.ensure()
    load_env(paths)
    init_logging(paths)
    config = load_config(paths)
    configure_prompt_loader(paths.prompts_dir)
    conn = init_db(paths.db_file)
    provider = AzureDevOpsProvider(
        organization_url=str(config.ado.organization),
        project=config.ado.project,
    )
    return Context(paths=paths, config=config, conn=conn, provider=provider)


def prepare_or_wizard() -> Context:
    """Used by command entrypoints: run the wizard if config is missing, then prepare."""
    try:
        return prepare()
    except ConfigMissingError:
        from docket.config.setup_wizard import run_wizard

        run_wizard()
        return prepare()
