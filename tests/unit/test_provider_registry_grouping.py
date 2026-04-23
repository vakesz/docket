"""Each built-in provider declares how the TUI should group its backlog.

Azure DevOps has a real hierarchy (Epic/Feature/Story/Task/Bug), so grouping
by kind is load-bearing. GitHub issues are flat — grouping by kind mostly
produces empty Epic/Feature buckets — so those specs opt into state-bucket
grouping instead. The registry is the single source of truth; the TUI reads
it and plumbs the value down to `ItemTree`."""

from __future__ import annotations

from docket.providers import registry


def test_azure_devops_defaults_to_kind_grouping() -> None:
    spec = registry.spec("azure_devops")
    assert spec is not None
    assert spec.grouping == "by_kind"


def test_github_uses_state_bucket_grouping() -> None:
    spec = registry.spec("github")
    assert spec is not None
    assert spec.grouping == "by_state_bucket"


def test_github_stub_uses_state_bucket_grouping() -> None:
    spec = registry.spec("github_stub")
    assert spec is not None
    assert spec.grouping == "by_state_bucket"
