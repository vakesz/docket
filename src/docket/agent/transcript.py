"""Render a conversation to Markdown and pick the next attachment filename.

Filename convention: `convo-001.md`, `convo-002.md`, ... per item.
Numbering is derived from the `attachments` table so we never collide with a
prior upload, even across restarts. Out-of-band uploads that match the
`convo-NNN.md` pattern are respected too.
"""

from __future__ import annotations

import re
import sqlite3
from datetime import UTC, datetime
from textwrap import dedent

from docket.agent.types import ChatMessage

_FILENAME_RE = re.compile(r"^convo-(\d{3,})\.md$")


def next_version(conn: sqlite3.Connection, item_id: str) -> int:
    rows = conn.execute("SELECT filename FROM attachments WHERE item_id = ?", (item_id,)).fetchall()
    used = 0
    for row in rows:
        m = _FILENAME_RE.match(row["filename"] or "")
        if m:
            used = max(used, int(m.group(1)))
    return used + 1


def filename_for(version: int) -> str:
    return f"convo-{version:03d}.md"


def render_markdown(
    *,
    item_id: str,
    item_title: str,
    messages: list[ChatMessage],
    started_at: datetime | None = None,
) -> str:
    ts = (started_at or datetime.now(UTC)).isoformat()
    header = dedent(
        f"""\
        # Conversation transcript

        - **item:** {item_id} — {item_title}
        - **exported:** {ts}

        ---
        """
    )
    body_parts: list[str] = [header]
    for m in messages:
        if m.role == "user":
            body_parts.append(f"## You\n\n{m.content.strip()}\n")
        elif m.role == "assistant":
            if m.content:
                body_parts.append(f"## Assistant\n\n{m.content.strip()}\n")
            for tc in m.tool_calls:
                body_parts.append(f"_→ called `{tc.name}` with_ `{tc.arguments}`\n")
        elif m.role == "tool":
            preview = (m.content or "").strip()
            if len(preview) > 800:
                preview = preview[:800] + " …"
            body_parts.append(f"_← `{m.name}` returned:_\n\n```\n{preview}\n```\n")
        elif m.role == "system":
            # System messages (prefix, snapshot) are intentionally excluded.
            continue
    return "\n".join(body_parts).rstrip() + "\n"
