"""Shared helpers for CLI command modules."""

from __future__ import annotations

import sys
from datetime import datetime

import typer


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
