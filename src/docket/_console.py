"""Shared Rich `Console` for any surface that prints to the terminal.

Lives at the package root so the setup wizard (`config/`) and the CLI
commands (`cli/`) can share one instance without `config` reaching back
into `cli`. Every command/printout used to spin up its own module-level
`Console()`; one is enough."""

from __future__ import annotations

from rich.console import Console

console = Console()

__all__ = ["console"]
