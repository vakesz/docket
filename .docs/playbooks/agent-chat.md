# Agent Chat

- Keep the prompt prefix stable and deterministic or prompt caching regresses.
- Tool registration order matters because tool schemas are part of the cached prompt prefix.
- Read tools may fetch or fall back to providers; write tools only stage proposals.
- Conversation compaction happens before prompt construction once token usage crosses the threshold.
- Transcript upload must redact secrets before bytes leave the machine.
- Related docs: [Architecture](../architecture.md), [Mutation Pipeline](mutation-pipeline.md), [Config and Setup](config-and-setup.md)

## Architecture Overview

```text
item + cached comments
        |
        v
agent.prompt.build_prefix(...)
        |
        v
conversation_service.send_user_message(...)
        |
        v
AgentLoop(prefix + history + user turn)
        |
        +--> ToolRegistry read tools
        +--> ToolRegistry mutating tools -> ProposalStore
        |
        v
persist messages + usage + compaction state
```

## Ownership Boundaries

- `src/docket/agent/prompt.py` owns prefix assembly and prompt-file hot reload.
- `src/docket/agent/tools.py`, `src/docket/agent/tool_defs.py`, and `src/docket/agent/mutating_tools.py` own tool schemas and dispatch.
- `src/docket/core/services/conversation_service.py` owns thread lifecycle, persistence, and compaction timing.
- `src/docket/core/services/compaction_service.py`, `external_update_service.py`, and `suggestion_service.py` own specialized chat-adjacent workflows.

## Core Rules

- Keep system guidance plus snapshot text free of unrelated runtime data (`src/docket/agent/prompt.py`).
- When adding tools, preserve deterministic registration order and keep read-only tool behavior side-effect free (`src/docket/agent/tools.py`, `src/docket/agent/tool_defs.py`).
- Compact before building the next prompt, not after, so the threshold-crossing turn uses the shortened history immediately (`src/docket/core/services/conversation_service.py`).
- Inject provider-side item changes as `system` messages rather than mutating past assistant messages (`src/docket/core/services/external_update_service.py`).
- Redact secrets in transcripts right before staging upload, not opportunistically in multiple callers (`src/docket/agent/transcript.py`, `src/docket/core/redaction.py`).

## Code Pattern

```python
prefix = _build_prefix(conn, item)
user_msg = ChatMessage(role="user", content=text)

turn = loop.run_turn(
    prefix=prefix,
    history=past,
    user_message=user_msg,
    on_delta=on_delta,
    on_message=on_message,
)
```

Derived from `src/docket/core/services/conversation_service.py`.

## Non-Obvious Patterns

- The prompt loader caches file contents by `(filename, mtime_ns)`; deleting an override must drop back to the built-in default, not a stale cached value.
- Compaction inserts a summary row just before the earliest compacted row so chronological ordering still works.
- External updates compare timestamps carefully because SQLite round-trips can drop timezone info.
- Prompt-library writes use the canonical filenames defined by the prompt-template registry while still honoring legacy per-kind filenames when present.

## Common Scenarios

### Add a read-only tool

- Register it in `src/docket/agent/tool_defs.py`.
- Keep the handler’s side effects limited to cache/provider reads.
- Return structured JSON strings so the model can reason over failures.

### Add a new chat-side workflow

- Prefer a service beside `conversation_service` if the logic spans persistence, prompt changes, or provider refresh.
- Keep route and TUI code focused on wiring callbacks and rendering events.

## Validation Checklist

- [ ] `uv run pytest tests/test_prompt_loader.py`
- [ ] `uv run pytest tests/test_conversation_service.py tests/test_compaction.py`
- [ ] `uv run pytest tests/test_external_update_service.py tests/test_attach_transcript.py`
- [ ] `uv run pytest tests/test_agent_loop.py tests/test_mutating_tools.py`
