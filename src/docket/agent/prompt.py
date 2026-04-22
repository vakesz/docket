"""Prompt assembly.

OpenAI-compatible endpoints cache on exact prefix match, so we keep the prefix layout stable:
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
from docket.config import prompt_templates
from docket.core.model import Comment, Item, MemoryEntry

DEFAULT_SYSTEM_BASE = prompt_templates.DEFAULT_SYSTEM_BASE
DEFAULT_KIND_GUIDANCE = prompt_templates.DEFAULT_KIND_GUIDANCE


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
        template = prompt_templates.get_template("system_base")
        return self._load(template.filename, template.default_text)

    def kind_guidance(self, kind: str) -> str:
        default = DEFAULT_KIND_GUIDANCE.get(kind, "")
        if not default:
            return ""
        template = prompt_templates.get_template(kind)
        return self._load(template.filename, default)

    def _load(self, filename: str, default: str) -> str:
        if self._prompts_dir is None:
            return default
        path = self._prompts_dir / filename
        if not path.exists():
            with self._lock:
                self._cache.pop(filename, None)
            return default
        mtime_ns = path.stat().st_mtime_ns
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


def build_memory_message(entries: list[MemoryEntry]) -> ChatMessage | None:
    """Render the project's memory entries as a single system message.

    Returns None when there are no entries — callers should drop the slot
    entirely so the prompt prefix stays byte-stable across projects that
    happen to have empty memory. The message is plain Markdown sections;
    the model treats it as authoritative reference material."""
    if not entries:
        return None
    lines = [f"PROJECT MEMORY ({len(entries)})"]
    for e in entries:
        header = f"## {e.title}"
        if e.tags:
            header += f"  [{', '.join(e.tags)}]"
        lines.append("")
        lines.append(header)
        if e.body_md:
            lines.append(e.body_md.rstrip())
    return ChatMessage(role="system", content="\n".join(lines))


def build_prefix(
    item: Item,
    comments: list[Comment],
    *,
    memory: list[MemoryEntry] | None = None,
    memory_revision: int = 0,
) -> list[ChatMessage]:
    """Cacheable prefix. Everything after this is turn-specific.

    Memory is inserted between the system base and the snapshot when
    non-empty; an empty memory list collapses to the same two-message
    prefix the original implementation produced, preserving cache hits
    for projects without notes. `memory_revision` is intentionally NOT
    interpolated into any message — it's accepted here so the calling
    layer can pass it through for documentation/cache-key purposes
    without altering the byte stream."""
    messages: list[ChatMessage] = [build_system_message(item)]
    memory_msg = build_memory_message(memory or [])
    if memory_msg is not None:
        messages.append(memory_msg)
    messages.append(build_snapshot_message(item, comments))
    return messages
