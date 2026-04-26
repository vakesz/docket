"""Setup wizard integration tests.

These drive the wizard end-to-end with mocked discovery, prompting, and
provider probing. Each test scripts one path (all-discovered, discovery-fails,
URL validation) and asserts the final config.toml content.

The wizard uses `rich.prompt.Prompt.ask` and `rich.prompt.Confirm.ask`; we
patch those at module level inside `setup_wizard` so every call in a test
draws its answer from a scripted deque.
"""

from __future__ import annotations

from collections import deque
from pathlib import Path
from typing import Any

import pytest

from docket.config import setup_utils, setup_wizard
from docket.config.loader import load_config
from docket.config.paths import Paths
from docket.core.model import SyncSummary
from docket.providers.azure_devops.discover import OrgRef, ProjectRef
from docket.providers.github.discover import HostRef

# ---------- scripted IO ----------


def _script_prompts(
    monkeypatch: pytest.MonkeyPatch,
    prompt_answers: list[str],
    confirm_answers: list[bool],
) -> tuple[deque[str], deque[bool]]:
    prompts = deque(prompt_answers)
    confirms = deque(confirm_answers)

    def fake_prompt_ask(*_args: Any, default: Any = None, **_kwargs: Any) -> str:
        if not prompts:
            raise AssertionError(f"wizard asked for extra Prompt input (default={default!r})")
        return prompts.popleft()

    def fake_confirm_ask(*_args: Any, default: bool = True, **_kwargs: Any) -> bool:
        if not confirms:
            raise AssertionError("wizard asked for extra Confirm input")
        return confirms.popleft()

    monkeypatch.setattr(setup_wizard.Prompt, "ask", staticmethod(fake_prompt_ask))
    monkeypatch.setattr(setup_wizard.Confirm, "ask", staticmethod(fake_confirm_ask))
    return prompts, confirms


def _stub_infra(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Paths:
    paths = Paths(
        config_dir=tmp_path / "cfg",
        state_dir=tmp_path / "state",
        cache_dir=tmp_path / "cache",
    )
    monkeypatch.setattr(setup_wizard, "resolve_paths", lambda: paths)

    # Neuter external touches — Azure-specific symbols are imported at module
    # level inside `setup_wizard`, so monkeypatching there reaches the wizard.
    monkeypatch.setattr(setup_wizard, "ensure_logged_in", lambda: "user@example.com")
    monkeypatch.setattr(setup_wizard.discover, "signed_in_email", lambda: "user@example.com")

    # A provider stub whose health check always passes and whose change feed is empty.
    class _StubProvider:
        def __init__(self, organization_url: str, project: str) -> None:
            self.org = organization_url
            self.project = project

        def health_check(self) -> None:
            return None

        def list_changes_since(self, _wm, _filters):  # for count preview
            return []

    monkeypatch.setattr(setup_wizard, "AzureDevOpsProvider", _StubProvider)

    # Avoid touching the DB on the final step.
    class _FakeConn:
        def close(self) -> None:
            return None

    monkeypatch.setattr(setup_wizard, "init_db", lambda _p: _FakeConn())
    monkeypatch.setattr(
        setup_wizard.sync_service,
        "full_refresh",
        lambda *a, **kw: SyncSummary(upserted=0, archived=0, watermark=None),
    )
    return paths


def _azure_devops_entry(cfg):
    entry = cfg.providers.get("azure_devops") or cfg.providers.get(cfg.active_provider)
    assert entry is not None, "wizard produced no Azure DevOps provider entry"
    return entry


# ---------- tests ----------


def test_wizard_uses_discovery_selections_end_to_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _stub_infra(monkeypatch, tmp_path)
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_orgs",
        lambda: [
            OrgRef(name="contoso", url="https://dev.azure.com/contoso"),
            OrgRef(name="otherco", url="https://dev.azure.com/otherco"),
        ],
    )
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_projects",
        lambda _org: [ProjectRef(id="p1", name="platform"), ProjectRef(id="p2", name="infra")],
    )
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_teams",
        lambda *_: ["Alpha", "Bravo"],
    )
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_area_paths",
        lambda *_: ["platform", "platform\\Platform"],
    )
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_iteration_paths",
        lambda *_: ["platform", "platform\\Sprint 42"],
    )

    # Pickers with `allow_any=True` render 'any' as option 1, so concrete
    # choices start at 2.
    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick provider type → azure_devops (sorted first alphabetically)
            "1",  # pick org → contoso (no 'any' in org picker)
            "1",  # pick project → platform (no 'any' in project picker)
            "",  # display-name label → accept the suggested default
            "2",  # team picker → Alpha
            "2",  # area path picker → platform
            "3",  # iteration path picker → platform\Sprint 42
            "2",  # assignee picker → @me
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    assert cfg.active_provider == "azure_devops"
    entry = _azure_devops_entry(cfg)
    assert str(entry.config["organization"]).rstrip("/") == "https://dev.azure.com/contoso"
    assert entry.config["project"] == "platform"
    scope = entry.scopes["default"]
    assert scope.team == "Alpha"
    assert scope.area_path == "platform"
    assert scope.iteration_path == "platform\\Sprint 42"
    assert scope.assignee == "@me"


