from __future__ import annotations

import typer

from docket._console import console
from docket.cli.commands._llm import build_llm_client
from docket.cli.context import prepare_or_wizard
from docket.core.model import ItemKind


def open_command(
    view: str | None = typer.Option(
        None, "--view", help="Named saved view to load (defaults to active view)."
    ),
    no_chat: bool = typer.Option(
        False, "--no-chat", help="Skip LLM wiring; useful when the LLM endpoint is unreachable."
    ),
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
    """Launch the three-pane Textual TUI.

    Typer invokes this with real primitive defaults. When a sibling
    (e.g. `cli.app._root`) wants to run the TUI without going through
    Click, it MUST call `run_open_tui(...)` with explicit primitives —
    direct `open_command(...)` calls receive the `typer.OptionInfo`
    objects as defaults, which are truthy and stringify to `<typer.models.OptionInfo ...>`."""
    run_open_tui(
        view=view,
        no_chat=no_chat,
        read_only=read_only,
        provider=provider,
    )


def run_open_tui(
    *,
    view: str | None,
    no_chat: bool,
    read_only: bool,
    provider: str | None,
) -> None:
    """Real TUI launcher. Accepts only primitives; every caller must be
    explicit about every flag. Keeps the OptionInfo-leak bug from slipping
    back in as new flags get added — a missing positional here is a
    compile-time error rather than a runtime truthy sentinel."""
    from docket.agent.llm_client import LlmClient
    from docket.cli.tui.app import DocketApp, TuiContext

    with prepare_or_wizard() as ctx:
        # Either the CLI flag or runtime.read_only in config.toml enables
        # the mode — whichever is set, same outcome.
        effective_read_only = read_only or ctx.config.runtime.read_only

        provider_key = provider or ctx.active_provider
        if provider_key and provider_key not in ctx.providers:
            console.print(
                f"[red]Provider '{provider_key}' is not configured.[/red] "
                f"Known: {', '.join(sorted(ctx.providers)) or '—'}"
            )
            raise typer.Exit(code=2)
        if not ctx.providers or not provider_key:
            console.print("[red]No provider configured[/red]. Run `docket setup` first.")
            raise typer.Exit(code=2)

        ctx.active_provider = provider_key
        entry = ctx.provider_entry(provider_key)
        view_key = view or entry.active_view
        filters = ctx.view_filters(view_key, provider=provider_key)

        llm: LlmClient | None = None
        if not no_chat:
            llm = build_llm_client(ctx.config.llm)

        tui_ctx = TuiContext(
            conn=ctx.conn,
            provider=ctx.provider,
            providers=dict(ctx.providers),
            provider_key=provider_key,
            scope=filters,
            view_key=view_key or "default",
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
        DocketApp(tui_ctx).run()
