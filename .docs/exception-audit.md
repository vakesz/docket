# Exception Audit

## Active Follow-Up Items

- `src/docket/config/setup_wizard.py`
  What is wrong: the interactive wizard lives in the config package but imports concrete Azure DevOps and GitHub discovery/provider code and performs provider-specific onboarding directly.
  Proposed fix: move provider onboarding behind a shared setup service plus the provider spec so both CLI and HTTP setup use the same implementation. Half-done — provider metadata already sits on `ProviderSpec` in `src/docket/providers/registry.py`; the remaining work is pushing `list_orgs`/`list_projects`/`list_repos` discovery behind provider-level hooks instead of import-from-concrete-packages.

- `src/docket/config/setup_wizard.py` and `src/docket/api/routes/setup.py`
  What is wrong: setup finalization (providers build + scope scaffolding + prompts scaffold + initial sync + config save) is duplicated between the interactive wizard and the HTTP bootstrap surface.
  Proposed fix: extract a shared `setup_service.finalize(...)` both adapters call. The `ScopeFilter.to_core()` helper already removed the filter-conversion duplication; a larger finalize helper is the next step.

- `src/docket/cli/tui/app.py`
  What is wrong: `DocketApp` is a 1,300-line orchestration hub for agent setup, background sync, external-update polling, provider/scope switching, and proposal review. Feature-based decomposition (per-pane helper modules with co-located handlers) is needed.
  Proposed fix: split by pane/feature. The agent runtime assembly already moved into `agent/factory.build_agent`; the background sync, external-update watcher, and proposal-review flows are the next natural seams.

- `src/docket/cli/tui/widgets/settings_modal.py`, `src/docket/cli/tui/widgets/theme_picker.py`, `src/docket/cli/tui/widgets/prompt_library.py`, `src/docket/api/routes/settings.py`, and `src/docket/api/routes/prompts.py`
  What is wrong: config and prompt-file mutations are spread across widgets and route modules instead of flowing through one config/prompt service.
  Proposed fix: centralize file-backed config and prompt mutations behind dedicated services so hot-reload and validation rules live once.

## Recently Normalized

- `api/schemas.py` → split into `api/schemas/` package (`core`, `mutations`, `tui_parity`, `setup`).
- CLI mutation commands (`transition`, `patch`, `new`) deduped via `cli.confirm.apply_mutation`.
- Agent runtime assembly extracted to `agent/factory.build_agent` — HTTP and TUI can no longer drift on read-only gating or tool-registration order.
- Per-provider setup metadata (display name, required CLIs, config fields) moved onto `ProviderSpec` in the registry; `api/routes/setup.py` iterates specs instead of maintaining parallel dicts.
- `ScopeFilter.to_core()` collapsed 7 identical `ScopeFilter → ScopeFilters` conversion sites.
- `tests/unit/test_import_boundary.py` now scans every `core/`, `storage/`, `agent/`, `api/` file against all concrete provider packages (auto-discovered from `src/docket/providers/`), and a sentinel test catches the silent-empty-scan regression that previously made the guard a no-op.

## Guidelines

- Add an item when code intentionally breaks the target architecture or duplicates a workflow across adapters.
- Remove an item only after the duplication or boundary leak is gone, not when it is merely documented elsewhere.
- Prioritize exceptions that multiply work across TUI and API, because those create the most future drift.
