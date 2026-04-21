from __future__ import annotations

from collections.abc import Iterable
from datetime import UTC, datetime

from textual.message import Message
from textual.widgets import Tree
from textual.widgets.tree import TreeNode

from docket.core.model import Item, ItemKind

_KIND_ORDER = [ItemKind.EPIC, ItemKind.FEATURE, ItemKind.STORY, ItemKind.TASK, ItemKind.BUG]
_KIND_ICON = {
    ItemKind.EPIC: "📚",
    ItemKind.FEATURE: "🧩",
    ItemKind.STORY: "📘",
    ItemKind.TASK: "🔧",
    ItemKind.BUG: "🐞",
}


class ItemSelected(Message):
    def __init__(self, item_id: str) -> None:
        super().__init__()
        self.item_id = item_id


class ItemTree(Tree[str]):
    """Work-item hierarchy: groups by kind at the top level, then by parent_id under each."""

    def __init__(self, *, id: str | None = None, stale_threshold_days: int | None = None) -> None:
        super().__init__("Work Items", id=id)
        self.show_root = False
        # None disables the marker (threshold <= 0 also disables — same effect).
        self.stale_threshold_days = stale_threshold_days

    def load_items(self, items: Iterable[Item]) -> None:
        self.clear()
        by_id: dict[str, Item] = {i.id: i for i in items}
        kind_nodes: dict[ItemKind, TreeNode[str]] = {}
        for kind in _KIND_ORDER:
            label = f"{_KIND_ICON[kind]} {kind.value.title()}s"
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
        label = f"[{item.state.value}] {item.id} — {item.title}"
        stale_days = self._stale_days(item)
        if stale_days is not None:
            label += f" [dim italic red]STALE - {stale_days}d[/]"
        node = parent_node.add(label, data=item.id, expand=True)
        placed.add(item.id)
        children = [c for c in by_id.values() if c.parent_id == item.id]
        for child in children:
            self._add_item_recursive(node, child, by_id, placed)

    def on_tree_node_selected(self, event: Tree.NodeSelected[str]) -> None:
        data = event.node.data
        if isinstance(data, str):
            self.post_message(ItemSelected(data))

    def _stale_days(self, item: Item) -> int | None:
        """Days since `updated_at` if past the threshold, else None.

        `updated_at` is nullable in the canonical model (old cache rows from
        before M1 timestamps, custom providers that skip it), and may come
        back tz-naive from a badly-behaved provider — both cases skip the
        marker rather than crash the tree."""
        threshold = self.stale_threshold_days
        if threshold is None or threshold <= 0:
            return None
        updated = item.updated_at
        if updated is None:
            return None
        if updated.tzinfo is None:
            updated = updated.replace(tzinfo=UTC)
        age_days = (datetime.now(UTC) - updated).days
        return age_days if age_days >= threshold else None
