# Exception Audit

## Active Follow-Up Items

- `src/docket/config/setup_wizard.py`
  What is wrong: the interactive wizard lives in the config package but imports concrete Azure DevOps and GitHub discovery/provider code and performs provider-specific onboarding directly.
  Proposed fix: move provider onboarding behind shared setup services plus provider metadata so both CLI and HTTP setup use the same implementation.

- `src/docket/config/setup_wizard.py` and `src/docket/api/routes/setup.py`
  What is wrong: setup logic is duplicated across the interactive wizard and the HTTP bootstrap surface, including provider validation, prompt scaffolding, config writing, and optional initial sync.
  Proposed fix: introduce a shared setup application service that both adapters call.

- `src/docket/cli/tui/app.py`
  What is wrong: the TUI shell is also an orchestration hub for agent setup, background sync, external-update polling, provider/scope switching, and proposal review flow.
  Proposed fix: split app-level workflow logic into smaller controller or service helpers and keep `ItvApp` focused on composition and event wiring.

- `src/docket/cli/tui/app.py` and `src/docket/api/app.py`
  What is wrong: both surfaces assemble the agent runtime directly, including read-only tool gating and `ToolRegistry` setup.
  Proposed fix: add a shared factory for agent runtime creation so tool registration rules live in one place.

- `src/docket/cli/tui/widgets/settings_modal.py`, `src/docket/cli/tui/widgets/theme_picker.py`, `src/docket/cli/tui/widgets/prompt_library.py`, `src/docket/api/routes/settings.py`, and `src/docket/api/routes/prompts.py`
  What is wrong: config and prompt-file mutations are spread across widgets and route modules instead of flowing through one config/prompt service.
  Proposed fix: centralize file-backed config and prompt mutations behind dedicated services so hot-reload and validation rules live once.

- `tests/test_import_boundary.py`
  What is wrong: the architectural test only scans for `docket.providers.azure_devops`, while the documented rule is broader than one provider package.
  Proposed fix: expand the test to reject imports from all concrete provider packages or scan for `docket.providers.` minus `base` and `registry`.

## Recently Normalized

- None tracked yet.

## Guidelines

- Add an item when code intentionally breaks the target architecture or duplicates a workflow across adapters.
- Remove an item only after the duplication or boundary leak is gone, not when it is merely documented elsewhere.
- Prioritize exceptions that multiply work across TUI and API, because those create the most future drift.
