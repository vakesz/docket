from __future__ import annotations

import os
import secrets
from typing import TYPE_CHECKING

import typer
from rich.console import Console

from docket.cli.context import prepare
from docket.config import ConfigMissingError
from docket.config.env import (
    get_llm_api_key,
    get_llm_api_version,
    get_llm_deployment,
    get_llm_endpoint,
    get_read_only,
    get_setup_token,
)
from docket.config.paths import resolve_paths
from docket.telemetry import init_logging

if TYPE_CHECKING:
    from docket.agent.llm_client import AzureOpenAIClient

console = Console()

_VALID_LOG_LEVELS = {"critical", "error", "warning", "info", "debug", "trace"}


def _resolve_log_level() -> str:
    """Uvicorn log level from `DOCKET_LOG_LEVEL` env, defaulting to info."""
    raw = (os.environ.get("DOCKET_LOG_LEVEL") or "info").strip().lower()
    return raw if raw in _VALID_LOG_LEVELS else "info"


def serve_command(
    host: str | None = typer.Option(
        None, "--host", help="Override bind address from config.http.bind."
    ),
    port: int | None = typer.Option(None, "--port", help="Override port from config.http.port."),
    no_chat: bool = typer.Option(
        False, "--no-chat", help="Skip LLM wiring; chat endpoints return 503."
    ),
    read_only: bool = typer.Option(
        False,
        "--read-only",
        help="Disable every mutation endpoint — reads and chat stay available.",
    ),
) -> None:
    """Run the HTTP surface (FastAPI + SSE) on the configured port.

    When `config.toml` is missing, falls through to bootstrap mode: a tiny
    FastAPI exposing only `/health` and `/setup/*`, gated by
    `DOCKET_SETUP_TOKEN`, so the frontend wizard can write config and trigger
    a restart."""
    import uvicorn

    from docket.agent.llm_client import LlmClient
    from docket.api.app import create_app
    from docket.api.bootstrap_app import create_bootstrap_app
    from docket.api.runtime import RuntimeState

    effective_read_only = read_only or get_read_only()
    setup_token = get_setup_token()

    try:
        ctx = prepare()
    except ConfigMissingError:
        paths = resolve_paths()
        paths.ensure()
        # Bootstrap surface still needs the rotating JSON log so any error
        # raised while finishing setup is captured for operators.
        init_logging(paths)

        if not setup_token:
            setup_token = secrets.token_urlsafe(32)
            console.print("[yellow]No config.toml found — starting setup surface.[/yellow]")
            console.print(
                "[yellow]DOCKET_SETUP_TOKEN was not set; generated one for this session:[/yellow]"
            )
            console.print(f"  [cyan]{setup_token}[/cyan]")
        else:
            console.print("[yellow]No config.toml found — starting setup surface[/yellow]")

        bind = host or "127.0.0.1"
        listen_port = port or 8765
        app = create_bootstrap_app(paths=paths, setup_token=setup_token)
        console.print(
            f"[green]docket serve (bootstrap)[/green] listening on http://{bind}:{listen_port} "
            f"— POST /setup/complete to finish setup"
        )
        uvicorn.run(app, host=bind, port=listen_port, log_level=_resolve_log_level())
        return

    try:
        if not ctx.config.http.enabled:
            console.print(
                "[yellow]HTTP surface is disabled[/yellow]: set http.enabled=true in config.toml "
                "or run `docket setup` to regenerate a bearer token."
            )
            raise typer.Exit(code=1)
        if not ctx.config.http.token:
            console.print(
                "[red]No bearer token configured[/red]. Re-run `docket setup` to generate one."
            )
            raise typer.Exit(code=1)

        bind = host or ctx.config.http.bind
        listen_port = port or ctx.config.http.port

        llm: LlmClient | None = None
        if not no_chat:
            llm = _build_llm_client()

        scope_key = ctx.scope_key_for()
        runtime = RuntimeState(
            config=ctx.config,
            providers=ctx.providers,
            provider_key=ctx.active_provider,
            scope_key=scope_key,
        )

        app = create_app(
            conn=ctx.conn,
            provider=ctx.provider,
            bearer_token=ctx.config.http.token,
            llm=llm,
            compaction_threshold_tokens=ctx.config.llm.compaction_threshold_tokens,
            read_only=effective_read_only,
            paths=ctx.paths,
            runtime=runtime,
            setup_token=setup_token,
            config=ctx.config,
        )
        mode = "read-only" if effective_read_only else "read-write"
        console.print(
            f"[green]docket serve[/green] listening on http://{bind}:{listen_port} "
            f"(bearer required; chat {'disabled' if llm is None else 'enabled'}; {mode})"
        )
        uvicorn.run(app, host=bind, port=listen_port, log_level=_resolve_log_level())
    finally:
        ctx.close()


def _build_llm_client() -> AzureOpenAIClient | None:
    from docket.agent.llm_client import AzureOpenAIClient

    api_key = get_llm_api_key()
    endpoint = get_llm_endpoint()
    deployment = get_llm_deployment()
    api_version = get_llm_api_version()
    if not api_key or not endpoint:
        console.print(
            "[yellow]Chat disabled[/yellow]: set AZURE_OPENAI_API_KEY and "
            "AZURE_OPENAI_ENDPOINT in your .env to enable /conversation endpoints."
        )
        return None
    return AzureOpenAIClient(
        endpoint=endpoint,
        api_key=api_key,
        deployment=deployment,
        api_version=api_version,
    )
