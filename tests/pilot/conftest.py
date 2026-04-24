"""Shared helpers for Textual pilot tests.

Each pilot test needs to walk the `ItemTree` to locate a node for a given
item id so the pilot can drive a selection. The traversal is identical
across files — keep one copy here."""

from __future__ import annotations

from typing import Any

from textual.widgets.tree import TreeNode


def find_node(node: TreeNode[Any], target_id: str) -> TreeNode[Any] | None:
    """Depth-first search for the tree node whose `data` matches `target_id`."""
    for child in node.children:
        if child.data == target_id:
            return child
        found = find_node(child, target_id)
        if found is not None:
            return found
    return None


def find_label(node: TreeNode[Any], target_id: str) -> str | None:
    """Return the rendered label of the node with `data == target_id`, or None."""
    match = find_node(node, target_id)
    return None if match is None else str(match.label)
