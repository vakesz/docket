from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import ClassVar, Literal

from rich.segment import Segment
from rich.style import Style
from rich.text import Text
from textual.message import Message
from textual.strip import Strip
from textual.widgets import Tree
from textual.widgets.tree import TreeNode

from docket.core.model import Item, ItemKind, ItemState

GroupingStrategy = Literal["by_kind", "by_state_bucket"]

_KIND_ORDER = [ItemKind.EPIC, ItemKind.FEATURE, ItemKind.STORY, ItemKind.TASK, ItemKind.BUG]

# Mirrors `STATE_BUCKETS` in frontend/src/components/items/ItemsList.tsx.
# Keep the two in sync — they're the shared definition of "Open" vs "Done".
_OPEN_STATES: frozenset[ItemState] = frozenset(
    {ItemState.NEW, ItemState.ACTIVE, ItemState.BLOCKED, ItemState.NEEDS_INFO}
)
_DONE_STATES: frozenset[ItemState] = frozenset({ItemState.RESOLVED, ItemState.CLOSED})
_STATE_STYLE = {
    ItemState.NEW: "item-tree--state-new",
    ItemState.ACTIVE: "item-tree--state-active",
    ItemState.BLOCKED: "item-tree--state-blocked",
    ItemState.NEEDS_INFO: "item-tree--state-needs-info",
    ItemState.RESOLVED: "item-tree--state-resolved",
    ItemState.CLOSED: "item-tree--state-closed",
}
_STATE_DOT = {
    ItemState.NEW: "◦",
    ItemState.ACTIVE: "●",
    ItemState.BLOCKED: "●",
    ItemState.NEEDS_INFO: "●",
    ItemState.RESOLVED: "●",
    ItemState.CLOSED: "●",
}


@dataclass(frozen=True)
class _ItemRow:
    item_id: str
    title: str
    state: ItemState
    updated_at: datetime | None


class ItemSelected(Message):
    def __init__(self, item_id: str) -> None:
        super().__init__()
        self.item_id = item_id


