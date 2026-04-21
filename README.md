# Docket

A terminal-first work-item triage tool. Browse your board, open a ticket, and refine it through a conversation with an LLM that has full context of the item. When you're ready, the agent proposes state transitions, description patches, or new child tickets — you confirm, it writes back.

**Phase 1** targets Azure DevOps Boards via the `azure-devops` Python SDK, with Azure AI Foundry (GPT-5) as the LLM. The core is provider-agnostic by design so Jira and GitHub Issues can slot in later.

## Status

Planning complete, implementation not yet started. See [`plan.md`](plan.md) for the architecture and milestones, [`SETUP.md`](SETUP.md) for the first-run walkthrough.

## What it does

- **Cached board**: fast startup by keeping a local SQLite copy of epics → features → stories → tasks/bugs within a scope you configure. Incremental sync via `System.ChangedDate`.
- **TUI chat per ticket**: three-pane Textual UI (list / detail / chat). Open a ticket, the agent reads the description + comments + linked items and asks clarifying questions.
- **Safe mutations**: every write — state transition, description patch, attachment upload, new ticket — previews a diff and waits for a keypress. Agent-initiated writes use the same gate.
- **Transcript upload**: on close, or on demand, the conversation is uploaded to the ticket as a versioned Markdown attachment (`convo-001.md`, `convo-002.md`, …).
- **HTTP surface from day 1**: FastAPI with REST + SSE behind a static bearer token, sharing the same service layer as the CLI/TUI. Can be disabled entirely.
- **Dry-run mode** on every mutating command for testing.

## Quick start

```bash
# install (once published to pipx)
pipx install docket

# first run — triggers the interactive setup wizard
docket
```

The wizard walks through Azure CLI, Azure DevOps, scope filters, Foundry credentials, HTTP toggle, telemetry, prompt templates, DB init, and an initial sync. Full walkthrough in [`SETUP.md`](SETUP.md).

After setup:

```bash
docket              # open the TUI
docket sync         # refresh the cache from ADO
docket list         # list items matching your scope
docket show <id>    # show a single item
docket new          # create a new item (prompts for kind + fields)
docket serve        # run the FastAPI surface (if enabled in config)
docket setup        # re-run the wizard
```

## Architecture in one paragraph

`core/` holds the canonical data model and service layer (item sync, conversation persistence, mutation pipeline). `providers/` has the pluggable `WorkItemProvider` interface — `azure_devops/` is the first implementation. `agent/` wires an Azure AI Foundry client to a tool registry that targets the provider interface (never the provider directly). `cli/` and `api/` are thin adapters on the same services, so a feature written once is available in the terminal and over HTTP. Full layout: [`plan.md`](plan.md#1-repo-layout).

## Design constraints worth knowing

- **Provider-agnostic from day 1.** The canonical data model and named transition intents (`start_work`, `pause`, `block`, `needs_info`, `close_done`, `close_wontfix`, `reopen`) are the stable interface. Provider-specific state strings never leak into `core/`.
- **Confirm-before-mutate, always.** Including agent-initiated writes. The downside of a missed keypress is cheap; the downside of a silent close is not.
- **Descriptions are Markdown.** Written directly to ADO's description field (modern processes support it). On HTML-only projects the wizard detects this and the provider falls back to a converter.
- **Offline = fail fast.** If ADO is unreachable, surface it. No queued mutations in phase 1.
- **Caching matters.** The prompt is laid out so the system message, tools schema, and ticket snapshot form a stable cacheable prefix — only conversation turns change turn-to-turn.

## Development

Requires Python ≥ 3.12 and [`uv`](https://docs.astral.sh/uv/).

```bash
uv sync
uv run pytest
uv run docket
```

See [`plan.md`](plan.md#12-phased-milestones) for the milestone plan. Each milestone is independently shippable.

## Documents

- [`plan.md`](plan.md) — architecture, data model, interfaces, phased milestones, risks.
- [`SETUP.md`](SETUP.md) — step-by-step first-time setup guide.
