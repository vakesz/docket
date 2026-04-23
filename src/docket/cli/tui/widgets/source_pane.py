"""Per-project sources editor modal.

Mirrors `MemoryPane` but for source documents (long-form reference material:
requirements, design notes, runbooks). Sources have no agent-proposal path —
the agent reads them but never writes — so this is the only UI for managing
them.

Two-column layout: list of sources on the left, Markdown editor + metadata
fields (title, kind, uri, tags) on the right.
"""

from __future__ import annotations

import sqlite3
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListItem, ListView, Static, TextArea

from docket.core.model import Source
from docket.storage.repos import source_repo


class _EntryRow(ListItem):
    """ListItem that carries the underlying source id."""

    def __init__(self, entry: Source) -> None:
        label = entry.title
        if entry.kind:
            label = f"{label}  · {entry.kind}"
        super().__init__(Static(label))
        self.entry_id = entry.id


class SourcePane(ModalScreen[None]):
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

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+n", "new_entry", "New", priority=True),
        Binding("ctrl+d", "delete", "Delete", priority=True),
        Binding("escape", "cancel", "Close", priority=True),
    ]

    def __init__(
        self,
        *,
        conn: sqlite3.Connection,
        project_id: str,
        project_name: str,
        read_only: bool = False,
    ) -> None:
        super().__init__()
        self._conn = conn
        self._project_id = project_id
        self._project_name = project_name
        self._read_only = read_only
        self._entries: list[Source] = []
        self._current_id: str | None = None  # None = unsaved/new

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

    def on_mount(self) -> None:
        self._reload_entries(select_id=None)
        if self._read_only:
            self._set_editor_enabled(False)
            self.app.notify("Read-only mode — source edits are disabled.", severity="warning")

    # -- list management ---------------------------------------------------

    def _reload_entries(self, *, select_id: str | None) -> None:
        self._entries = source_repo.list_for_project(self._conn, self._project_id, limit=500)
        view = self.query_one("#entries", ListView)
        view.clear()
        for entry in self._entries:
            view.append(_EntryRow(entry))
        if select_id is not None:
            for index, entry in enumerate(self._entries):
                if entry.id == select_id:
                    view.index = index
                    self._load_into_editor(entry)
                    return
        if self._entries:
            view.index = 0
            self._load_into_editor(self._entries[0])
        else:
            self._clear_editor()

    def _load_into_editor(self, entry: Source) -> None:
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#kind-input", Input).value = entry.kind
        self.query_one("#uri-input", Input).value = entry.uri
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_editor(self) -> None:
        self._current_id = None
        self.query_one("#title-input", Input).value = ""
        self.query_one("#kind-input", Input).value = ""
        self.query_one("#uri-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _set_editor_enabled(self, enabled: bool) -> None:
        for widget_id in ("title-input", "kind-input", "uri-input", "tags-input", "editor"):
            self.query_one(f"#{widget_id}").disabled = not enabled
        for btn_id in ("save-btn", "new-btn", "delete-btn"):
            self.query_one(f"#{btn_id}", Button).disabled = not enabled

    # -- events ------------------------------------------------------------

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, _EntryRow):
            entry = next((e for e in self._entries if e.id == item.entry_id), None)
            if entry is not None:
                self._load_into_editor(entry)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "save-btn":
            self.action_save()
        elif event.button.id == "new-btn":
            self.action_new_entry()
        elif event.button.id == "delete-btn":
            self.action_delete()
        elif event.button.id == "close-btn":
            self.action_cancel()

    # -- actions -----------------------------------------------------------

    def action_new_entry(self) -> None:
        if self._read_only:
            return
        self._clear_editor()
        self.query_one("#title-input", Input).focus()

    def action_save(self) -> None:
        if self._read_only:
            return
        title = self.query_one("#title-input", Input).value.strip()
        kind = self.query_one("#kind-input", Input).value.strip()
        uri = self.query_one("#uri-input", Input).value.strip()
        body_md = self.query_one("#editor", TextArea).text
        tags_raw = self.query_one("#tags-input", Input).value
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
        if not title:
            self.app.notify("Title is required.", severity="warning")
            return
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
                self.app.notify(f"Added '{entry.title}'.", severity="information")
                self._reload_entries(select_id=entry.id)
            else:
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
                    self._reload_entries(select_id=None)
                    return
                self.app.notify(f"Saved '{updated.title}'.", severity="information")
                self._reload_entries(select_id=updated.id)
        except KeyError as e:
            self.app.notify(str(e), severity="error")

    def action_delete(self) -> None:
        if self._read_only or self._current_id is None:
            return
        ok = source_repo.delete(self._conn, self._current_id)
        if ok:
            self.app.notify("Removed source.", severity="information")
        self._reload_entries(select_id=None)

    def action_cancel(self) -> None:
        self.dismiss(None)


__all__ = ["SourcePane"]
