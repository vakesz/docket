from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import ClassVar

from rich.segment import Segment
from rich.style import Style
from rich.text import Text
from textual.message import Message
from textual.strip import Strip
from textual.widgets import Tree
from textual.widgets.tree import TreeNode

from docket.core.model import Item, ItemKind, ItemState

_KIND_ORDER = [ItemKind.EPIC, ItemKind.FEATURE, ItemKind.STORY, ItemKind.TASK, ItemKind.BUG]
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

    def __init__(self, *, id: str | None = None, stale_threshold_days: int | None = None) -> None:
        super().__init__("Work Items", id=id)
        self.show_root = False
        # None disables the marker (threshold <= 0 also disables — same effect).
        self.stale_threshold_days = stale_threshold_days
        self._rows: dict[str, _ItemRow] = {}
        self.tooltip = "Browse work items. Use the arrow keys to move and Enter to open the focused item."

    def load_items(self, items: Iterable[Item]) -> None:
        self.clear()
        self._rows = {}
        sorted_items = sorted(
            items,
            key=lambda item: (
                item.kind.value,
                -(item.updated_at.timestamp() if item.updated_at else 0),
                item.title.lower(),
            ),
        )
        by_id: dict[str, Item] = {i.id: i for i in sorted_items}
        if not by_id:
            self.root.add("[dim]No items[/dim]", expand=True)
            return
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

        available_width = max(1, self.size.width - self._guide_width_for_node(node))
        prefix = Text()
        if node.allow_expand:
            prefix.append(self.ICON_NODE_EXPANDED if node.is_expanded else self.ICON_NODE, style=base_style)

        age_days = _age_days(row.updated_at)
        age_label = f"{age_days}d" if age_days is not None else ""
        age_width = len(age_label)
        gap_width = 1 if age_label else 0
        main_width = max(1, available_width - prefix.cell_len - age_width - gap_width)

        state_style = style + self.get_component_rich_style(_STATE_STYLE[row.state], partial=True)
        title = Text()
        title.append(f"{_STATE_DOT[row.state]} ", style=state_style)
        title.append(row.item_id, style=style + Style(dim=True))
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
        segments = list(Segment.apply_style(strip._segments, post_style=Style(bgcolor=cursor_style.bgcolor)))
        return Strip(segments, strip.cell_length)

    def get_label_width(self, node: TreeNode[str]) -> int:
        available_width = max(1, self.size.width - self._guide_width_for_node(node))
        return min(super().get_label_width(node), available_width)

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
        parts = [item.id, item.title]
        age_days = _age_days(item.updated_at)
        if age_days is not None:
            parts.append(f"{age_days}d")
        return "  ".join(parts)


def _age_days(updated_at: datetime | None) -> int | None:
    if updated_at is None:
        return None
    if updated_at.tzinfo is None:
        updated_at = updated_at.replace(tzinfo=UTC)
    return max(0, (datetime.now(UTC) - updated_at).days)
