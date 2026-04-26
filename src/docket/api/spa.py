"""Serve the SPA bundle from the FastAPI app.

Vite emits the built SPA directly into `<docket package>/frontend_dist/`
(see `frontend/vite.config.ts` `build.outDir`). The same path is used in
dev (after `bun run build`) and in the installed wheel (hatch ships it as
an artifact), so there's one source of truth and no copy step. The bearer
token is injected into the HTML at request time as `window.__DOCKET_TOKEN__`
— same trust model as the old Bun-server proxy: the token never leaves the
local box, the page just reads it back into Authorization headers.

Resolution order for the dist directory:
1. `DOCKET_FRONTEND_DIST` env var (used by tests).
2. `<docket package>/frontend_dist/` (dev build *and* wheel install).

If the bundle is missing, we serve a friendly fallback page at `/` instead
of 404'ing — that keeps `docket serve` usable for someone who just cloned
the repo and hasn't run `make frontend-build` yet.
"""

from __future__ import annotations

import json
import os
from importlib.resources import as_file, files
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, Response
from fastapi.staticfiles import StaticFiles

# Routes whose path prefix should never be intercepted by the SPA fallback.
# Everything backend-owned lives under `/api/*` — data routes, openapi,
# docs, health, and the `/api/setup/*` first-run surface.
_API_PREFIXES = ("/api/",)

_FALLBACK_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Docket — frontend not built</title>
<style>body{font:14px/1.5 -apple-system,system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem;color:#222}code{background:#f3f3f3;padding:.1em .35em;border-radius:.25em}</style>
</head><body>
<h1>Frontend bundle not built</h1>
<p>The Docket backend is running, but the SPA assets aren't on disk yet.</p>
<p>Run <code>make frontend-build</code> (or <code>make serve</code>) to produce a static bundle into <code>src/docket/frontend_dist/</code>, then refresh.</p>
<p>API still works at <code>/api/*</code> and <code>/openapi.json</code>.</p>
</body></html>
"""


def resolve_frontend_dist() -> Path | None:
    """Find the SPA dist directory, or None if no candidate exists on disk."""
    override = os.environ.get("DOCKET_FRONTEND_DIST")
    if override:
        candidate = Path(override).expanduser()
        return candidate if candidate.is_dir() else None

    try:
        packaged = files("docket").joinpath("frontend_dist")
        with as_file(packaged) as p:
            if p.is_dir() and (p / "index.html").is_file():
                return Path(p)
    except (ModuleNotFoundError, FileNotFoundError):
        pass
    return None


def _render_index(index_path: Path, token: str) -> str:
    """Inject the bearer token into the static index.html.

    We only re-read from disk when the file mtime changes; once the SPA is
    built that's effectively never, but in dev (manual rebuilds) it picks
    up the new bundle without needing a server restart.
    """
    mtime = index_path.stat().st_mtime
    cached = _RENDER_CACHE.get(index_path)
    if cached and cached[0] == mtime and cached[1] == token:
        return cached[2]
    raw = index_path.read_text(encoding="utf-8")
    snippet = f"<script>window.__DOCKET_TOKEN__={json.dumps(token)};</script>"
    out = raw.replace("</head>", f"{snippet}</head>", 1) if "</head>" in raw else snippet + raw
    _RENDER_CACHE[index_path] = (mtime, token, out)
    return out


_RENDER_CACHE: dict[Path, tuple[float, str, str]] = {}


def mount_spa(app: FastAPI, *, dist: Path | None) -> None:
    """Mount the SPA on `app`.

    Registered last, after every API router, so the catch-all only fires on
    paths the API didn't claim. Read-only mode is irrelevant here — the
    SPA is static + a single template render with no mutations.
    """

    if dist is None or not (dist / "index.html").is_file():

        @app.get("/", include_in_schema=False)
        def _no_bundle_root() -> HTMLResponse:
            return HTMLResponse(_FALLBACK_HTML, status_code=200)

        @app.get("/{full_path:path}", include_in_schema=False)
        def _no_bundle_catchall(full_path: str) -> Response:
            if any(("/" + full_path).startswith(p) for p in _API_PREFIXES):
                return Response(status_code=404)
            return HTMLResponse(_FALLBACK_HTML, status_code=200)

        return

    assets_dir = dist / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")

    index_path = dist / "index.html"

    @app.get("/{full_path:path}", include_in_schema=False)
    def _spa(full_path: str, request: Request) -> Response:
        if any(("/" + full_path).startswith(p) for p in _API_PREFIXES):
            return Response(status_code=404)
        if full_path:
            asset = (dist / full_path).resolve()
            try:
                asset.relative_to(dist.resolve())
            except ValueError:
                return Response(status_code=404)
            if asset.is_file():
                return Response(
                    asset.read_bytes(),
                    media_type=_guess_type(asset),
                )
        token = getattr(request.app.state, "bearer_token", "") or ""
        return HTMLResponse(_render_index(index_path, token))


def _guess_type(path: Path) -> str:
    suffix = path.suffix.lower()
    return {
        ".svg": "image/svg+xml",
        ".ico": "image/x-icon",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".webp": "image/webp",
        ".txt": "text/plain; charset=utf-8",
        ".json": "application/json",
        ".webmanifest": "application/manifest+json",
        ".woff": "font/woff",
        ".woff2": "font/woff2",
    }.get(suffix, "application/octet-stream")


__all__ = ["mount_spa", "resolve_frontend_dist"]
