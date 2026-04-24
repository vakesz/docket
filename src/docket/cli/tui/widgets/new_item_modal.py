"""New-ticket form modal.

Triggered by `n` in the main app. Collects kind + title + description (plus
optional parent / assignee / tags), surfaces duplicate candidates from the
FTS5 cache as the user types the title, and funnels the result through the
same proposal-first pipeline as any other write.

Dismissal:
  - `NewItemRequest(kind, fields)` on submit
  - `None` on escape/cancel

The caller is responsible for staging the proposal and opening the diff
modal — the form only collects input. Matching the pattern keeps the
confirm-gate invariant intact.
"""

from __future__ import annotations

import sqlite3
from dataclasses import dataclass
from typing import ClassVar

from textual.app import ComposeResult
from textual.binding import Binding, BindingType
from textual.containers import Vertical, VerticalScroll
from textual.screen import ModalScreen
from textual.widgets import Input, Select, Static, TextArea

from docket.core.model import CreateFields, ItemKind
from docket.storage.repos import item_repo, search_repo

_DUPLICATE_LIMIT = 5


@dataclass
class NewItemRequest:
    kind: ItemKind
    fields: CreateFields


class NewItemModal(ModalScreen["NewItemRequest | None"]):
    """Collect kind + title + description for a new work item.

    `ctrl+s` submits (or `Enter` on the title/parent/assignee/tags fields —
    but not on the description, since multi-line editing wants the key).
    `Esc` cancels."""

    BINDINGS: ClassVar[list[BindingType]] = [
        Binding("ctrl+s", "submit", "Create", priority=True),
        Binding("escape", "cancel", "Cancel", priority=True),
    ]

    DEFAULT_CSS = """
    NewItemModal { align: center middle; }
    NewItemModal > Vertical {
        width: 80%;
        max-width: 120;
        height: auto;
        max-height: 90%;
        background: $surface;
        border: round $accent;
        padding: 1 2;
    }
    NewItemModal #title-label,
    NewItemModal #kind-label,
    NewItemModal #desc-label,
    NewItemModal #meta-label { color: $text-muted; padding-top: 1; height: 1; }
    NewItemModal #kind-row { height: 3; }
    NewItemModal #desc { height: 8; border: round $panel-lighten-2; }
    NewItemModal #duplicates {
        height: auto;
        max-height: 6;
        color: $warning;
        padding: 0 1;
    }
    NewItemModal #hint,
    NewItemModal #footer-hint { color: $text-muted; padding-top: 1; height: auto; }
    """

    def __init__(
        self,
        conn: sqlite3.Connection,
        *,
        default_kind: ItemKind = ItemKind.TASK,
        provider_key: str = "",
    ) -> None:
        super().__init__()
        self._conn = conn
        self._default_kind = default_kind
        self._provider_key = provider_key

    def compose(self) -> ComposeResult:
        with Vertical():
            yield Static("[b]New work item[/b]", id="source")
            yield Static(
                "Create a ticket, check for duplicates, then review the proposal before anything is written.",
                id="hint",
            )
            yield Static("kind", id="kind-label")
            kind_picker = Select(
                options=[(k.value, k) for k in ItemKind],
                prompt="select a kind",
                value=self._default_kind,
                id="kind",
            )
            kind_picker.tooltip = "Choose the item type that best matches the work."
            yield kind_picker
            yield Static("title", id="title-label")
            title = Input(placeholder="short title", id="title")
            title.tooltip = "Keep the title short and specific so duplicate detection stays useful."
            yield title
            yield VerticalScroll(id="duplicates")
            yield Static("description (markdown)", id="desc-label")
            desc = TextArea("", id="desc")
            desc.tooltip = (
                "Describe the work in Markdown. This is the main body the reviewer will see."
            )
            yield desc
            yield Static("parent id · assignee · tags (comma-separated)", id="meta-label")
            yield Input(placeholder="parent id (optional)", id="parent")
            yield Input(placeholder="assignee (optional)", id="assignee")
            yield Input(placeholder="tags (optional, comma-separated)", id="tags")
            yield Static(
                "[b]ctrl+s[/b] create  ·  [b]esc[/b] cancel  ·  tab to advance fields",
                id="footer-hint",
            )

    def on_mount(self) -> None:
        self.query_one("#title", Input).focus()

    def on_input_changed(self, event: Input.Changed) -> None:
        """Re-run the duplicate check whenever the title changes."""
        if event.input.id != "title":
            return
        self._refresh_duplicates(event.value or "")

    def _refresh_duplicates(self, title: str) -> None:
        container = self.query_one("#duplicates", VerticalScroll)
        container.remove_children()
        stripped = title.strip()
        if len(stripped) < 3:
            # Typing ahead — don't spam the user with noise matches.
            return
        ids = search_repo.search_similar(self._conn, stripped, provider_key=self._provider_key)[
            :_DUPLICATE_LIMIT
        ]
        if not ids:
            return
        container.mount(Static(f"[b]possible duplicates[/b] ({len(ids)}):"))
        for iid in ids:
            item = item_repo.get_item(self._conn, iid, provider_key=self._provider_key)
            if item is None:
                continue
            # Escape id in brackets so Rich doesn't treat it as markup.
            container.mount(Static(f"  · \\[{item.id}] {item.title} — {item.state.value}"))

    def action_submit(self) -> None:
        kind_value = self.query_one("#kind", Select).value
        title = (self.query_one("#title", Input).value or "").strip()
        if kind_value is Select.BLANK or not title:
            self.app.notify("kind and title are required", severity="warning")
            return
        if not isinstance(kind_value, ItemKind):
            self.app.notify("kind must be selected", severity="warning")
            return
        description_md = self.query_one("#desc", TextArea).text
        parent_id = (self.query_one("#parent", Input).value or "").strip() or None
        assignee = (self.query_one("#assignee", Input).value or "").strip() or None
        tags_raw = (self.query_one("#tags", Input).value or "").strip()
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()] if tags_raw else []
        fields = CreateFields(
            title=title,
            description_md=description_md,
            parent_id=parent_id,
            assignee=assignee,
            tags=tags,
        )
        self.dismiss(NewItemRequest(kind=kind_value, fields=fields))

    def action_cancel(self) -> None:
        self.dismiss(None)
