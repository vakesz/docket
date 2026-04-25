"""Per-project sources editor modal — thin wrapper over `ListEditPane`.

Mirrors `MemoryPane` but for source documents (long-form reference material:
requirements, design notes, runbooks). Sources have no agent-proposal path —
the agent reads them but never writes — so this is the only UI for managing
them."""

from __future__ import annotations

import sqlite3

from textual.app import ComposeResult
from textual.widgets import Input, Static, TextArea

from docket.cli.tui.widgets._list_edit_pane import ListEditPane
from docket.storage.repos import source_repo


class SourcePane(ListEditPane):
    """Modal for browsing and editing project source documents.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't try
    to track scope switches."""

    DEFAULT_CSS = """
    SourcePane #title-input { height: 3; }
    SourcePane #kind-input { height: 3; }
    SourcePane #uri-input { height: 3; }
    SourcePane #tags-input { height: 3; }
    SourcePane #editor { height: 1fr; border: round $panel-lighten-1; background: $panel; }
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
        self._title = f"Sources · {project_name}"
        self._subtitle = (
            "Reference documents the agent can read on demand. "
            "Direct edits — agent never writes here."
        )

    def compose_editor(self) -> ComposeResult:
        yield Static("title", classes="field-label")
        yield Input(placeholder="Document title…", id="title-input")
        yield Static("kind (free-text)", classes="field-label")
        yield Input(placeholder="requirements, design, runbook, …", id="kind-input")
        yield Static("uri (optional)", classes="field-label")
        yield Input(placeholder="https://…", id="uri-input")
        yield Static("tags (comma-separated)", classes="field-label")
        yield Input(placeholder="api, auth, …", id="tags-input")
        yield Static("body (markdown)", classes="field-label")
        yield TextArea("", id="editor")

    def _field_ids(self) -> tuple[str, ...]:
        return ("title-input", "kind-input", "uri-input", "tags-input", "editor")

    def _list_rows(self) -> list[tuple[str, str]]:
        return [
            (s.id, f"{s.title}  · {s.kind}" if s.kind else s.title)
            for s in source_repo.list_for_project(self._conn, self._project_id, limit=500)
        ]

    def _on_select(self, entry_id: str) -> None:
        entry = source_repo.get(self._conn, entry_id)
        if entry is None:
            return
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#kind-input", Input).value = entry.kind
        self.query_one("#uri-input", Input).value = entry.uri
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_form(self) -> None:
        self.query_one("#title-input", Input).value = ""
        self.query_one("#kind-input", Input).value = ""
        self.query_one("#uri-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _save(self) -> str | None:
        title = self.query_one("#title-input", Input).value.strip()
        kind = self.query_one("#kind-input", Input).value.strip()
        uri = self.query_one("#uri-input", Input).value.strip()
        body_md = self.query_one("#editor", TextArea).text
        tags = [
            t.strip() for t in self.query_one("#tags-input", Input).value.split(",") if t.strip()
        ]
        if not title:
            self.app.notify("Title is required.", severity="warning")
            return None
        try:
            if self._current_id is None:
                entry = source_repo.create(
                    self._conn,
                    project_id=self._project_id,
                    title=title,
                    body_md=body_md,
                    kind=kind,
                    uri=uri,
                    tags=tags,
                )
                self.app.notify(f"Added '{title}'.", severity="information")
                return entry.id
            updated = source_repo.update(
                self._conn,
                self._current_id,
                title=title,
                body_md=body_md,
                kind=kind,
                uri=uri,
                tags=tags,
            )
            if updated is None:
                self.app.notify("Source vanished — refreshing.", severity="warning")
                return None
            self.app.notify(f"Saved '{title}'.", severity="information")
            return updated.id
        except KeyError as e:
            self.app.notify(str(e), severity="error")
            return None

    def _delete_one(self, entry_id: str) -> bool:
        ok = source_repo.delete(self._conn, entry_id)
        if ok:
            self.app.notify("Removed source.", severity="information")
        return ok


__all__ = ["SourcePane"]
