from __future__ import annotations

import typer
from rich.console import Console

from docket.cli.context import prepare_or_wizard
from docket.config.env import (
    get_foundry_api_key,
    get_foundry_api_version,
    get_foundry_deployment,
    get_foundry_endpoint,
)

console = Console()


def open_command(
    scope: str | None = typer.Option(None, "--scope", help="Named scope to browse (defaults to active scope)."),
    no_chat: bool = typer.Option(False, "--no-chat", help="Skip LLM wiring; useful when Foundry is unreachable."),
) -> None:
    """Launch the three-pane Textual TUI."""
    from docket.agent.foundry_client import LlmClient
    from docket.cli.tui import ItvApp, TuiContext

    ctx = prepare_or_wizard()
    try:
        scope_key = scope or ctx.config.active_scope
        filters = ctx.scope_filters(scope_key)

        llm: LlmClient | None = None
        if not no_chat:
            llm = _build_llm_client(ctx.config.foundry)

        tui_ctx = TuiContext(
            conn=ctx.conn,
            provider=ctx.provider,
            scope=filters,
            scope_key=scope_key,
            llm=llm,
            compaction_threshold_tokens=ctx.config.llm.compaction_threshold_tokens,
            external_watch_interval_seconds=ctx.config.llm.external_watch_interval_seconds,
        )
        ItvApp(tui_ctx).run()
    finally:
        ctx.close()


def _build_llm_client(foundry_cfg):
    """Build the LLM client. `.env` wins over config.toml so users can keep all
    Foundry settings in one place alongside the API key."""
    api_key = get_foundry_api_key()
    endpoint = get_foundry_endpoint() or (str(foundry_cfg.endpoint) if foundry_cfg.endpoint else None)
    deployment = get_foundry_deployment() or foundry_cfg.deployment
    api_version = get_foundry_api_version()
    missing = [
        label for label, value in (
            ("AZURE_OPENAI_API_KEY", api_key),
            ("AZURE_OPENAI_ENDPOINT", endpoint),
        ) if not value
    ]
    if missing:
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
