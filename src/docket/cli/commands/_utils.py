"""Shared helpers for CLI command modules."""

from __future__ import annotations

import sys
from collections.abc import Callable
from datetime import datetime
from enum import Enum
from typing import Annotated, Protocol

import typer
from rich.console import Console

#: Shared `--dry-run` flag for every mutation command. Spelling and help text
#: stay consistent so transition / patch / new behave identically.
DryRun = Annotated[
    bool,
    typer.Option("--dry-run", help="Show diff, do not write."),
]


def enum_from_arg[E: Enum](value: str, enum_class: type[E], param_name: str) -> E:
    """Coerce a CLI string into an enum, raising `typer.BadParameter` on miss.

    Lets Typer render the failure as a `Usage:` line consistent with its own
    argument errors (rather than ad-hoc `console.print` + `Exit(2)`)."""
    try:
        return enum_class(value)
    except ValueError as e:
        allowed = ", ".join(m.value for m in enum_class)
        raise typer.BadParameter(
            f"{value!r} is not one of: {allowed}", param_hint=param_name
        ) from e


def split_tags(raw: str | None) -> list[str]:
    if not raw:
        return []
    return [t.strip() for t in raw.split(",") if t.strip()]


def format_updated(value: datetime | None) -> str:
    if value is None:
        return "—"
    return value.strftime("%Y-%m-%d %H:%M")


def read_body(body: str | None, from_file: str | None) -> str:
    if from_file == "-":
        return sys.stdin.read()
    if from_file:
        with open(from_file, encoding="utf-8") as fh:
            return fh.read()
    if body is not None:
        return body
    raise typer.BadParameter("provide --body or --from-file (use '-' for stdin)")


class _HasIdAndTitle(Protocol):
    id: str
    title: str


def resolve_by_id_or_prefix[T: _HasIdAndTitle](
    entry_id: str,
    *,
    get_fn: Callable[[str], T | None],
    candidates_fn: Callable[[], list[T]],
    resource_name: str,
    console: Console,
) -> T:
    """Look up by full id; on miss, fall back to a unique prefix match.

    Exits via `typer.Exit(1)` on no match or ambiguous prefix, printing a
    human-readable pointer at the candidates."""
    direct = get_fn(entry_id)
    if direct is not None:
        return direct
    candidates = [e for e in candidates_fn() if e.id.startswith(entry_id)]
    if not candidates:
        console.print(f"[red]No {resource_name} matching:[/red] {entry_id}")
        raise typer.Exit(1)
    if len(candidates) > 1:
        console.print(
            f"[red]Ambiguous prefix '{entry_id}' matches {len(candidates)} {resource_name}s.[/red]"
        )
        for entry in candidates[:5]:
            console.print(f"  [dim]{entry.id}[/dim]  {entry.title}")
        raise typer.Exit(1)
    return candidates[0]
