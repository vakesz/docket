"""Shared Rich `Console` for CLI surfaces.

Every command/printout went through its own module-level `Console()` —
visually identical, but each Typer command shipped its own state. One
console is enough; tests can capture stdout via `capsys` or the Click
runner without needing to monkey-patch per-module instances."""

from __future__ import annotations

from rich.console import Console

console = Console()

__all__ = ["console"]
