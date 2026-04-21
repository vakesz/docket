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

Hot-reload: the system template and per-kind guidance can be overridden by
dropping `system_base.md` or `kind_<kind>.md` into `<config_dir>/prompts/`.
The loader reads file mtimes each call, so edits are picked up on the next
agent turn without restarting the app. Cache invalidation is keyed on
(path, mtime_ns); re-reads only happen when a file actually changed.
"""
from __future__ import annotations

from pathlib import Path
from threading import Lock

from docket.agent.types import ChatMessage
from docket.core.model import Comment, Item


DEFAULT_SYSTEM_BASE = """You are a work-item triage assistant embedded in a developer's terminal.
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


DEFAULT_KIND_GUIDANCE: dict[str, str] = {
    "epic": "This is an Epic. Focus on scope, dependencies, and whether child Features still map to the original outcome.",
    "feature": "This is a Feature. Focus on acceptance criteria, linked Stories, and whether the Feature is closeable.",
    "story": "This is a User Story. Focus on acceptance criteria, open questions, and the smallest step that unblocks progress.",
    "task": "This is a Task. Focus on what's left to finish and whether it can be closed.",
    "bug": "This is a Bug. Focus on repro, severity, and whether a fix is proposed or in progress.",
}


class PromptLoader:
    """Reads the system template + per-kind guidance from disk, with fallbacks.

    One instance per process; call `configure(prompts_dir)` at startup to wire
    it to a directory. Unconfigured (prompts_dir=None) means "always use the
    built-in defaults" — that's what tests and headless callers get."""

    def __init__(self, prompts_dir: Path | None = None) -> None:
        self._prompts_dir = prompts_dir
        self._cache: dict[str, tuple[int, str]] = {}  # filename -> (mtime_ns, text)
        self._lock = Lock()

    def configure(self, prompts_dir: Path | None) -> None:
        """Point the loader at a new directory. Clears the cache so subsequent
        reads re-check the filesystem from scratch."""
        with self._lock:
            self._prompts_dir = prompts_dir
            self._cache.clear()

    def system_base(self) -> str:
        return self._load("system_base.md", DEFAULT_SYSTEM_BASE)

    def kind_guidance(self, kind: str) -> str:
        default = DEFAULT_KIND_GUIDANCE.get(kind, "")
        return self._load(f"kind_{kind}.md", default)

    def _load(self, filename: str, default: str) -> str:
        if self._prompts_dir is None:
            return default
        path = self._prompts_dir / filename
        try:
            mtime_ns = path.stat().st_mtime_ns
        except FileNotFoundError:
            with self._lock:
                # Drop any stale cache entry so deleting the override returns
                # us cleanly to the default on the next call.
                self._cache.pop(filename, None)
            return default
        with self._lock:
            cached = self._cache.get(filename)
            if cached is not None and cached[0] == mtime_ns:
                return cached[1]
        text = path.read_text(encoding="utf-8")
        with self._lock:
            self._cache[filename] = (mtime_ns, text)
        return text


_loader = PromptLoader()


def configure_prompt_loader(prompts_dir: Path | None) -> None:
    """Module-level hook used by `docket open` / `docket serve` at startup."""
    _loader.configure(prompts_dir)


def get_prompt_loader() -> PromptLoader:
    """Exposed for tests; app code should rely on the module-level helpers."""
    return _loader


def build_system_message(item: Item) -> ChatMessage:
    kind_line = _loader.kind_guidance(item.kind.value)
    content = _loader.system_base().rstrip() + "\n\n" + kind_line
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
