# Mutation Pipeline

- Every provider write is proposal-first; no surface gets to “just write.”
- `mutation_service.confirm(...)` is the only write path to provider mutation methods in `src/`.
- Agent write tools queue proposals in `ProposalStore`; they do not auto-apply.
- Read-only mode must block the same flow everywhere.
- Related docs: [Architecture](../architecture.md), [Modules](../modules.md), [Exception Audit](../exception-audit.md)

## Architecture Overview

```text
CLI / TUI / API / agent tool
          |
          v
mutation_service.propose_*
          |
          v
render_diff(...) + human confirmation
          |
          v
mutation_service.confirm(...)
          |
          +--> provider write
          +--> cache refresh
```

## Ownership Boundaries

- `src/docket/core/mutation.py` owns proposal types and diff rendering.
- `src/docket/core/services/mutation_service.py` owns provider writes and cache refresh after success.
- `src/docket/core/services/proposal_store.py` only queues pending proposals.
- CLI, TUI, API, and agent code own confirmation UX, not mutation semantics.

## Core Rules

- Build proposals from cached items for transitions, description patches, and attachments; missing cache rows are errors, not implicit provider lookups (`src/docket/core/services/mutation_service.py`).
- Keep provider write calls inside `mutation_service.confirm(...)`; repository search shows those calls only there in `src/`.
- Keep human-readable previews coming from `render_diff(...)` so every surface shows the same proposal semantics (`src/docket/core/mutation.py`, `src/docket/cli/confirm.py`, `src/docket/api/schemas.py`).
- If a confirm step fails on the HTTP surface, re-stage the proposal so the caller can retry or inspect it (`src/docket/api/routes/mutations.py`).
- Suggestion acceptance still stages proposals through the same pipeline; it is not a special bypass (`src/docket/core/services/suggestion_service.py`).

## Code Pattern

```python
proposal = mutation_service.propose_transition(ctx.conn, id, ti)
if not prompt_confirm(proposal, title=f"Transition {id} ({ti.value})"):
    raise typer.Exit(1)
result = mutation_service.confirm(ctx.conn, ctx.provider, proposal)
```

Derived from `src/docket/cli/commands/transition.py`. The same shape appears in `src/docket/cli/commands/new.py`, `src/docket/cli/commands/patch.py`, and the HTTP propose/confirm routes in `src/docket/api/routes/mutations.py`.

## Non-Obvious Patterns

- `dry_run=True` still goes through `mutation_service.confirm(...)`; the service is responsible for short-circuiting before any provider call.
- Attachment uploads store a local attachment row after the provider upload returns, so the mutation result can carry a URL even when no `Item` changes.
- New-item proposals may include duplicate suggestions from FTS search so the agent can reconsider before a human confirms.

## Common Scenarios

### Add a new CLI mutation command

- Parse user input in the appropriate command module under `src/docket/cli/commands/`, such as `src/docket/cli/commands/transition.py` or `src/docket/cli/commands/new.py`.
- Build one `Proposal` through `mutation_service.propose_*`.
- Show `prompt_confirm(...)`.
- Confirm through `mutation_service.confirm(...)`.

### Add a new API mutation

- Keep the route thin in `src/docket/api/routes/`.
- Return `ProposalDTO` for the propose step and use `MutationConfirmedDTO` only on confirm.
- Reuse `ProposalStore`; do not invent a second pending-mutation queue.

## Validation Checklist

- [ ] `uv run pytest tests/test_mutation_service.py`
- [ ] `uv run pytest tests/test_api.py tests/test_api_read_only.py`
- [ ] `uv run pytest tests/test_mutating_tools.py tests/test_batch_review_pilot.py`
- [ ] Search `src/docket` for direct `provider.transition(` or sibling write calls and confirm they still only live in `mutation_service.py`