def test_wizard_falls_back_when_discovery_fails(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _stub_infra(monkeypatch, tmp_path)

    def _raise(*_a, **_kw):
        raise setup_wizard.DiscoveryError("no route to host")

    for name in (
        "list_orgs",
        "list_projects",
        "list_teams",
        "list_area_paths",
        "list_iteration_paths",
    ):
        monkeypatch.setattr(setup_wizard.discover, name, _raise)

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick provider type → azure_devops
            "https://dev.azure.com/contoso",  # org URL
            "platform",  # project name
            "",  # display-name label → accept the suggested default
            "",  # team (blank)
            "",  # area
            "",  # iteration
            "2",  # assignee picker → @me (1=any, 2=@me)
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    entry = _azure_devops_entry(cfg)
    assert str(entry.config["organization"]).rstrip("/") == "https://dev.azure.com/contoso"
    assert entry.config["project"] == "platform"
    scope = entry.scopes["default"]
    assert scope.team == ""
    assert scope.area_path == ""
    assert scope.iteration_path == ""
    assert scope.assignee == "@me"


def test_wizard_rejects_bare_org_name_then_accepts_full_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Regression for the MissingSchema traceback: `platform` (not a URL) used to be
    accepted and then blow up deep in the SDK. Now it's rejected at the wizard."""
    paths = _stub_infra(monkeypatch, tmp_path)
    for name in (
        "list_orgs",
        "list_projects",
        "list_teams",
        "list_area_paths",
        "list_iteration_paths",
    ):
        monkeypatch.setattr(
            setup_wizard.discover,
            name,
            lambda *_a, **_kw: (_ for _ in ()).throw(setup_wizard.DiscoveryError("no")),
        )

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick provider type → azure_devops
            "platform",  # rejected — not a URL
            "https://dev.azure.com/contoso",  # accepted
            "platform",  # project name
            "",  # display-name label → accept the suggested default
            "",  # team
            "",  # area
            "",  # iteration
            "2",  # assignee → @me (1=any, 2=@me)
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()
    cfg = load_config(paths)
    entry = _azure_devops_entry(cfg)
    assert str(entry.config["organization"]).rstrip("/") == "https://dev.azure.com/contoso"


def test_wizard_enables_http_and_mints_token(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _stub_infra(monkeypatch, tmp_path)
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_orgs",
        lambda: [OrgRef(name="contoso", url="https://dev.azure.com/contoso")],
    )
    monkeypatch.setattr(
        setup_wizard.discover,
        "list_projects",
        lambda _org: [ProjectRef(id="p1", name="platform")],
    )
    for name in ("list_teams", "list_area_paths", "list_iteration_paths"):
        monkeypatch.setattr(setup_wizard.discover, name, lambda *_: [])

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick provider type → azure_devops
            "1",  # pick org (no 'any')
            "1",  # pick project (no 'any')
            "",  # display-name label → accept the suggested default
            "",  # team
            "",  # area
            "",  # iteration
            "2",  # assignee → @me (1=any, 2=@me)
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry; http enabled
    )

    setup_wizard.run_wizard()
    cfg = load_config(paths)
    assert cfg.http.enabled is True
    assert cfg.http.token != ""
    assert len(cfg.http.token) >= 32


def test_wizard_http_disabled_leaves_token_empty(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    paths = _stub_infra(monkeypatch, tmp_path)
    for name in (
        "list_orgs",
        "list_projects",
        "list_teams",
        "list_area_paths",
        "list_iteration_paths",
    ):
        monkeypatch.setattr(
            setup_wizard.discover,
            name,
            lambda *_a, **_kw: (_ for _ in ()).throw(setup_wizard.DiscoveryError("no")),
        )
    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick provider type → azure_devops
            "https://dev.azure.com/contoso",
            "platform",
            "",  # display-name label → accept the suggested default
            "",
            "",
            "",
            "2",  # assignee → @me (1=any, 2=@me)
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True, False],  # scope ok; telemetry; http DISABLED
    )

    setup_wizard.run_wizard()
    cfg = load_config(paths)
    assert cfg.http.enabled is False
    assert cfg.http.token == ""


