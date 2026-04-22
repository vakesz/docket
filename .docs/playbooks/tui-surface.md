# TUI Surface

- `TuiContext` is the TUI’s injection seam; keep tests and production code using it.
- Provider and LLM work must stay off the Textual event loop.
- Mutation UX belongs in modals and proposal queues, not direct writes from key handlers.
- Read-only mode should toast and bail before opening write flows.
- `src/docket/cli/tui/app.py` is already a hotspot; prefer extracting helpers over growing it.
- Related docs: [Architecture](../architecture.md), [Exception Audit](../exception-audit.md), [Mutation Pipeline](mutation-pipeline.md)

## Architecture Overview

```text
TuiContext
   |
   v
ItvApp
  +--> ItemTree
  +--> ItemDetail
  +--> ChatPane
  +--> StatusBar
  +--> modal screens
   |
   +--> sync_service / conversation_service / mutation_service
   +--> background sync + external update timers
```

## Ownership Boundaries

- `src/docket/cli/tui/app.py` owns app composition, action wiring, and timer setup.
- `src/docket/cli/tui/widgets/` own focused rendering and modal interactions.
- Workflow semantics should stay in services under `src/docket/core/services/`.
- `TuiContext` should remain the only required constructor input for the app.

## Core Rules

- Build the app from `TuiContext` so pilot tests can mount it with fakes (`src/docket/cli/tui/app.py`, `tests/test_tui_pilot.py`).
- Keep provider I/O off the main event loop by using Textual workers or background intervals (`src/docket/cli/tui/app.py`, `src/docket/storage/db.py`).
- Route write actions through proposals and diff modals; `new item`, `transition`, and suggestion acceptance all follow this path.
- Use status-bar and modal feedback for read-only blocking rather than partially executing actions (`src/docket/cli/tui/app.py`, `tests/test_read_only_mode.py`).
- Prefer pilot tests that drive keys and actions instead of asserting on widget internals or CSS implementation details (`tests/test_tui_pilot.py`, `tests/test_diff_modal_pilot.py`, `tests/test_batch_review_pilot.py`).

## Non-Obvious Patterns

- Pane maximize/minimize, provider switching, and background sync are all app-level behaviors in `ItvApp`; adding another one increases the size and coupling of that file.
- Background sync uses a global interval clamped by per-provider floors.
- The app strips mutating tools from the agent registry when read-only, not just from visible UI affordances.

## Common Scenarios

### Add a new TUI action

- Keep the action small in `ItvApp`.
- Delegate provider or persistence work to an existing service or a new helper.
- Use a modal or notification for user-facing confirmation or failure.

### Add a new widget

- Put focused rendering logic in `src/docket/cli/tui/widgets/`.
- Feed it data from `ItvApp` or a service rather than opening new DB or provider seams in the widget.

## Validation Checklist

- [ ] `uv run pytest tests/test_tui_pilot.py tests/test_read_only_mode.py`
- [ ] `uv run pytest tests/test_diff_modal_pilot.py tests/test_batch_review_pilot.py`
- [ ] Run any focused widget pilot tests such as `tests/test_tui_chat_pilot.py`, `tests/test_tui_ux_pilot.py`, or `tests/test_watchlist_pilot.py` if you touched those areas
