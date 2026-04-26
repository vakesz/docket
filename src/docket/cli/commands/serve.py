from __future__ import annotations

import secrets

import typer

from docket._console import console
from docket.cli.commands._llm import build_llm_client
from docket.cli.context import prepare
from docket.config import ConfigMissingError
from docket.config.loader import save_config
from docket.config.models import Config, HttpConfig
from docket.config.paths import resolve_paths
from docket.telemetry import init_logging

_VALID_LOG_LEVELS = {"critical", "error", "warning", "info", "debug", "trace"}


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
        help="Disable every mutation endpoint (in addition to runtime.read_only in config.toml).",
    ),
    log_level: str | None = typer.Option(
        None,
        "--log-level",
        help="Uvicorn log level for this run; overrides telemetry.uvicorn_log_level.",
    ),
) -> None:
    """Run the HTTP surface (FastAPI + SSE) on the configured port.

    When `config.toml` is missing, falls through to bootstrap mode: a tiny
    FastAPI exposing only `/health` and `/setup/*`. The bootstrap path mints
    a fresh `[http].token` into a stub `config.toml` and prints it once so
    the operator can paste it into the wizard."""
    import uvicorn

    from docket.agent.llm_client import LlmClient
    from docket.api.app import create_app, create_bootstrap_app
    from docket.api.runtime import RuntimeState

    if log_level and log_level.lower() not in _VALID_LOG_LEVELS:
        console.print(
            f"[red]Invalid --log-level '{log_level}'[/red]: choose from "
            f"{', '.join(sorted(_VALID_LOG_LEVELS))}."
        )
        raise typer.Exit(code=2)

    try:
        ctx = prepare()
    except ConfigMissingError:
        paths = resolve_paths()
        paths.ensure()
        # Bootstrap surface still needs the rotating JSON log so any error
        # raised while finishing setup is captured for operators.
        init_logging(paths)

        # Mint a token, write a stub config.toml, and print the token once.
        # The wizard will rewrite the rest of config.toml later; until then,
        # `[http].token` is the only field that exists.
        bootstrap_token = secrets.token_urlsafe(32)
        stub = Config(http=HttpConfig(enabled=True, token=bootstrap_token))
        save_config(paths, stub)
        console.print("[yellow]No config.toml found — starting setup surface.[/yellow]")
        console.print("[yellow]Generated bootstrap bearer token (save this):[/yellow]")
        console.print(f"  [cyan]{bootstrap_token}[/cyan]")

        bind = host or "127.0.0.1"
        listen_port = port or 8765
        bootstrap_log_level = (log_level or "info").lower()
        app = create_bootstrap_app(paths=paths, setup_token=bootstrap_token)
        console.print(
            f"[green]docket serve (bootstrap)[/green] listening on http://{bind}:{listen_port} "
            f"— POST /setup/complete to finish setup"
        )
        uvicorn.run(app, host=bind, port=listen_port, log_level=bootstrap_log_level)
        return

    with ctx:
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

        effective_read_only = read_only or ctx.config.runtime.read_only
        effective_log_level = (log_level or ctx.config.telemetry.uvicorn_log_level).lower()

        bind = host or ctx.config.http.bind
        listen_port = port or ctx.config.http.port

        llm: LlmClient | None = None
        if not no_chat:
            llm = build_llm_client(ctx.config.llm)

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
            setup_token=ctx.config.http.token,
            config=ctx.config,
        )
        mode = "read-only" if effective_read_only else "read-write"
        from docket.api.spa import resolve_frontend_dist

        dist = resolve_frontend_dist()
        bundle = str(dist) if dist else "not built (run 'make frontend-build')"
        console.print(
            f"[green]docket serve[/green] listening on http://{bind}:{listen_port} "
            f"(bearer required; chat {'disabled' if llm is None else 'enabled'}; {mode})"
        )
        console.print(f"[dim]frontend bundle: {bundle}[/dim]")
        uvicorn.run(app, host=bind, port=listen_port, log_level=effective_log_level)