def test_pick_returns_sentinels_for_any_and_custom(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit test for the core picker primitive.

    Layout with `allow_any=True`: 1=any, 2=Alpha, 3=Bravo, 4=custom. The
    default (empty input → takes the `default` value) is 'any'."""
    answers = deque(["2", "3", "1", "4", ""])
    captured_default: list[Any] = []

    def fake_prompt_ask(*_a, choices=None, default=None, **_kw) -> str:
        captured_default.append(default)
        raw = answers.popleft()
        return raw if raw else str(default)

    monkeypatch.setattr(setup_wizard.Prompt, "ask", staticmethod(fake_prompt_ask))

    assert setup_utils.pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True) == 0
    assert setup_utils.pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True) == 1
    assert (
        setup_utils.pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True)
        is setup_utils.ANY_SENTINEL
    )
    assert (
        setup_utils.pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True)
        is setup_utils.CUSTOM_SENTINEL
    )
    # Empty input → uses the prompt default, which must be 'any' (the point
    # of this whole change).
    assert (
        setup_utils.pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True)
        is setup_utils.ANY_SENTINEL
    )
    assert captured_default == ["1", "1", "1", "1", "1"]


def test_pick_without_allow_any_keeps_first_option_as_default(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Org/project/repo pickers don't get an 'any' entry; default stays '1'."""
    captured_default: list[Any] = []

    def fake_prompt_ask(*_a, choices=None, default=None, **_kw) -> str:
        captured_default.append(default)
        return "1"

    monkeypatch.setattr(setup_wizard.Prompt, "ask", staticmethod(fake_prompt_ask))
    assert setup_utils.pick("Org", ["contoso", "otherco"], allow_custom=True) == 0
    assert captured_default == ["1"]


# ---------- github + github_stub end-to-end ----------


def _stub_github_infra(monkeypatch: pytest.MonkeyPatch) -> None:
    """Mock the github provider's auth + discovery side effects.

    `pick_github_host` and `pick_github_repo` are imported into
    `setup_wizard` at module load, so monkeypatching the names there
    short-circuits the real `gh` calls without touching the system."""
    monkeypatch.setattr(setup_wizard, "gh_ensure_logged_in", lambda: "user@example.com")
    monkeypatch.setattr(setup_wizard, "gh_signed_in_email", lambda: "user@example.com")
    monkeypatch.setattr(
        setup_wizard,
        "pick_github_host",
        lambda: HostRef(hostname="github.com", api_base_url="https://api.github.com"),
    )
    monkeypatch.setattr(setup_wizard, "pick_github_repo", lambda host=None: "contoso/example")


def test_wizard_github_end_to_end(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Pick the github provider, accept the discovered host+repo, set assignee."""
    paths = _stub_infra(monkeypatch, tmp_path)
    _stub_github_infra(monkeypatch)

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "2",  # provider type → github (alphabetical: ado, github, github_stub)
            "",  # display-name label → accept the suggested default
            "2",  # assignee → @me (1=any, 2=@me, 3=signed-in email, 4=custom)
            "DEBUG",  # telemetry log level
            "",  # llm endpoint blank → skip chat wiring
        ],
        confirm_answers=[True, True],  # telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    assert cfg.active_provider == "github"
    entry = cfg.providers["github"]
    assert entry.type == "github"
    assert entry.config["default_repo"] == "contoso/example"
    # github.com gets the default api base url, which is dropped from the
    # persisted config (only GHE hosts get an explicit base_url).
    assert "base_url" not in entry.config
    scope = entry.scopes["default"]
    assert scope.team == ""
    assert scope.area_path == ""
    assert scope.iteration_path == ""
    assert scope.assignee == "@me"
    assert entry.display_name == "GitHub · contoso/example"


def test_wizard_github_ghe_persists_base_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """A non-github.com host (GHE) must persist its api_base_url."""
    paths = _stub_infra(monkeypatch, tmp_path)
    monkeypatch.setattr(setup_wizard, "gh_ensure_logged_in", lambda: "user@example.com")
    monkeypatch.setattr(setup_wizard, "gh_signed_in_email", lambda: "user@example.com")
    monkeypatch.setattr(
        setup_wizard,
        "pick_github_host",
        lambda: HostRef(
            hostname="ghe.example.com",
            api_base_url="https://ghe.example.com/api/v3",
        ),
    )
    monkeypatch.setattr(setup_wizard, "pick_github_repo", lambda host=None: "acme/widgets")

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "2",  # provider type → github
            "",  # accept suggested label
            "1",  # assignee → any
            "DEBUG",
            "",  # llm endpoint blank
        ],
        confirm_answers=[True, True],
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    entry = cfg.providers["github"]
    assert entry.config["default_repo"] == "acme/widgets"
    assert entry.config["base_url"] == "https://ghe.example.com/api/v3"
    # Label suggestion picks up the GHE host as the prefix instead of the
    # generic "GitHub" — keeps multi-host setups disambiguated in the picker.
    assert entry.display_name == "ghe.example.com · acme/widgets"
    assert entry.scopes["default"].assignee == ""


def test_wizard_github_stub_end_to_end(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """github_stub has no auth; connection just prompts for a default_repo."""
    paths = _stub_infra(monkeypatch, tmp_path)

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "3",  # provider type → github_stub
            "myorg/myrepo",  # default_repo prompt (no discovery)
            "",  # accept suggested label
            "2",  # assignee → @me
            "DEBUG",
            "",  # llm endpoint blank
        ],
        confirm_answers=[True, True],
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    assert cfg.active_provider == "github_stub"
    entry = cfg.providers["github_stub"]
    assert entry.type == "github_stub"
    assert entry.config["default_repo"] == "myorg/myrepo"
    assert entry.scopes["default"].assignee == "@me"
    assert entry.display_name == "GitHub (stub) · myorg/myrepo"