class ItemTree(Tree[str]):
    """Work-item hierarchy: groups by kind at the top level, then by parent_id under each."""

    COMPONENT_CLASSES: ClassVar[set[str]] = Tree.COMPONENT_CLASSES | {
        "item-tree--state-new",
        "item-tree--state-active",
        "item-tree--state-blocked",
        "item-tree--state-needs-info",
        "item-tree--state-resolved",
        "item-tree--state-closed",
        "item-tree--age-fresh",
        "item-tree--age-warning",
        "item-tree--age-stale",
    }

    DEFAULT_CSS = """
    ItemTree {
        padding: 0 2 1 2;
        background: transparent;
        color: $text;
        overflow-x: hidden;
        scrollbar-size-vertical: 1;
    }
    ItemTree > .item-tree--state-new { color: $text-secondary; }
    ItemTree > .item-tree--state-active { color: $text-success; }
    ItemTree > .item-tree--state-blocked { color: $text-warning; }
    ItemTree > .item-tree--state-needs-info { color: $text-accent; }
    ItemTree > .item-tree--state-resolved { color: $text-primary; }
    ItemTree > .item-tree--state-closed { color: $text-disabled; }
    ItemTree > .item-tree--age-fresh { color: $text-muted; }
    ItemTree > .item-tree--age-warning {
        color: $text-warning;
        text-style: bold;
    }
    ItemTree > .item-tree--age-stale {
        color: $text-error;
        text-style: bold;
    }
    """

    def __init__(
        self,
        *,
        id: str | None = None,
        stale_threshold_days: int | None = None,
        grouping: GroupingStrategy = "by_kind",
    ) -> None:
        super().__init__("Work Items", id=id)
        self.show_root = False
        # None disables the marker (threshold <= 0 also disables — same effect).
        self.stale_threshold_days = stale_threshold_days
        self._rows: dict[str, _ItemRow] = {}
        self._pinned_ids: frozenset[str] = frozenset()
        self.grouping: GroupingStrategy = grouping
        self.tooltip = "Browse work items. Use the arrow keys to move and Enter to open the focused item. `w` to pin/unpin."

    def load_items(
        self,
        items: Iterable[Item],
        *,
        pinned: Iterable[Item] | None = None,
        grouping: GroupingStrategy | None = None,
    ) -> None:
        """Render the tree. `pinned` adds a top-level "Pinned" section ordered
        by pin time (caller is responsible for that ordering) — those rows
        stay visible across scope switches so they double as a personal
        shortcut bar.

        `grouping` lets the caller switch strategies per render without
        rebuilding the widget; when omitted, the strategy passed to
        `__init__` (or set later via `self.grouping`) is used."""
        self.clear()
        self._rows = {}
        if grouping is not None:
            self.grouping = grouping
        sorted_items = sorted(
            items,
            key=lambda item: (
                item.kind.value,
                -(item.updated_at.timestamp() if item.updated_at else 0),
                item.title.lower(),
            ),
        )
        by_id: dict[str, Item] = {i.id: i for i in sorted_items}

        pinned_list = list(pinned or [])
        self._pinned_ids = frozenset(p.id for p in pinned_list)
        if pinned_list:
            pinned_node = self.root.add(f"📌 Pinned {len(pinned_list)}", expand=True)
            for pin_item in pinned_list:
                self._rows[pin_item.id] = _ItemRow(
                    item_id=pin_item.id,
                    title=pin_item.title,
                    state=pin_item.state,
                    updated_at=pin_item.updated_at,
                )
                pinned_node.add(
                    self._plain_row_label(pin_item),
                    data=pin_item.id,
                    allow_expand=False,
                )

        if not by_id:
            if not pinned_list:
                self.root.add("[dim]No items[/dim]", expand=True)
            return

        if self.grouping == "by_state_bucket":
            self._render_state_bucket_groups(by_id)
        else:
            self._render_kind_groups(by_id)

    def _render_kind_groups(self, by_id: dict[str, Item]) -> None:
        """Azure-DevOps-style grouping: Epic/Feature/Story/Task/Bug → parent → child."""
        kind_nodes: dict[ItemKind, TreeNode[str]] = {}
        for kind in _KIND_ORDER:
            count = sum(1 for item in by_id.values() if item.kind == kind)
            label = f"{kind.value.title()}s {count}"
            kind_nodes[kind] = self.root.add(label, expand=True)

        # First pass: render roots (no parent or parent not in snapshot) under their kind bucket.
        placed: set[str] = set()
        for item in by_id.values():
            if item.parent_id and item.parent_id in by_id:
                continue
            self._add_item_recursive(kind_nodes[item.kind], item, by_id, placed)

        # Second pass: items whose parent is in the snapshot but was never placed
        # (parent belongs to a different kind bucket). Attach them under the parent we can find,
        # otherwise under their own kind bucket so they never go missing.
        for item in by_id.values():
            if item.id in placed:
                continue
            self._add_item_recursive(kind_nodes[item.kind], item, by_id, placed)

    def _render_state_bucket_groups(self, by_id: dict[str, Item]) -> None:
        """GitHub-style grouping: Open vs Done. No kind sub-buckets, no parent
        nesting — the hierarchy would mostly be empty for flat providers."""
        open_items = [i for i in by_id.values() if i.state in _OPEN_STATES]
        done_items = [i for i in by_id.values() if i.state in _DONE_STATES]
        # `_add_item_flat` below doesn't walk parents, so every placed item is
        # accounted for by bucket membership alone.
        open_node = self.root.add(f"Open {len(open_items)}", expand=True)
        # Collapse Done by default — it's usually the larger set and users
        # opened the TUI to triage what's still actionable.
        done_node = self.root.add(f"Done {len(done_items)}", expand=False)
        for item in open_items:
            self._add_item_flat(open_node, item)
        for item in done_items:
            self._add_item_flat(done_node, item)

    def _add_item_flat(self, parent_node: TreeNode[str], item: Item) -> None:
        self._rows[item.id] = _ItemRow(
            item_id=item.id,
            title=item.title,
            state=item.state,
            updated_at=item.updated_at,
        )
        parent_node.add(
            self._plain_row_label(item),
            data=item.id,
            allow_expand=False,
        )

    def pinned_ids(self) -> frozenset[str]:
        """Which ids were last drawn under the Pinned section."""
        return self._pinned_ids

    def _add_item_recursive(
        self,
        parent_node: TreeNode[str],
        item: Item,
        by_id: dict[str, Item],
        placed: set[str],
    ) -> None:
        if item.id in placed:
            return
        children = sorted(
            (c for c in by_id.values() if c.parent_id == item.id),
            key=lambda child: (
                -(child.updated_at.timestamp() if child.updated_at else 0),
                child.title.lower(),
            ),
        )
        self._rows[item.id] = _ItemRow(
            item_id=item.id,
            title=item.title,
            state=item.state,
            updated_at=item.updated_at,
        )
        label = self._plain_row_label(item)
        node = parent_node.add(
            label,
            data=item.id,
            expand=bool(children),
            allow_expand=bool(children),
        )
        placed.add(item.id)
        for child in children:
            self._add_item_recursive(node, child, by_id, placed)

    def render_label(self, node: TreeNode[str], base_style: Style, style: Style) -> Text:
        item_id = node.data if isinstance(node.data, str) else None
        row = self._rows.get(item_id) if item_id else None
        if row is None:
            return super().render_label(node, base_style, style)

        available_width = max(
            1, self.size.width - self._guide_width_for_node(node) - self._scrollbar_reserve()
        )
        prefix = Text()
        if node.allow_expand:
            prefix.append(
                self.ICON_NODE_EXPANDED if node.is_expanded else self.ICON_NODE, style=base_style
            )

        age_days = _age_days(row.updated_at)
        threshold = self.stale_threshold_days
        if (
            age_days is not None
            and threshold is not None
            and threshold > 0
            and age_days >= threshold
        ):
            age_label = f"stale {age_days}d"
        elif age_days is not None:
            age_label = f"{age_days}d"
        else:
            age_label = ""
        age_width = len(age_label)
        gap_width = 1 if age_label else 0
        main_width = max(1, available_width - prefix.cell_len - age_width - gap_width)

        state_style = style + self.get_component_rich_style(_STATE_STYLE[row.state], partial=True)
        title = Text()
        title.append(f"{_STATE_DOT[row.state]} ", style=state_style)
        title.append(_display_item_id(row.item_id), style=style + Style(dim=True))
        title.append(" ")
        title.append(row.title, style=style)
        title.truncate(main_width, overflow="ellipsis")

        label = Text.assemble(prefix, title)
        if age_label:
            padding = max(1, available_width - label.cell_len - age_width)
            label.append(" " * padding, style=style)
            label.append(age_label, style=self._age_style(style, age_days))
        return label

    def render_line(self, y: int) -> Strip:
        strip = super().render_line(y)
        line_index = y + self.scroll_offset[1]
        if line_index != self.cursor_line:
            return strip
        cursor_style = self.get_component_rich_style("tree--cursor", partial=False)
        if cursor_style.bgcolor is None:
            return strip
        segments = list(
            Segment.apply_style(strip._segments, post_style=Style(bgcolor=cursor_style.bgcolor))
        )
        return Strip(segments, strip.cell_length)

    def get_label_width(self, node: TreeNode[str]) -> int:
        available_width = max(
            1, self.size.width - self._guide_width_for_node(node) - self._scrollbar_reserve()
        )
        return min(super().get_label_width(node), available_width)

    def _scrollbar_reserve(self) -> int:
        """Cells reserved on the right for the vertical scrollbar.

        `self.size.width` includes the scrollbar column when one is visible;
        drawing into that column gets covered by the bar. Reserve it so
        trailing characters (e.g. the "d" on "13d") stay visible when the
        scrollbar is up, and reclaim the column when the list is short enough
        that no scrollbar is drawn — otherwise the tree would look 1 col
        narrower than the search box above it even in that case."""
        if not self.show_vertical_scrollbar:
            return 0
        size = self.styles.scrollbar_size_vertical
        return int(size) if size is not None else 1

    def on_tree_node_selected(self, event: Tree.NodeSelected[str]) -> None:
        data = event.node.data
        if isinstance(data, str):
            self.post_message(ItemSelected(data))

    def _age_style(self, base_style: Style, age_days: int | None) -> Style:
        component = "item-tree--age-fresh"
        threshold = self.stale_threshold_days
        if age_days is not None and threshold is not None and threshold > 0:
            if age_days >= threshold * 2:
                component = "item-tree--age-stale"
            elif age_days >= threshold:
                component = "item-tree--age-warning"
        return base_style + self.get_component_rich_style(component, partial=True)

    def _guide_width_for_node(self, node: TreeNode[str]) -> int:
        depth = 0
        parent = node.parent
        while parent is not None and (self.show_root or not parent.is_root):
            depth += 1
            parent = parent.parent
        return depth * self.guide_depth

    def first_visible_item_node(self) -> TreeNode[str] | None:
        def walk(node: TreeNode[str]) -> TreeNode[str] | None:
            for child in node.children:
                if isinstance(child.data, str):
                    return child
                if child.is_expanded:
                    found = walk(child)
                    if found is not None:
                        return found
            return None

        return walk(self.root)

    def _plain_row_label(self, item: Item) -> str:
        parts = [_display_item_id(item.id), item.title]
        age_days = _age_days(item.updated_at)
        if age_days is not None:
            parts.append(f"{age_days}d")
        return "  ".join(parts)


def _display_item_id(item_id: str) -> str:
    if "#" in item_id:
        return f"#{item_id.rsplit('#', 1)[1]}"
    return item_id


def _age_days(updated_at: datetime | None) -> int | None:
    if updated_at is None:
        return None
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    return max(0, (datetime.now(UTC) - updated_at).days)
