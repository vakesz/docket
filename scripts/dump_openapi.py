"""Dump the FastAPI OpenAPI schema to stdout.

Used by `frontend/bun run gen:api` via an HTTP call, but also handy for CI
and offline generation: spins up `create_app` with throwaway deps and dumps
the schema without needing a running server or real config.
"""

from __future__ import annotations

import json
import sqlite3
import sys
from pathlib import Path

# Let us import `tests.fakes.*` whether invoked from the repo root or elsewhere.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from tests.fakes.provider import FakeProvider

from docket.api.app import create_app
from docket.api.runtime import RuntimeState
from docket.config.models import (
    Config,
    HttpConfig,
    ProviderEntry,
    ScopeFilter,
)
from docket.storage import init_db


def main() -> int:
    import tempfile

    tmpdir = Path(tempfile.mkdtemp(prefix="docket-openapi-"))
    conn: sqlite3.Connection = init_db(tmpdir / "schema.db")
    cfg = Config(
        providers={
            "default": ProviderEntry(
                type="github_stub",
                display_name="Default",
                config={"default_repo": "example/repo"},
                scopes={"default": ScopeFilter()},
                active_scope="default",
            )
        },
        active_provider="default",
        http=HttpConfig(enabled=True, token="schema-dump"),
    )
    provider = FakeProvider()
    runtime = RuntimeState(
        config=cfg,
        providers={"default": provider},
        provider_key="default",
        scope_key="default",
    )
    app = create_app(
        conn=conn,
        provider=provider,
        bearer_token="schema-dump",
        runtime=runtime,
    )
    json.dump(app.openapi(), sys.stdout, indent=2)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
