"""Smoke tests for provider setup metadata.

These pin behavior the wizard + settings surfaces depend on. After the
provider-independence refactor (see `.docs/PROVIDER_INDEPENDENCE_PLAN.md`):

- Phase 1 will add `label_template` to `ProviderSpec`; this file gains an
  assertion that every spec carries one.
- Phase 3 will introduce a `WizardHooks` registry; this file gains an
  assertion that every spec has a registered hook.
- Phase 5 will add `scope_axes`; this file pins the axis tuples per
  provider.

Today the test fixes the spec field shapes so a regression in the
registry surface is caught before it bricks the wizard."""

from __future__ import annotations

from collections.abc import Iterable

import pytest

from docket.providers import registry
from docket.providers.base import ProviderSpec, SetupField

BUILT_IN_TYPE_IDS = ("azure_devops", "github", "github_stub")


@pytest.mark.parametrize("type_id", BUILT_IN_TYPE_IDS)
def test_built_in_spec_is_registered(type_id: str) -> None:
    spec = registry.spec(type_id)
    assert spec is not None, f"{type_id!r} not registered in providers.registry"
    assert isinstance(spec, ProviderSpec)
    assert spec.type_id == type_id


@pytest.mark.parametrize("type_id", BUILT_IN_TYPE_IDS)
def test_built_in_spec_has_factory_and_setup_fields(type_id: str) -> None:
    spec = registry.spec(type_id)
    assert spec is not None
    assert callable(spec.factory)
    assert isinstance(spec.setup_fields, tuple)
    for sf in spec.setup_fields:
        assert isinstance(sf, SetupField)
        assert sf.key
        assert sf.label
        assert sf.kind in {"string", "url", "secret"}


def test_specs_returns_all_built_ins_sorted() -> None:
    """`registry.specs()` is the source of truth for the provider-type picker.

    It must be deterministic across runs and contain every built-in. Order
    is asserted so wizard tests that script numbered choices keep working."""
    type_ids = [s.type_id for s in registry.specs()]
    for built_in in BUILT_IN_TYPE_IDS:
        assert built_in in type_ids, f"{built_in!r} missing from registry.specs()"
    assert type_ids == sorted(type_ids), "specs() must be sorted by type_id"


def test_normalize_config_passthrough_for_specs_without_normalizer() -> None:
    """Specs without an explicit normalizer must round-trip the input dict.

    The HTTP setup route + provider CRUD both call `normalize_config(...)`
    unconditionally; a pass-through behavior is what keeps that contract
    safe for new providers that don't need URL canonicalization etc."""
    for type_id in BUILT_IN_TYPE_IDS:
        spec = registry.spec(type_id)
        assert spec is not None
        if spec.normalize_config is None:
            payload = {"foo": "bar", "extra": "kept"}
            assert registry.normalize_config(type_id, dict(payload)) == payload


def _setup_field_keys(fields: Iterable[SetupField]) -> set[str]:
    return {f.key for f in fields}


def test_built_in_spec_keys_match_wizard_expectations() -> None:
    """Pin the field key sets so renames don't silently break the wizard.

    These keys are referenced by `setup_wizard._WIZARDS` (today) and by the
    SPA wizard form (today + post-refactor) — keep them stable across
    Phase 2 (spec-driven settings modal) and Phase 3 (hook registry)."""
    ado = registry.spec("azure_devops")
    assert ado is not None
    assert _setup_field_keys(ado.setup_fields) == {"organization", "project"}

    gh = registry.spec("github")
    assert gh is not None
    assert _setup_field_keys(gh.setup_fields) == {"default_repo"}

    stub = registry.spec("github_stub")
    assert stub is not None
    assert _setup_field_keys(stub.setup_fields) == {"default_repo"}


@pytest.mark.parametrize("type_id", BUILT_IN_TYPE_IDS)
def test_built_in_spec_has_label_template(type_id: str) -> None:
    """Every built-in spec must own a `label_template` callable.

    `setup_utils.build_label_suggestion` is now a registry walker — when a
    spec lacks a template it falls back to an empty string and the wizard
    defaults to the bare type id. That's acceptable for third-party plugins
    but not for built-ins, where the SPA suggest-label endpoint and the CLI
    wizard both depend on a useful default."""
    spec = registry.spec(type_id)
    assert spec is not None
    assert spec.label_template is not None, f"{type_id!r} missing label_template"
    assert callable(spec.label_template)


def test_built_in_label_templates_match_legacy_outputs() -> None:
    """Pin the label strings the CLI + SPA show by default.

    Catches subtle regressions if a future template change drops the
    "GitHub · " prefix or rearranges the "Azure DevOps · org/project" form."""
    ado = registry.spec("azure_devops")
    assert ado is not None and ado.label_template is not None
    assert ado.label_template(
        {"organization": "https://dev.azure.com/contoso", "project": "Acme"}
    ) == "Azure DevOps · contoso/Acme"
    assert ado.label_template({"organization": "", "project": "Solo"}) == "Azure DevOps · Solo"
    assert ado.label_template({}) == "Azure DevOps"

    gh = registry.spec("github")
    assert gh is not None and gh.label_template is not None
    assert gh.label_template({"default_repo": "contoso/alpha"}) == "GitHub · contoso/alpha"
    # GHE hosts surface the hostname so multi-host setups stay distinguishable.
    assert (
        gh.label_template(
            {"default_repo": "contoso/alpha", "base_url": "https://ghe.contoso.com/api/v3"}
        )
        == "ghe.contoso.com · contoso/alpha"
    )
    # api.github.com explicitly stored is still the cloud default.
    assert (
        gh.label_template(
            {"default_repo": "contoso/alpha", "base_url": "https://api.github.com"}
        )
        == "GitHub · contoso/alpha"
    )

    stub = registry.spec("github_stub")
    assert stub is not None and stub.label_template is not None
    assert stub.label_template({"default_repo": "myorg/myrepo"}) == "GitHub (stub) · myorg/myrepo"
    assert stub.label_template({}) == "GitHub (stub)"
