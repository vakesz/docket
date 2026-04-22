# HTTP Surfaces

- There are two HTTP apps: the full app and the bootstrap setup app.
- Normal routes require the bearer token; setup routes accept either the setup token or the normal bearer token.
- Session-scoped provider and scope switching live in `RuntimeState`, not in `config.toml` writes.
- SSE chat runs the synchronous agent turn in a worker thread and bridges events back through an asyncio queue.
- All write flows still use proposals and confirmation.
- Related docs: [Architecture](../architecture.md), [Config and Setup](config-and-setup.md), [Mutation Pipeline](mutation-pipeline.md)

## Architecture Overview

```text
docket serve
   |
   +--> create_bootstrap_app(paths, setup_token)
   |        exposes /health + /setup/*
   |
   +--> create_app(conn, provider, bearer_token, runtime, ...)
            mounts routes/*
            app.state carries conn/provider/runtime/agent/proposals
```

## Ownership Boundaries

- `src/docket/api/app.py` wires the full app.
- `src/docket/api/bootstrap_app.py` wires the no-config setup app.
- `src/docket/api/deps.py` is the typed access layer for `app.state`.
- `src/docket/api/runtime.py` owns active provider/scope plus offline and last-sync flags.
- Route modules under `src/docket/api/routes/` should stay adapter-thin and push workflows into services.

## Core Rules

- Refuse to create the full app without a non-empty bearer token (`src/docket/api/app.py`).
- Keep auth logic in `src/docket/api/auth.py`; do not copy token comparison into routes.
- Return 503 from dependencies when a route needs wiring that is absent in bootstrap mode (`src/docket/api/deps.py`).
- Keep provider/scope switches session-scoped in `RuntimeState`; persistent config changes go through settings or setup routes (`src/docket/api/routes/providers.py`, `src/docket/api/routes/scopes.py`, `src/docket/api/routes/settings.py`).
- Stream chat via the queue-and-worker-thread pattern in `src/docket/api/routes/conversations.py`; the agent loop itself is synchronous.

## Code Pattern

```python
def _put_threadsafe(event: ServerSentEvent | None) -> None:
    asyncio.run_coroutine_threadsafe(queue.put(event), loop)

def run_turn() -> None:
    result = conversation_service.send_user_message(
        conn,
        agent,
        item_id,
        text,
        on_delta=on_delta,
        on_message=on_message,
        compaction_threshold_tokens=threshold,
    )
```

Derived from `src/docket/api/routes/conversations.py`.

## Non-Obvious Patterns

- `/setup/status` is intentionally auth-free so a frontend can detect bootstrap mode before it knows which token to send.
- The full app also mounts setup routes so an operator can re-run setup after config exists.
- `create_app(...)` and `DocketApp` share agent runtime assembly through `agent/factory.build_agent` — do not rebuild the tool registry or read-only gating inline in either surface.

## Validation Checklist

- [ ] `uv run pytest tests/test_api.py tests/test_api_read_only.py`
- [ ] `uv run pytest tests/test_api_setup.py tests/test_api_phase1.py`
- [ ] `uv run pytest tests/test_conversation_service.py tests/test_agent_loop.py`
