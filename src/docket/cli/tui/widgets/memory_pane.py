"""Per-project memory editor modal.

A two-column layout: a list of memory entries on the left, a Markdown
editor on the right. Users can pick, edit, save, or delete entries. Add
opens a fresh row in the editor; Save creates or updates depending on
whether the row has an id yet.

This is the user-driven path — writes go straight through `memory_repo`
without staging proposals. Agent-initiated writes use the proposal/confirm
flow elsewhere."""

from __future__ import annotations

import sqlite3
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListItem, ListView, Static, TextArea

from docket.core.model import MemoryEntry
from docket.storage.repos import memory_repo


class _EntryRow(ListItem):
    """ListItem that carries the underlying entry id."""

    def __init__(self, entry: MemoryEntry) -> None:
        label = entry.title
        if entry.tags:
            label = f"{label}  [{', '.join(entry.tags)}]"
        super().__init__(Static(label))
        self.entry_id = entry.id


class MemoryPane(ModalScreen[None]):
    """Modal for browsing and editing project memory entries.

    `project_id` is captured at open time. If the active project changes
    after the modal is open, just close and reopen — the modal doesn't try
    to track scope switches."""

    DEFAULT_CSS = """
    MemoryPane { align: center middle; }
    MemoryPane > Vertical {
        width: 110;
        max-width: 140;
        height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    MemoryPane #title { height: auto; color: $accent; text-style: bold; }
    MemoryPane #subtitle { height: auto; color: $text-muted; padding-bottom: 1; }
    MemoryPane #body { height: 1fr; }
    MemoryPane #list-col { width: 38; }
    MemoryPane #editor-col { width: 1fr; padding-left: 2; }
    MemoryPane #entries { height: 1fr; border: round $panel-lighten-1; }
    MemoryPane .field-label { height: auto; color: $text-muted; padding-top: 1; }
    MemoryPane #title-input { height: 3; }
    MemoryPane #tags-input { height: 3; }
    MemoryPane #editor { height: 1fr; border: round $panel-lighten-1; background: $panel; }
    MemoryPane #buttons { height: auto; padding-top: 1; }
    MemoryPane #buttons Button { margin-right: 1; }
    MemoryPane #hint { height: auto; color: $text-muted; padding-top: 1; }
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
        self._entries: list[MemoryEntry] = []
        self._current_id: str | None = None  # None = unsaved/new

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(f"Memory · {self._project_name}", id="title")
            yield Static(
                "Per-project notes the agent can read on every turn. "
                "Direct edits skip the confirmation flow.",
                id="subtitle",
            )
            with Horizontal(id="body"):
                with Vertical(id="list-col"):
                    yield Static("entries", classes="field-label")
                    yield ListView(id="entries")
                with Vertical(id="editor-col"):
                    yield Static("title", classes="field-label")
                    yield Input(placeholder="Short title…", id="title-input")
                    yield Static("tags (comma-separated)", classes="field-label")
                    yield Input(placeholder="convention, pitfall, …", id="tags-input")
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
            self.app.notify("Read-only mode — memory edits are disabled.", severity="warning")

    # -- list management ---------------------------------------------------

    def _reload_entries(self, *, select_id: str | None) -> None:
        self._entries = memory_repo.list_for_project(self._conn, self._project_id, limit=500)
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

    def _load_into_editor(self, entry: MemoryEntry) -> None:
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_editor(self) -> None:
        self._current_id = None
        self.query_one("#title-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _set_editor_enabled(self, enabled: bool) -> None:
        for widget_id in ("title-input", "tags-input", "editor"):
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
        body_md = self.query_one("#editor", TextArea).text
        tags_raw = self.query_one("#tags-input", Input).value
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
        if not title:
            self.app.notify("Title is required.", severity="warning")
            return
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
                self.app.notify(f"Added '{entry.title}'.", severity="information")
                self._reload_entries(select_id=entry.id)
            else:
                updated = memory_repo.update(
                    self._conn,
                    self._current_id,
                    title=title,
                    body_md=body_md,
                    tags=tags,
                )
                if updated is None:
                    self.app.notify("Entry vanished — refreshing.", severity="warning")
                    self._reload_entries(select_id=None)
                    return
                self.app.notify(f"Saved '{updated.title}'.", severity="information")
                self._reload_entries(select_id=updated.id)
        except KeyError as e:
            self.app.notify(str(e), severity="error")

    def action_delete(self) -> None:
        if self._read_only or self._current_id is None:
            return
        ok = memory_repo.delete(self._conn, self._current_id)
        if ok:
            self.app.notify("Removed entry.", severity="information")
        self._reload_entries(select_id=None)

    def action_cancel(self) -> None:
        self.dismiss(None)


__all__ = ["MemoryPane"]
