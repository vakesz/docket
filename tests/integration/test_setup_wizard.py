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

from docket.config import setup_wizard
from docket.config.loader import load_config
from docket.config.paths import Paths
from docket.core.model import SyncSummary
from docket.providers.azure_devops.discover import OrgRef, ProjectRef

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

    # Neuter external touches.
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


def _ado_entry(cfg):
    entry = cfg.providers.get("ado") or cfg.providers.get(cfg.active_provider)
    assert entry is not None, "wizard produced no ADO provider entry"
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

    _script_prompts(
        monkeypatch,
        prompt_answers=[
            "1",  # pick org → contoso
            "1",  # pick project → platform
            "1",  # team picker → Alpha
            "1",  # area path picker → platform
            "2",  # iteration path picker → platform\Sprint 42
            "1",  # assignee picker → @me
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    assert cfg.active_provider == "ado"
    entry = _ado_entry(cfg)
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
            "https://dev.azure.com/contoso",  # org URL
            "platform",  # project name
            "",  # team (blank)
            "",  # area
            "",  # iteration
            "1",  # assignee picker → @me
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()

    cfg = load_config(paths)
    entry = _ado_entry(cfg)
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
            "platform",  # rejected — not a URL
            "https://dev.azure.com/contoso",  # accepted
            "platform",  # project name
            "",  # team
            "",  # area
            "",  # iteration
            "1",  # assignee → @me
        ],
        confirm_answers=[True, True, True],  # scope ok; telemetry enabled; http enabled
    )

    setup_wizard.run_wizard()
    cfg = load_config(paths)
    entry = _ado_entry(cfg)
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
            "1",  # pick org
            "1",  # pick project
            "",  # team
            "",  # area
            "",  # iteration
            "1",  # assignee → @me
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
            "https://dev.azure.com/contoso",
            "platform",
            "",
            "",
            "",
            "1",
        ],
        confirm_answers=[True, True, False],  # scope ok; telemetry; http DISABLED
    )

    setup_wizard.run_wizard()
    cfg = load_config(paths)
    assert cfg.http.enabled is False
    assert cfg.http.token == ""


def test_pick_returns_sentinels_for_any_and_custom(monkeypatch: pytest.MonkeyPatch) -> None:
    """Unit test for the core picker primitive."""
    answers = deque(["2", "3", "1"])

    def fake_prompt_ask(*_a, choices=None, default=None, **_kw) -> str:
        return answers.popleft()

    monkeypatch.setattr(setup_wizard.Prompt, "ask", staticmethod(fake_prompt_ask))

    # options=["Alpha","Bravo"], any+custom → 1:Alpha 2:Bravo 3:any 4:custom
    assert setup_wizard._pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True) == 1
    assert (
        setup_wizard._pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True)
        == setup_wizard._ANY_SENTINEL
    )
    assert setup_wizard._pick("Team", ["Alpha", "Bravo"], allow_any=True, allow_custom=True) == 0
