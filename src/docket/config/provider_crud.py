"""`docket setup provider <list|add|remove>` — edit providers without re-running the wizard.

The first-time wizard handles the full onboarding; this module handles the
incremental path: add a second provider, drop one, or just print what's there.
It edits `config.toml` in place so az login / full sync aren't repeated.

Provider-specific prompt details (which fields, which are URLs, which are
secrets) come from `ProviderSpec.setup_fields` so adding a new provider type
doesn't require editing this module. Discovery-driven helpers (e.g. the
GitHub host/repo pickers from the first-run wizard) intentionally don't
participate here — `provider add` is the headless / scriptable path."""

from __future__ import annotations

from typing import Any

from rich.prompt import Confirm, Prompt

from docket.config.loader import load_config, save_config
from docket.config.models import Config, SavedView, build_provider_entry
from docket.config.paths import resolve_paths
from docket.config.setup_utils import (
    build_label_suggestion,
    console,
    looks_like_http_url,
)
from docket.providers import registry


def provider_list() -> None:
    """Print the currently-configured providers."""
    paths = resolve_paths()
    if not paths.config_file.exists():
        console.print("[yellow]No config.toml yet — run `docket setup` first.[/yellow]")
        raise SystemExit(1)
    cfg = load_config(paths)
    if not cfg.providers:
        console.print("[yellow]No providers configured yet.[/yellow]")
        return
    for key, entry in cfg.providers.items():
        active = " (active)" if key == cfg.active_provider else ""
        console.print(
            f"[cyan]{key}[/cyan] · {entry.display_name} · [dim]{entry.type}[/dim]{active}"
        )
        for view_name in entry.views:
            star = "*" if view_name == entry.active_view else " "
            console.print(f"  {star} {view_name}")


def provider_add(
    name: str,
    type_id: str,
    *,
    display_name: str | None = None,
    make_active: bool = False,
) -> None:
    """Register a new provider entry. Prompts for each field declared in the
    provider's `ProviderSpec.setup_fields` so the wizard-shaped config can
    emerge without per-type code in this module."""
    paths = resolve_paths()
    paths.ensure()
    spec = registry.spec(type_id)
    if spec is None:
        known = registry.types()
        console.print(f"[red]Unknown provider type '{type_id}'[/red] (known: {', '.join(known)}).")
        raise SystemExit(2)

    config: dict[str, Any] = {}
    for setup_field in spec.setup_fields:
        prompt_label = setup_field.label + ("" if setup_field.required else " (optional)")
        default = setup_field.placeholder if not setup_field.required else None
        while True:
            raw = Prompt.ask(
                prompt_label,
                default=default,
                password=setup_field.kind == "secret",
            )
            value = (raw or "").strip()
            if setup_field.required and not value:
                console.print(f"[red]{setup_field.label} is required.[/red]")
                continue
            if setup_field.kind == "url" and value and not looks_like_http_url(value):
                console.print("[red]Must be a full URL (http or https).[/red]")
                continue
            config[setup_field.key] = value
            break

    try:
        config = registry.normalize_config(type_id, config)
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise SystemExit(2) from exc

    label_hint = build_label_suggestion(type_id=type_id, config=dict(config))

    cfg = load_config(paths, optional=True) or Config()
    if name in cfg.providers and not Confirm.ask(
        f"Provider '{name}' already exists. Overwrite?", default=False
    ):
        return

    if display_name is None:
        default_label = label_hint or name
        console.print(
            "Label for this provider — shown in the TUI and web provider switcher. "
            "Press enter to accept the suggested default."
        )
        display_name = Prompt.ask("Display name", default=default_label).strip() or default_label

    cfg.providers[name] = build_provider_entry(
        type_id=type_id,
        display_name=display_name,
        config=config,
        view=SavedView(),
        existing=cfg.providers.get(name),
    )
    if make_active or not cfg.active_provider:
        cfg.active_provider = name
    save_config(paths, cfg)
    console.print(f"[green]✓ added provider '{name}'[/green] as [cyan]{display_name}[/cyan]")


def provider_remove(name: str) -> None:
    paths = resolve_paths()
    if not paths.config_file.exists():
        console.print("[yellow]No config.toml yet — nothing to remove.[/yellow]")
        raise SystemExit(1)
    cfg = load_config(paths)
    if name not in cfg.providers:
        console.print(
            f"[red]Unknown provider '{name}' (have: {', '.join(sorted(cfg.providers))}).[/red]"
        )
        raise SystemExit(2)
    if not Confirm.ask(f"Remove provider '{name}'?", default=False):
        return
    del cfg.providers[name]
    if cfg.active_provider == name:
        cfg.active_provider = next(iter(cfg.providers), "")
    save_config(paths, cfg)
    console.print(f"[green]✓ removed provider '{name}'[/green]")


__all__ = ["provider_add", "provider_list", "provider_remove"]
