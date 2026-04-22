from __future__ import annotations

import re
from datetime import UTC, datetime

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Markdown, Static

from docket.core.model import Comment, Item


class ItemDetail(VerticalScroll):
    """Renders the selected item's metadata, description, and comments."""

    DEFAULT_CSS = """
    ItemDetail {
        padding: 1 2;
        background: transparent;
    }
    ItemDetail #meta {
        height: auto;
        padding: 0 0 1 0;
        color: $text-muted;
        border-bottom: solid $panel-lighten-1;
    }
    ItemDetail #attachments-header,
    ItemDetail #comments-header {
        height: auto;
        padding-top: 1;
        color: $text;
        text-style: bold;
    }
    """

    def __init__(
        self,
        *,
        id: str | None = None,
        stale_threshold_days: int | None = None,
    ) -> None:
        super().__init__(id=id)
        self.tooltip = "Selected item details: metadata, description, attachments, and comments."
        # Mirror ItemTree: when set, the Updated timestamp is colorized to
        # warn when the cached snapshot is approaching / past staleness. The
        # parent app pushes updates here whenever config changes.
        self.stale_threshold_days = stale_threshold_days

    def compose(self) -> ComposeResult:
        yield Static("Select an item to see details.", id="meta")
        yield Markdown("", id="body")
        yield Static("", id="attachments-header")
        yield Markdown("", id="attachments")
        yield Static("", id="comments-header")
        yield Markdown("", id="comments")

    def show(self, item: Item | None, comments: list[Comment]) -> None:
        if item is None:
            self.query_one("#meta", Static).update("Select a ticket")
            self.query_one("#body", Markdown).update("")
            self.query_one("#attachments-header", Static).update("")
            self.query_one("#attachments", Markdown).update("")
            self.query_one("#comments-header", Static).update("")
            self.query_one("#comments", Markdown).update("")
            return

        self.query_one("#meta", Static).update(_format_meta(item, self.stale_threshold_days))
        self.query_one("#body", Markdown).update(item.description_md or "_(no description)_")

        if item.attachments:
            self.query_one("#attachments-header", Static).update(
                f"[b]Attachments ({len(item.attachments)})[/b]"
            )
            self.query_one("#attachments", Markdown).update(
                "\n".join(f"- `{a.filename}`" for a in item.attachments)
            )
        else:
            self.query_one("#attachments-header", Static).update("")
            self.query_one("#attachments", Markdown).update("")

        if comments:
            self.query_one("#comments-header", Static).update(f"[b]Comments ({len(comments)})[/b]")
            chunks: list[str] = []
            for c in comments:
                chunks.append(f"**{c.author}** · _{c.created_at.isoformat()}_\n\n{c.body_md}\n")
            self.query_one("#comments", Markdown).update("\n---\n".join(chunks))
        else:
            self.query_one("#comments-header", Static).update("")
            self.query_one("#comments", Markdown).update("")


# Mirrors `displayTag` in frontend/src/lib/format.ts: GitHub label names
# often embed emoji shortcodes like ":chart_with_upwards_trend:" that
# render as noisy literal text in a terminal. Strip them for display.
_EMOJI_SHORTCODE = re.compile(r":[a-z0-9_+-]+:", re.IGNORECASE)


def _display_tag(raw: str) -> str:
    cleaned = _EMOJI_SHORTCODE.sub("", raw)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned or raw


def _age_days(updated_at: datetime | None) -> int | None:
    if updated_at is None:
        return None
    ref = datetime.now() if updated_at.tzinfo is None else datetime.now(UTC)
    return max(0, (ref - updated_at).days)


def _freshness_marker(updated_at: datetime | None, threshold_days: int | None) -> str:
    """Return a Rich-styled badge mirroring the web `FreshnessStamp`.

    Returns an empty string when no threshold is configured or the item is
    still fresh — keeps the meta line uncluttered for healthy tickets.
    """
    if not threshold_days or threshold_days <= 0:
        return ""
    age = _age_days(updated_at)
    if age is None:
        return ""
    if age >= threshold_days * 2:
        return "  [red on rgb(60,15,20)] stale [/]"
    if age >= threshold_days:
        return "  [yellow on rgb(60,45,15)] aging [/]"
    return ""


def _format_meta(item: Item, stale_threshold_days: int | None) -> str:
    raw_fields = item.provider_raw.get("fields", {}) if isinstance(item.provider_raw, dict) else {}
    area = raw_fields.get("System.AreaPath")
    iteration = raw_fields.get("System.IterationPath")
    created = raw_fields.get("System.CreatedDate")
    changed_by = raw_fields.get("System.ChangedBy")
    if isinstance(changed_by, dict):
        changed_by = changed_by.get("displayName") or changed_by.get("uniqueName")

    tag_str = ", ".join(_display_tag(t) for t in item.tags) or "—"

    lines = [
        f"[b]{item.title}[/b]",
        f"[dim]ID[/dim] {item.id}  ·  [dim]Kind[/dim] {item.kind.value}  ·  [dim]State[/dim] {item.state.value}",
    ]
    if item.author:
        lines.append(f"[dim]Opened by[/dim] {item.author}")
    lines.append(
        f"[dim]Assignee[/dim] {item.assignee or '—'}  ·  [dim]Tags[/dim] {tag_str}",
    )
    if area:
        lines.append(f"[dim]Area[/dim] {area}")
    if iteration:
        lines.append(f"[dim]Iteration[/dim] {iteration}")
    if item.updated_at:
        updated = item.updated_at.isoformat()
        marker = _freshness_marker(item.updated_at, stale_threshold_days)
        lines.append(
            f"[dim]Updated[/dim] {updated}{marker}"
            + (f"  ·  [dim]By[/dim] {changed_by}" if changed_by else "")
        )
    if created:
        lines.append(f"[dim]Created[/dim] {created}")
    if item.parent_id:
        lines.append(f"[dim]Parent[/dim] {item.parent_id}")
    if item.url:
        lines.append(f"[dim]URL[/dim] {item.url}")
    return "\n".join(lines)
