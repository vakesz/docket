"""`docket setup provider <list|add|remove>` — edit providers without re-running the wizard.

The first-time wizard handles the full onboarding; this module handles the
incremental path: add a second provider, drop one, or just print what's there.
It edits `config.toml` in place so az login / full sync aren't repeated.

Shared helpers (`_pick_github_host`, `_pick_github_repo`, `_looks_like_http_url`,
`console`) live in `setup_wizard` — the dependency is one-way (this module →
setup_wizard) so the wizard stays independent of the CRUD surface."""

from __future__ import annotations

from urllib.parse import urlparse

from pydantic import HttpUrl
from rich.prompt import Confirm, Prompt

from docket.config.loader import ConfigLoadPolicy, load_config, save_config
from docket.config.models import Config, ProviderEntry, ScopeFilter
from docket.config.paths import resolve_paths
from docket.config.setup_wizard import (
    _looks_like_http_url,
    _pick_github_host,
    _pick_github_repo,
    console,
)


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
        for scope_name, _scope in entry.scopes.items():
            star = "*" if scope_name == entry.active_scope else " "
            console.print(f"  {star} {scope_name}")


def provider_add(
    name: str,
    type_id: str,
    *,
    display_name: str | None = None,
    make_active: bool = False,
) -> None:
    """Register a new provider entry. Per-type validation lives here so the
    registry can stay dumb — this is the single authoritative surface where
    the wizard-shaped config emerges."""
    from docket.providers.registry import types as registry_types

    paths = resolve_paths()
    paths.ensure()
    known = registry_types()
    if type_id not in known:
        console.print(f"[red]Unknown provider type '{type_id}'[/red] (known: {', '.join(known)}).")
        raise SystemExit(2)

    config: dict[str, object] = {}
    label_hint = ""
    match type_id:
        case "azure_devops":
            org = Prompt.ask("Azure DevOps organization URL").strip().rstrip("/")
            if not _looks_like_http_url(org):
                console.print("[red]Organization must be a full URL.[/red]")
                raise SystemExit(2)
            project = Prompt.ask("Project name").strip()
            if not project:
                console.print("[red]Project name is required.[/red]")
                raise SystemExit(2)
            config = {"organization": str(HttpUrl(org)), "project": project}
            org_slug = (
                urlparse(str(config["organization"])).path.strip("/")
                or urlparse(str(config["organization"])).netloc
            )
            label_hint = (
                f"Azure DevOps · {org_slug}/{project}" if org_slug else f"Azure DevOps · {project}"
            )
        case "github":
            host = _pick_github_host()
            default_repo = _pick_github_repo(host=host.hostname if host else None)
            config = {"default_repo": default_repo}
            if host and host.api_base_url != "https://api.github.com":
                config["base_url"] = host.api_base_url
            prefix = host.hostname if host and host.hostname != "github.com" else "GitHub"
            label_hint = f"{prefix} · {default_repo}"
        case "github_stub":
            default_repo = Prompt.ask("Default repo (owner/name)", default="example/repo").strip()
            config = {"default_repo": default_repo}
            label_hint = f"GitHub (stub) · {default_repo}"
        case _:
            # Custom provider types (from entry points) self-validate via the
            # factory on first build; the wizard just records an empty config
            # so the user can hand-edit config.toml.
            console.print(
                f"[dim]No wizard prompts for '{type_id}' — config starts empty. "
                "Edit config.toml to fill it in.[/dim]"
            )

    cfg = load_config(paths, policy=ConfigLoadPolicy.OPTIONAL) or Config()
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

    cfg.providers[name] = ProviderEntry(
        type=type_id,
        display_name=display_name,
        config=config,
        scopes={"default": ScopeFilter()},
        active_scope="default",
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
