only plan this out for now and research it in detail!

if unsure ask me using the question tool!

Make sure to properly review this issue, that some parts of the code are not properly provider independant. I did a quick sweep what has to be changed to make jira available also and these came up as an issue. Make sure to sweep any other areas as well for similiar issues and clean up the codebase to make it more provider-agnostic. This will make it easier to add new providers in the future and reduce the amount of provider-specific code we have to maintain.

  ┌─────┬─────────────────────────────────────────────────────────────────────────┬────────────────────────────────────────────────────┬────────────────────────────────────────────────┐
  │  #  │                                File:line                                │                        Leak                        │                Impact for Jira                 │
  ├─────┼─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │     │                                                                         │ match type_id: with cases for the 3 built-ins;     │ docket setup provider add --type jira works    │
  │ 1   │ src/docket/config/provider_crud.py:69-97                                │ case _: prints "no wizard prompts — config starts  │ but prompts nothing; user must hand-edit       │
  │     │                                                                         │ empty"                                             │ config.toml                                    │
  ├─────┼─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │     │                                                                         │ TUI settings modal hardcodes the Azure DevOps form │ Jira config is uneditable in the in-app        │
  │ 2   │ src/docket/cli/tui/widgets/settings_modal.py:159, 230, 441              │  fields (org/project) and silently shows nothing   │ settings screen                                │
  │     │                                                                         │ for other types                                    │                                                │
  ├─────┼─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │     │ src/docket/api/routes/setup.py:301-396 +                                │ Discovery is exposed as per-provider routes        │ Jira can't surface project / board / filter    │
  │ 3   │ src/docket/api/schemas/setup.py:131-176 (AdoDiscoverRequest,            │ (/setup/azure-devops/discover,                     │ pickers in the SPA without a new route + new   │
  │     │ GithubDiscoverRequest) + src/docket/config/setup_discovery.py           │ /setup/github/discover) with per-provider stage    │ schema + new shim functions                    │
  │     │                                                                         │ literals                                           │                                                │
  ├─────┼─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │ 4   │ src/docket/config/setup_utils.py:85-103                                 │ build_label_suggestion() if-ladder for the 3       │ Jira labels fall back to the bare "jira"       │
  │     │                                                                         │ built-ins                                          │ provider key in CLI + HTTP suggest-label       │
  ├─────┼─────────────────────────────────────────────────────────────────────────┼────────────────────────────────────────────────────┼────────────────────────────────────────────────┤
  │     │                                                                         │                                                    │ Jira gets the generic spec-driven path         │
  │ 5   │ src/docket/config/setup_wizard.py:615-631                               │ _WIZARDS dict hardcodes auth/connection/scope step │ (acceptable; only matters if Jira needs custom │
  │     │                                                                         │  trios for the 3 built-ins                         │  auth retry / scope picker UI like ADO's       │
  │     │                                                                         │                                                    │ team/area/iteration pickers)                   │
  └─────┴─────────────────────────────────────────────────────────────────────────┴────────────────────────────────────────────────────┴────────────────────────────────────────────────┘

# suggested refactor

  1. Move per-type prompts into the spec — extend ProviderSpec with optional cli_wizard: ProviderWizard | None and delete the _WIZARDS dict + the match type_id in provider_crud.py.
  Built-ins register themselves; third-party plugins are symmetric.
  2. Replace build_label_suggestion with ProviderSpec.label_template: Callable[[dict], str] | None — each plugin owns its own label.
  3. Generic discovery endpoint — collapse /setup/azure-devops/discover and /setup/github/discover into POST /setup/providers/{type_id}/discover + a generic stage/payload pair. Have
  ProviderSpec declare discovery_stages: dict[str, Callable] (or just a single discover(stage, payload) -> dict). Then setup_discovery.py becomes a registry walker, and
  frontend/src/api/schema.d.ts's per-type discover types collapse too.
  4. Spec-driven settings modal — replace the hardcoded Azure DevOps inputs in settings_modal.py with a loop over spec(provider_type).setup_fields, matching what the SPA already does.
