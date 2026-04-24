"""Per-project sources editor modal.

Mirrors `MemoryPane` but for source documents (long-form reference material:
requirements, design notes, runbooks). Sources have no agent-proposal path —
the agent reads them but never writes — so this is the only UI for managing
them.

Two-column layout: list of sources on the left, Markdown editor + metadata
fields (title, kind, uri, tags) on the right.
"""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Input, ListView, Static, TextArea

from docket.cli.tui.widgets._list_edit_pane import ListEditPane
from docket.core.model import Source
from docket.storage.repos import source_repo


class SourcePane(ListEditPane[Source]):
    """Modal for browsing and editing project source documents.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't try
    to track scope switches."""

    DEFAULT_CSS = """
    SourcePane { align: center middle; }
    SourcePane > Vertical {
        width: 110;
        max-width: 140;
        height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    SourcePane #title { height: auto; color: $accent; text-style: bold; }
    SourcePane #subtitle { height: auto; color: $text-muted; padding-bottom: 1; }
    SourcePane #body { height: 1fr; }
    SourcePane #list-col { width: 38; }
    SourcePane #editor-col { width: 1fr; padding-left: 2; }
    SourcePane #entries { height: 1fr; border: round $panel-lighten-1; }
    SourcePane .field-label { height: auto; color: $text-muted; padding-top: 1; }
    SourcePane #title-input { height: 3; }
    SourcePane #kind-input { height: 3; }
    SourcePane #uri-input { height: 3; }
    SourcePane #tags-input { height: 3; }
    SourcePane #editor { height: 1fr; border: round $panel-lighten-1; background: $panel; }
    SourcePane #buttons { height: auto; padding-top: 1; }
    SourcePane #buttons Button { margin-right: 1; }
    SourcePane #hint { height: auto; color: $text-muted; padding-top: 1; }
    """

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(f"Sources · {self._project_name}", id="title")
            yield Static(
                "Reference documents the agent can read on demand. "
                "Direct edits — agent never writes here.",
                id="subtitle",
            )
            with Horizontal(id="body"):
                with Vertical(id="list-col"):
                    yield Static("entries", classes="field-label")
                    yield ListView(id="entries")
                with Vertical(id="editor-col"):
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
                    with Horizontal(id="buttons"):
                        yield Button("Save", id="save-btn", variant="primary")
                        yield Button("New", id="new-btn")
                        yield Button("Delete", id="delete-btn", variant="error")
                        yield Button("Close", id="close-btn")
            yield Static(
                "Ctrl+S save  ·  Ctrl+N new  ·  Ctrl+D delete  ·  Esc close",
                id="hint",
            )

    # -- list-edit hooks --------------------------------------------------

    def _entity_noun(self) -> str:
        return "source"

    def _field_ids(self) -> tuple[str, ...]:
        return ("title-input", "kind-input", "uri-input", "tags-input", "editor")

    def _list(self) -> list[Source]:
        return source_repo.list_for_project(self._conn, self._project_id, limit=500)

    def _entry_id(self, entry: Source) -> str:
        return entry.id

    def _entry_label(self, entry: Source) -> str:
        if entry.kind:
            return f"{entry.title}  · {entry.kind}"
        return entry.title

    def _load_into_editor(self, entry: Source) -> None:
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#kind-input", Input).value = entry.kind
        self.query_one("#uri-input", Input).value = entry.uri
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_editor_fields(self) -> None:
        self.query_one("#title-input", Input).value = ""
        self.query_one("#kind-input", Input).value = ""
        self.query_one("#uri-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _save_new(self, *, title: str, body_md: str, tags: list[str]) -> Source:
        kind = self.query_one("#kind-input", Input).value.strip()
        uri = self.query_one("#uri-input", Input).value.strip()
        return source_repo.create(
            self._conn,
            project_id=self._project_id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=tags,
        )

    def _save_update(
        self, entry_id: str, *, title: str, body_md: str, tags: list[str]
    ) -> Source | None:
        kind = self.query_one("#kind-input", Input).value.strip()
        uri = self.query_one("#uri-input", Input).value.strip()
        return source_repo.update(
            self._conn,
            entry_id,
            title=title,
            body_md=body_md,
            kind=kind,
            uri=uri,
            tags=tags,
        )

    def _delete_entry(self, entry_id: str) -> bool:
        return source_repo.delete(self._conn, entry_id)


__all__ = ["SourcePane"]
