"""Prompt assembly.

Foundry caches on exact prefix match, so we keep the prefix layout stable:
  [system: role + item-kind template]
  [ticket snapshot: title, metadata, description, comments]
  --- cacheable boundary ---
  [conversation messages so far]

If the ticket's `updated_at` changes, the snapshot changes and the cache is
invalidated — intended. We DO NOT interpolate dynamic values (timestamps,
scopes, usernames) into the prefix, because they would defeat caching on
what should otherwise be identical tickets.
"""
from __future__ import annotations

from docket.agent.types import ChatMessage
from docket.core.model import Comment, Item


_SYSTEM_BASE = """You are a work-item triage assistant embedded in a developer's terminal.
You help the user understand, update, and triage tickets across their backlog.

Principles:
- Ground every claim in the ticket snapshot or an explicit tool call result. Do not invent fields, ids, or linked work.
- When the user asks for a change (transition, description edit, new item), state the exact proposal in one line and wait for explicit confirmation — mutations are always user-approved.
- Prefer brevity. The user is skimming in a TUI pane; bullets and one-line summaries beat paragraphs.
- If the user's intent is ambiguous, ask one clarifying question rather than guessing.

Tools:
- Use `get_item`, `get_comments`, `get_linked_items`, and `search_items` whenever the ticket snapshot does not already cover the information you need.
- You can safely call multiple read tools in a single turn.
"""


_KIND_GUIDANCE = {
    "epic": "This is an Epic. Focus on scope, dependencies, and whether child Features still map to the original outcome.",
    "feature": "This is a Feature. Focus on acceptance criteria, linked Stories, and whether the Feature is closeable.",
    "story": "This is a User Story. Focus on acceptance criteria, open questions, and the smallest step that unblocks progress.",
    "task": "This is a Task. Focus on what's left to finish and whether it can be closed.",
    "bug": "This is a Bug. Focus on repro, severity, and whether a fix is proposed or in progress.",
}


def build_system_message(item: Item) -> ChatMessage:
    kind_line = _KIND_GUIDANCE.get(item.kind.value, "")
    content = _SYSTEM_BASE.rstrip() + "\n\n" + kind_line
    return ChatMessage(role="system", content=content.strip())


def build_snapshot_message(item: Item, comments: list[Comment]) -> ChatMessage:
    lines = [
        "TICKET SNAPSHOT",
        f"id: {item.id}",
        f"kind: {item.kind.value}",
        f"state: {item.state.value}",
        f"title: {item.title}",
        f"assignee: {item.assignee or '-'}",
        f"parent: {item.parent_id or '-'}",
        f"tags: {', '.join(item.tags) if item.tags else '-'}",
        "",
        "DESCRIPTION",
        item.description_md or "(no description)",
    ]
    if comments:
        lines.append("")
        lines.append(f"COMMENTS ({len(comments)})")
        for c in comments:
            lines.append(f"- {c.author} @ {c.created_at.isoformat()}")
            lines.append(c.body_md)
    return ChatMessage(role="system", content="\n".join(lines))


def build_prefix(item: Item, comments: list[Comment]) -> list[ChatMessage]:
    """Cacheable prefix. Everything after this is turn-specific."""
    return [build_system_message(item), build_snapshot_message(item, comments)]
