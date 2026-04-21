from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import VerticalScroll
from textual.widgets import Markdown, Static

from docket.core.model import Comment, Item


class ItemDetail(VerticalScroll):
    """Renders the selected item's metadata, description, and comments."""

    DEFAULT_CSS = """
    ItemDetail { padding: 1 2; }
    ItemDetail #meta { height: auto; padding-bottom: 1; color: $text-muted; }
    ItemDetail #attachments-header { height: auto; padding-top: 1; }
    ItemDetail #comments-header { height: auto; padding-top: 1; }
    """

    def compose(self) -> ComposeResult:
        yield Static("Select an item to see details.", id="meta")
        yield Markdown("", id="body")
        yield Static("", id="attachments-header")
        yield Markdown("", id="attachments")
        yield Static("", id="comments-header")
        yield Markdown("", id="comments")

    def show(self, item: Item | None, comments: list[Comment]) -> None:
        if item is None:
            self.query_one("#meta", Static).update("Select an item to see details.")
            self.query_one("#body", Markdown).update("")
            self.query_one("#attachments-header", Static).update("")
            self.query_one("#attachments", Markdown).update("")
            self.query_one("#comments-header", Static).update("")
            self.query_one("#comments", Markdown).update("")
            return

        self.query_one("#meta", Static).update(_format_meta(item))
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


def _format_meta(item: Item) -> str:
    raw_fields = item.provider_raw.get("fields", {}) if isinstance(item.provider_raw, dict) else {}
    area = raw_fields.get("System.AreaPath")
    iteration = raw_fields.get("System.IterationPath")
    created = raw_fields.get("System.CreatedDate")
    changed_by = raw_fields.get("System.ChangedBy")
    if isinstance(changed_by, dict):
        changed_by = changed_by.get("displayName") or changed_by.get("uniqueName")

    lines = [
        f"[b]{item.title}[/b]",
        f"id={item.id}  kind={item.kind.value}  state={item.state.value}",
        f"assignee={item.assignee or '—'}  tags={', '.join(item.tags) or '—'}",
    ]
    if area:
        lines.append(f"area={area}")
    if iteration:
        lines.append(f"iteration={iteration}")
    if item.updated_at:
        updated = item.updated_at.isoformat()
        lines.append(f"updated={updated}" + (f"  by={changed_by}" if changed_by else ""))
    if created:
        lines.append(f"created={created}")
    if item.parent_id:
        lines.append(f"parent={item.parent_id}")
    if item.url:
        lines.append(f"url={item.url}")
    return "\n".join(lines)
