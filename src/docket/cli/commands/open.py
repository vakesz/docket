from __future__ import annotations

from typing import TYPE_CHECKING

import typer
from rich.console import Console

from docket.cli.context import prepare_or_wizard
from docket.config.env import (
    get_foundry_api_key,
    get_foundry_api_version,
    get_foundry_deployment,
    get_foundry_endpoint,
    get_read_only,
)
from docket.core.model import ItemKind

if TYPE_CHECKING:
    from docket.agent.foundry_client import FoundryClient
    from docket.config.models import FoundryConfig

console = Console()


def open_command(
    scope: str | None = typer.Option(None, "--scope", help="Named scope to browse (defaults to active scope)."),
    no_chat: bool = typer.Option(False, "--no-chat", help="Skip LLM wiring; useful when Foundry is unreachable."),
    read_only: bool = typer.Option(
        False,
        "--read-only",
        help="Disable all mutation paths — the agent can browse and chat but never proposes writes.",
    ),
    provider: str | None = typer.Option(
        None,
        "--provider",
        help="Provider id to activate on launch (defaults to config.active_provider).",
    ),
) -> None:
    """Launch the three-pane Textual TUI."""
    from docket.agent.foundry_client import LlmClient
    from docket.cli.tui import ItvApp, TuiContext

    # Either the flag or DOCKET_READ_ONLY=1 enables the mode — whichever
    # comes first, same outcome.
    effective_read_only = read_only or get_read_only()

    ctx = prepare_or_wizard()
    try:
        provider_key = provider or ctx.active_provider
        if provider_key and provider_key not in ctx.providers:
            console.print(
                f"[red]Provider '{provider_key}' is not configured.[/red] "
                f"Known: {', '.join(sorted(ctx.providers)) or '—'}"
            )
            raise typer.Exit(code=2)
        if not ctx.providers or not provider_key:
            console.print(
                "[red]No provider configured[/red]. Run `docket setup` first."
            )
            raise typer.Exit(code=2)

        ctx.active_provider = provider_key
        entry = ctx.provider_entry(provider_key)
        scope_key = scope or entry.active_scope
        filters = ctx.scope_filters(scope_key, provider=provider_key)

        llm: LlmClient | None = None
        if not no_chat:
            llm = _build_llm_client(ctx.config.foundry)

        tui_ctx = TuiContext(
            conn=ctx.conn,
            provider=ctx.provider,
            providers=dict(ctx.providers),
            provider_key=provider_key,
            scope=filters,
            scope_key=scope_key,
            llm=llm,
            compaction_threshold_tokens=ctx.config.llm.compaction_threshold_tokens,
            external_watch_interval_seconds=ctx.config.llm.external_watch_interval_seconds,
            read_only=effective_read_only,
            background_sync_interval_seconds=ctx.config.sync.background_interval_seconds,
            background_sync_min_interval_by_provider=dict(
                ctx.config.sync.min_interval_seconds_by_provider
            ),
            stale_threshold_days=ctx.config.stale.threshold_days,
            stale_threshold_by_provider=dict(ctx.config.stale.threshold_days_by_provider),
            default_new_item_kind=ItemKind(ctx.config.ui.default_new_item_kind),
            show_acceptance_criteria=ctx.config.ui.show_acceptance_criteria,
            paths=ctx.paths,
            config=ctx.config,
        )
        ItvApp(tui_ctx).run()
    finally:
        ctx.close()


def _build_llm_client(foundry_cfg: FoundryConfig) -> FoundryClient | None:
    """Build the LLM client. `.env` wins over config.toml so users can keep all
    Foundry settings in one place alongside the API key."""
    api_key = get_foundry_api_key()
    endpoint = get_foundry_endpoint() or (str(foundry_cfg.endpoint) if foundry_cfg.endpoint else None)
    deployment = get_foundry_deployment() or foundry_cfg.deployment
    api_version = get_foundry_api_version()
    if not api_key or not endpoint:
        missing = [
            label for label, value in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
            ) if not value
        ]
        console.print(
            f"[yellow]Chat disabled[/yellow]: set {', '.join(missing)} in "
            "your .env (repo-local or ~/.config/docket/.env)."
        )
        return None
    from docket.agent.foundry_client import FoundryClient

    return FoundryClient(
        endpoint=endpoint,
        api_key=api_key,
        deployment=deployment,
        api_version=api_version,
    )
