"""Per-project memory editor modal — thin wrapper over `ListEditPane`.

User-driven path: writes go straight through `memory_repo` without staging
proposals. Agent-initiated writes use the proposal/confirm flow elsewhere."""

from __future__ import annotations

import sqlite3

from textual.app import ComposeResult
from textual.widgets import Input, Static, TextArea

from docket.cli.tui.widgets._list_edit_pane import ListEditPane
from docket.storage.repos import memory_repo


class MemoryPane(ListEditPane):
    """Modal for browsing and editing project memory entries.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't try
    to track scope switches."""

    DEFAULT_CSS = """
    MemoryPane #title-input { height: 3; }
    MemoryPane #tags-input { height: 3; }
    MemoryPane #editor { height: 1fr; border: round $panel-lighten-1; background: $panel; }
    """

    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        project_id: str,
        project_name: str,
        read_only: bool = False,
    ) -> None:
        super().__init__(read_only=read_only)
        self._conn = conn
        self._project_id = project_id
        self._title = f"Memory · {project_name}"
        self._subtitle = (
            "Per-project notes the agent can read on every turn. "
            "Direct edits skip the confirmation flow."
        )

    def compose_editor(self) -> ComposeResult:
        yield Static("title", classes="field-label")
        yield Input(placeholder="Short title…", id="title-input")
        yield Static("tags (comma-separated)", classes="field-label")
        yield Input(placeholder="convention, pitfall, …", id="tags-input")
        yield Static("body (markdown)", classes="field-label")
        yield TextArea("", id="editor")

    def _field_ids(self) -> tuple[str, ...]:
        return ("title-input", "tags-input", "editor")

    def _list_rows(self) -> list[tuple[str, str]]:
        return [
            (e.id, f"{e.title}  [{', '.join(e.tags)}]" if e.tags else e.title)
            for e in memory_repo.list_for_project(self._conn, self._project_id, limit=500)
        ]

    def _on_select(self, entry_id: str) -> None:
        entry = memory_repo.get(self._conn, entry_id)
        if entry is None:
            return
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_form(self) -> None:
        self.query_one("#title-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _save(self) -> str | None:
        title = self.query_one("#title-input", Input).value.strip()
        body_md = self.query_one("#editor", TextArea).text
        tags = [
            t.strip()
            for t in self.query_one("#tags-input", Input).value.split(",")
            if t.strip()
        ]
        if not title:
            self.app.notify("Title is required.", severity="warning")
            return None
        try:
            if self._current_id is None:
                entry = memory_repo.create(
                    self._conn,
                    project_id=self._project_id,
                    title=title,
                    body_md=body_md,
                    tags=tags,
                    source="user",
                )
                self.app.notify(f"Added '{title}'.", severity="information")
                return entry.id
            updated = memory_repo.update(
                self._conn, self._current_id, title=title, body_md=body_md, tags=tags
            )
            if updated is None:
                self.app.notify("Memory vanished — refreshing.", severity="warning")
                return None
            self.app.notify(f"Saved '{title}'.", severity="information")
            return updated.id
        except KeyError as e:
            self.app.notify(str(e), severity="error")
            return None

    def _delete_one(self, entry_id: str) -> bool:
        ok = memory_repo.delete(self._conn, entry_id)
        if ok:
            self.app.notify("Removed memory.", severity="information")
        return ok


__all__ = ["MemoryPane"]
