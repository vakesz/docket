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


def serve_command(
    host: str | None = typer.Option(None, "--host", help="Override bind address from config.http.bind."),
    port: int | None = typer.Option(None, "--port", help="Override port from config.http.port."),
    no_chat: bool = typer.Option(False, "--no-chat", help="Skip LLM wiring; chat endpoints return 503."),
) -> None:
    """Run the HTTP surface (FastAPI + SSE) on the configured port."""
    import uvicorn

    from docket.agent.foundry_client import LlmClient
    from docket.api.app import create_app

    ctx = prepare_or_wizard()
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

        app = create_app(
            conn=ctx.conn,
            provider=ctx.provider,
            bearer_token=ctx.config.http.token,
            llm=llm,
            compaction_threshold_tokens=ctx.config.llm.compaction_threshold_tokens,
        )
        console.print(
            f"[green]docket serve[/green] listening on http://{bind}:{listen_port} "
            f"(bearer required; chat {'disabled' if llm is None else 'enabled'})"
        )
        uvicorn.run(app, host=bind, port=listen_port, log_level="info")
    finally:
        ctx.close()


def _build_llm_client():
    from docket.agent.foundry_client import FoundryClient

    api_key = get_foundry_api_key()
    endpoint = get_foundry_endpoint()
    deployment = get_foundry_deployment()
    api_version = get_foundry_api_version()
    if not api_key or not endpoint:
        console.print(
            "[yellow]Chat disabled[/yellow]: set AZURE_OPENAI_API_KEY and "
            "AZURE_OPENAI_ENDPOINT in your .env to enable /conversation endpoints."
        )
        return None
    return FoundryClient(
        endpoint=endpoint,
        api_key=api_key,
        deployment=deployment,
        api_version=api_version,
    )
