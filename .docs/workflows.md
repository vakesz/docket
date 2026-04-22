# Workflows

## Mutation Work

- All provider writes are proposal-first and confirmation-gated.
- This affects CLI commands, TUI modals, API endpoints, suggestion staging, and agent write tools.
- Read [Mutation Pipeline](playbooks/mutation-pipeline.md).

## Chat and Prompt Work

- Prompt stability, tool registration order, compaction, transcript export, and external-update injection interact closely.
- Small changes here can silently break cache behavior or transcript correctness.
- Read [Agent Chat](playbooks/agent-chat.md).

## Provider Work

- Providers are small by contract but easy to break through state-map drift or registry wiring mistakes.
- The provider layer is also where optional capabilities and canonical translation rules live.
- Read [Provider Layer](playbooks/provider-layer.md).

## HTTP Surface Work

- The API has two modes: full runtime and bootstrap setup.
- Auth, runtime switching, SSE streaming, and proposal confirmation all meet here.
- Read [HTTP Surfaces](playbooks/http-surfaces.md).

## TUI Work

- The TUI has background workers, modal-based mutation review, provider/scope switching, and read-only behavior.
- `ItvApp` is already a hotspot, so new code placement matters.
- Read [TUI Surface](playbooks/tui-surface.md).

## Setup and Config Work

- XDG paths, `.env` precedence, atomic saves, prompt scaffolding, and duplicate setup paths make this area non-trivial.
- Read [Config and Setup](playbooks/config-and-setup.md).

## Cache and Storage Work

- SQLite migrations, FTS query building, watermarks, and watchlist semantics are easy to get subtly wrong.
- Read [Storage Cache](playbooks/storage-cache.md).
