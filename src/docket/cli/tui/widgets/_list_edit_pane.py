"""Two-column list+editor modal scaffold shared by memory / source / MCP.

Every pane has the same skeleton: list of entries on the left, form-style
editor on the right, four bindings (save / new / delete / close), the same
button row, the same read-only handling. The differences are which fields
the form exposes, how rows are listed, and what the persistence target is
(SQLite repo for memory + source, `mcp_service` + `config.toml` for MCP).

Subclasses supply:

- `_title`, `_subtitle`, `_hint` — text shown around the body
- `compose_editor()` — yields the form fields for the right column
- `_field_ids()` — widget ids the read-only switch toggles
- `_list_rows()` — `(id, label)` pairs for the ListView
- `_on_select(entry_id)` — populate the form when a row is picked
- `_save()` / `_delete_one(entry_id)` / `_clear_form()` — CRUD adapters

The dismiss value is `True` when anything was committed during the session,
so the parent app can decide whether to rebuild the agent on close. Memory
and source ignore the result; MCP listens for it."""

from __future__ import annotations

from abc import abstractmethod
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, ListItem, ListView, Static


class ListEditRow(ListItem):
    """ListItem carrying the underlying entry id."""

    def __init__(self, entry_id: str, label: str) -> None:
        super().__init__(Static(label))
        self.entry_id = entry_id


class ListEditPane(ModalScreen[bool]):
    """Abstract two-column list+editor modal — see module docstring."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "save", "Save", priority=True),
        Binding("ctrl+n", "new_entry", "New", priority=True),
        Binding("ctrl+d", "delete", "Delete", priority=True),
        Binding("escape", "cancel", "Close", priority=True),
    ]

    DEFAULT_CSS = """
    ListEditPane { align: center middle; }
    ListEditPane > Vertical {
        width: 110;
        max-width: 150;
        height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    ListEditPane #title { height: auto; color: $accent; text-style: bold; }
    ListEditPane #subtitle { height: auto; color: $text-muted; padding-bottom: 1; }
    ListEditPane #body { height: 1fr; }
    ListEditPane #list-col { width: 38; }
    ListEditPane #editor-col { width: 1fr; padding-left: 2; }
    ListEditPane #entries { height: 1fr; border: round $panel-lighten-1; }
    ListEditPane .field-label { height: auto; color: $text-muted; padding-top: 1; }
    ListEditPane #buttons { height: auto; padding-top: 1; }
    ListEditPane #buttons Button { margin-right: 1; }
    ListEditPane #hint { height: auto; color: $text-muted; padding-top: 1; }
    """

    _title: str = ""
    _subtitle: str = ""
    _hint: str = "Ctrl+S save  ·  Ctrl+N new  ·  Ctrl+D delete  ·  Esc close"

    def __init__(self, *, read_only: bool = False) -> None:
        super().__init__()
        self._read_only = read_only
        self._current_id: str | None = None
        self._dirty = False

    # -- composition -----------------------------------------------------

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static(self._title, id="title")
            yield Static(self._subtitle, id="subtitle")
            with Horizontal(id="body"):
                with Vertical(id="list-col"):
                    yield Static("entries", classes="field-label")
                    yield ListView(id="entries")
                with Vertical(id="editor-col"):
                    yield from self.compose_editor()
                    with Horizontal(id="buttons"):
                        yield from self.compose_buttons()
            yield Static(self._hint, id="hint")

    @abstractmethod
    def compose_editor(self) -> ComposeResult: ...

    def compose_buttons(self) -> ComposeResult:
        yield Button("Save", id="save-btn", variant="primary")
        yield Button("New", id="new-btn")
        yield Button("Delete", id="delete-btn", variant="error")
        yield Button("Close", id="close-btn")

    # -- subclass hooks --------------------------------------------------

    @abstractmethod
    def _field_ids(self) -> tuple[str, ...]: ...

    @abstractmethod
    def _list_rows(self) -> list[tuple[str, str]]: ...

    @abstractmethod
    def _on_select(self, entry_id: str) -> None: ...

    @abstractmethod
    def _save(self) -> str | None:
        """Persist the form. Return the entry id to reselect, or None on
        validation error / no-op (the subclass already toasted)."""

    @abstractmethod
    def _delete_one(self, entry_id: str) -> bool: ...

    @abstractmethod
    def _clear_form(self) -> None: ...

    def _set_editor_enabled(self, enabled: bool) -> None:
        for widget_id in self._field_ids():
            self.query_one(f"#{widget_id}").disabled = not enabled
        for btn in self.query("#buttons Button").results(Button):
            if btn.id != "close-btn":
                btn.disabled = not enabled

    # -- lifecycle / events ---------------------------------------------

    def on_mount(self) -> None:
        self._reload(select_id=None)
        if self._read_only:
            self._set_editor_enabled(False)

    def _reload(self, *, select_id: str | None) -> None:
        rows = self._list_rows()
        view = self.query_one("#entries", ListView)
        view.clear()
        for entry_id, label in rows:
            view.append(ListEditRow(entry_id, label))
        if select_id and any(eid == select_id for eid, _ in rows):
            view.index = next(i for i, (eid, _) in enumerate(rows) if eid == select_id)
            self._on_select(select_id)
        elif rows:
            view.index = 0
            self._on_select(rows[0][0])
        else:
            self._current_id = None
            self._clear_form()

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, ListEditRow):
            self._on_select(item.entry_id)

    def on_button_pressed(self, event: Button.Pressed) -> None:
        match event.button.id:
            case "save-btn":
                self.action_save()
            case "new-btn":
                self.action_new_entry()
            case "delete-btn":
                self.action_delete()
            case "close-btn":
                self.action_cancel()

    # -- actions ---------------------------------------------------------

    def action_new_entry(self) -> None:
        if self._read_only:
            return
        self._current_id = None
        self._clear_form()

    def action_save(self) -> None:
        if self._read_only:
            return
        new_id = self._save()
        if new_id is None:
            return
        self._dirty = True
        self._reload(select_id=new_id)

    def action_delete(self) -> None:
        if self._read_only or self._current_id is None:
            return
        if self._delete_one(self._current_id):
            self._dirty = True
        self._reload(select_id=None)

    def action_cancel(self) -> None:
        self.dismiss(self._dirty)


__all__ = ["ListEditPane", "ListEditRow"]
