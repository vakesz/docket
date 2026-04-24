"""Shared base for the two-column "list on the left, editor on the right" modals.

`MemoryPane` and `SourcePane` both need: a list of entries, a body-plus-metadata
editor, save/new/delete buttons, identical key bindings, and the same read-only
handling. The only real differences are which repo they hit, which extra fields
their form exposes, and the noun they use in user-facing messages.

Subclasses supply:
- `compose()` — full layout including the extra form fields
- `_entity_noun()` — e.g. "memory" / "source"
- `_field_ids()` — widget ids to enable/disable with read-only
- `_list()`, `_delete_entry()`, `_save_new()`, `_save_update()` — repo adapters
- `_entry_id()`, `_entry_label()` — list row rendering
- `_load_into_editor()`, `_clear_editor_fields()` — form I/O

The base owns binding/button dispatch, list reload, save flow, read-only
messaging, and editor enable/disable. Both panes together drop by ~150 lines."""

from __future__ import annotations

import sqlite3
from abc import abstractmethod
from typing import ClassVar

from textual.binding import Binding, BindingType
from textual.screen import ModalScreen
from textual.widgets import Button, Input, ListItem, ListView, Static, TextArea


class ListEditRow(ListItem):
    """ListItem that carries the underlying entry id."""

    def __init__(self, entry_id: str, label: str) -> None:
        super().__init__(Static(label))
        self.entry_id = entry_id


class ListEditPane[T](ModalScreen[None]):
    """Abstract two-column list-plus-editor modal — see module docstring."""

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
        self._entries: list[T] = []
        self._current_id: str | None = None  # None = unsaved/new

    # -- hooks the subclass must implement --------------------------------

    @abstractmethod
    def _entity_noun(self) -> str: ...

    @abstractmethod
    def _field_ids(self) -> tuple[str, ...]: ...

    @abstractmethod
    def _list(self) -> list[T]: ...

    @abstractmethod
    def _entry_id(self, entry: T) -> str: ...

    @abstractmethod
    def _entry_label(self, entry: T) -> str: ...

    @abstractmethod
    def _load_into_editor(self, entry: T) -> None: ...

    @abstractmethod
    def _clear_editor_fields(self) -> None: ...

    @abstractmethod
    def _save_new(self, *, title: str, body_md: str, tags: list[str]) -> T: ...

    @abstractmethod
    def _save_update(
        self, entry_id: str, *, title: str, body_md: str, tags: list[str]
    ) -> T | None: ...

    @abstractmethod
    def _delete_entry(self, entry_id: str) -> bool: ...

    # -- shared implementation -------------------------------------------

    def on_mount(self) -> None:
        self._reload_entries(select_id=None)
        if self._read_only:
            self._set_editor_enabled(False)
            self.app.notify(
                f"Read-only mode — {self._entity_noun()} edits are disabled.",
                severity="warning",
            )

    def _reload_entries(self, *, select_id: str | None) -> None:
        self._entries = self._list()
        view = self.query_one("#entries", ListView)
        view.clear()
        for entry in self._entries:
            view.append(ListEditRow(self._entry_id(entry), self._entry_label(entry)))
        if select_id is not None:
            for index, entry in enumerate(self._entries):
                if self._entry_id(entry) == select_id:
                    view.index = index
                    self._load_into_editor(entry)
                    return
        if self._entries:
            view.index = 0
            self._load_into_editor(self._entries[0])
        else:
            self._clear_editor()

    def _clear_editor(self) -> None:
        self._current_id = None
        self._clear_editor_fields()

    def _set_editor_enabled(self, enabled: bool) -> None:
        for widget_id in self._field_ids():
            self.query_one(f"#{widget_id}").disabled = not enabled
        for btn_id in ("save-btn", "new-btn", "delete-btn"):
            self.query_one(f"#{btn_id}", Button).disabled = not enabled

    # -- events -----------------------------------------------------------

    def on_list_view_selected(self, event: ListView.Selected) -> None:
        item = event.item
        if isinstance(item, ListEditRow):
            entry = next(
                (e for e in self._entries if self._entry_id(e) == item.entry_id),
                None,
            )
            if entry is not None:
                self._load_into_editor(entry)

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

    # -- actions ----------------------------------------------------------

    def action_new_entry(self) -> None:
        if self._read_only:
            return
        self._clear_editor()
        self.query_one("#title-input", Input).focus()

    def action_cancel(self) -> None:
        self.dismiss(None)

    def action_delete(self) -> None:
        if self._read_only or self._current_id is None:
            return
        ok = self._delete_entry(self._current_id)
        if ok:
            self.app.notify(f"Removed {self._entity_noun()}.", severity="information")
        self._reload_entries(select_id=None)

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
                entry = self._save_new(title=title, body_md=body_md, tags=tags)
                self.app.notify(f"Added '{title}'.", severity="information")
                self._reload_entries(select_id=self._entry_id(entry))
            else:
                updated = self._save_update(
                    self._current_id, title=title, body_md=body_md, tags=tags
                )
                if updated is None:
                    self.app.notify(
                        f"{self._entity_noun().capitalize()} vanished — refreshing.",
                        severity="warning",
                    )
                    self._reload_entries(select_id=None)
                    return
                self.app.notify(f"Saved '{title}'.", severity="information")
                self._reload_entries(select_id=self._entry_id(updated))
        except KeyError as e:
            self.app.notify(str(e), severity="error")


__all__ = ["ListEditPane", "ListEditRow"]
