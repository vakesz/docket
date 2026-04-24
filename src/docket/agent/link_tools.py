"""Provider-agnostic link-fetching tool for the agent.

Work-item descriptions often reference design docs, ADRs, dashboards, and
release notes by bare URL. `get_item` already extracts those URLs into a
`links` array; this tool lets the agent pull one down and read it.

Scope is deliberately narrow:
- `http` / `https` only — no `file://`, `data:`, or similar.
- Body capped at a byte budget so a single call can't blow the context window.
- HTML is converted to Markdown via `markdownify` (already a dep) so the
  model sees paragraphs instead of tag soup.
- Response includes final url + status + content type so the agent can reason
  about redirects and non-200s.

This tool is intentionally provider-independent — it registers regardless of
which backend is active."""

from __future__ import annotations

import json
from typing import Any
from urllib.parse import urlparse

import httpx
from markdownify import markdownify as md

from docket.agent.tools import ToolRegistry
from docket.telemetry.logging import get_logger

_log = get_logger(__name__)

_FETCH_TIMEOUT = httpx.Timeout(10.0, connect=5.0)
_USER_AGENT = "docket-agent/1.0 (+https://github.com/vakesz/docket)"
# Raw response cap (bytes). A misbehaving endpoint can't feed us gigabytes.
_MAX_BYTES = 256 * 1024
# Post-conversion body cap (chars ≈ 4x tokens). Cuts very long docs before
# they land in the prompt.
_MAX_CHARS = 16_000
_HTML_TYPES = ("text/html", "application/xhtml+xml")


def register_link_tools(registry: ToolRegistry) -> None:
    """Register `fetch_link` on the registry.

    Always registered — the tool needs no provider and no project context.
    Stays read-only by construction (HTTP GET only)."""

    def fetch_link(args: dict[str, Any]) -> str:
        url = str(args.get("url", "")).strip()
        if not url:
            return json.dumps({"error": "url is required"})
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"}:
            return json.dumps(
                {"error": f"only http/https urls are allowed (got scheme '{parsed.scheme}')"}
            )
        if not parsed.netloc:
            return json.dumps({"error": "url must include a host"})
        try:
            with httpx.Client(
                timeout=_FETCH_TIMEOUT,
                follow_redirects=True,
                headers={"User-Agent": _USER_AGENT, "Accept": "*/*"},
            ) as client:
                resp = client.get(url)
        except httpx.HTTPError as e:
            _log.info("fetch_link_failed", url=url, error_type=type(e).__name__)
            return json.dumps({"error": f"fetch failed: {e}", "url": url})
        raw = resp.content[:_MAX_BYTES]
        truncated_bytes = len(resp.content) > _MAX_BYTES
        content_type = (resp.headers.get("content-type") or "").split(";", 1)[0].strip().lower()
        # Decode with the response's declared encoding if known. Fall back to
        # utf-8 replace so obscure charsets don't take down the tool call.
        try:
            text = raw.decode(resp.encoding or "utf-8", errors="replace")
        except LookupError:
            text = raw.decode("utf-8", errors="replace")
        body_md: str
        if content_type in _HTML_TYPES or (not content_type and "<html" in text.lower()[:4096]):
            try:
                body_md = str(md(text, heading_style="ATX"))
            except Exception as e:  # fall back to raw text if markdownify chokes
                _log.info("fetch_link_html_convert_failed", url=url, error_type=type(e).__name__)
                body_md = text
        else:
            body_md = text
        body_md = body_md.strip()
        truncated_chars = len(body_md) > _MAX_CHARS
        if truncated_chars:
            body_md = body_md[:_MAX_CHARS] + "\n\n…[truncated]…"
        # Pull the <title> if still present (markdownify strips it into a
        # heading; grab the first non-empty line as a title hint).
        title = ""
        for line in body_md.splitlines():
            stripped = line.strip().lstrip("# ").strip()
            if stripped:
                title = stripped[:200]
                break
        return json.dumps(
            {
                "url": str(resp.url),
                "status_code": resp.status_code,
                "content_type": content_type,
                "title": title,
                "body_md": body_md,
                "truncated": truncated_bytes or truncated_chars,
            }
        )

    registry.register(
        name="fetch_link",
        description=(
            "Fetch an http(s) URL and return its content as Markdown. Use "
            "this to read design docs, ADRs, dashboards, or release notes "
            "referenced from a work item's description (see the `links` "
            "array returned by `get_item`). HTML is converted to Markdown; "
            "other content types are returned as plain text. Both the raw "
            "response and the converted body are capped — `truncated` is "
            "true when either limit was hit."
        ),
        parameters={
            "type": "object",
            "properties": {
                "url": {
                    "type": "string",
                    "description": "Absolute http(s) URL to fetch.",
                },
            },
            "required": ["url"],
        },
        handler=fetch_link,
    )


__all__ = ["register_link_tools"]
