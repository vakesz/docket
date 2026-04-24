"""Per-project memory editor modal.

A two-column layout: a list of memory entries on the left, a Markdown
editor on the right. Users can pick, edit, save, or delete entries. Add
opens a fresh row in the editor; Save creates or updates depending on
whether the row has an id yet.

This is the user-driven path — writes go straight through `memory_repo`
without staging proposals. Agent-initiated writes use the proposal/confirm
flow elsewhere."""

from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Input, ListView, Static, TextArea

from docket.cli.tui.widgets._list_edit_pane import ListEditPane
from docket.core.model import MemoryEntry
from docket.storage.repos import memory_repo


class MemoryPane(ListEditPane[MemoryEntry]):
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

    # -- list-edit hooks --------------------------------------------------

    def _entity_noun(self) -> str:
        return "memory"

    def _field_ids(self) -> tuple[str, ...]:
        return ("title-input", "tags-input", "editor")

    def _list(self) -> list[MemoryEntry]:
        return memory_repo.list_for_project(self._conn, self._project_id, limit=500)

    def _entry_id(self, entry: MemoryEntry) -> str:
        return entry.id

    def _entry_label(self, entry: MemoryEntry) -> str:
        if entry.tags:
            return f"{entry.title}  [{', '.join(entry.tags)}]"
        return entry.title

    def _load_into_editor(self, entry: MemoryEntry) -> None:
        self._current_id = entry.id
        self.query_one("#title-input", Input).value = entry.title
        self.query_one("#tags-input", Input).value = ", ".join(entry.tags)
        self.query_one("#editor", TextArea).text = entry.body_md

    def _clear_editor_fields(self) -> None:
        self.query_one("#title-input", Input).value = ""
        self.query_one("#tags-input", Input).value = ""
        self.query_one("#editor", TextArea).text = ""

    def _save_new(self, *, title: str, body_md: str, tags: list[str]) -> MemoryEntry:
        return memory_repo.create(
            self._conn,
            project_id=self._project_id,
            title=title,
            body_md=body_md,
            tags=tags,
            source="user",
        )

    def _save_update(
        self, entry_id: str, *, title: str, body_md: str, tags: list[str]
    ) -> MemoryEntry | None:
        return memory_repo.update(
            self._conn,
            entry_id,
            title=title,
            body_md=body_md,
            tags=tags,
        )

    def _delete_entry(self, entry_id: str) -> bool:
        return memory_repo.delete(self._conn, entry_id)


__all__ = ["MemoryPane"]
