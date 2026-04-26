"""Guards the architectural invariant that `core/`, `storage/`, `agent/`, and `api/`
do not import concrete provider packages. Those layers must only depend on
`docket.providers.base` (the Protocol) and `docket.providers.registry` (factory
lookup). Concrete provider packages (`azure_devops`, `github`, `github_stub`,
plus any third-party package that ships via the `docket.providers` entry-point
group) stay out of provider-neutral code.

The CLI intentionally imports concrete providers to build the registry, so it is
excluded from this check."""

from __future__ import annotations

import re
from pathlib import Path

SRC = Path(__file__).resolve().parents[2] / "src" / "docket"
PROVIDERS_DIR = SRC / "providers"

# Auto-discover concrete provider packages in the repo so the guard stays in sync
# when a new provider is added under `src/docket/providers/`.
ALLOWED_PROVIDER_MODULES = {"base", "registry"}
CONCRETE_PROVIDER_PACKAGES = sorted(
    p.name for p in PROVIDERS_DIR.iterdir() if p.is_dir() and not p.name.startswith("_")
)

# Matches `import docket.providers.<pkg>...` and `from docket.providers.<pkg>...`.
# The named group `pkg` captures the first segment after `docket.providers.` so the
# guard can let through `base` / `registry` (which are modules, not packages).
_IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+docket\.providers\.(?P<pkg>[A-Za-z_][A-Za-z0-9_]*)")


def _python_files_under(subpkg: str) -> list[Path]:
    return list((SRC / subpkg).rglob("*.py"))


def _forbidden_imports(path: Path) -> list[str]:
    bad: list[str] = []
    for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        match = _IMPORT_RE.match(line)
        if match is None:
            continue
        pkg = match.group("pkg")
        if pkg in ALLOWED_PROVIDER_MODULES:
            continue
        bad.append(f"{path}:{lineno}: {stripped}")
    return bad


def test_provider_neutral_layers_do_not_import_concrete_providers() -> None:
    """`core/`, `storage/`, `agent/`, `api/` must only see provider base/registry."""
    bad: list[str] = []
    for pkg in ("core", "storage", "agent", "api"):
        for f in _python_files_under(pkg):
            bad.extend(_forbidden_imports(f))
    assert not bad, "Concrete provider leaked into provider-neutral layer:\n" + "\n".join(bad)


def test_sentinel_concrete_providers_present() -> None:
    """Regression guard: if we rename or drop the known concrete provider packages
    without updating the layout, this test flags it so the boundary check does not
    silently reduce to an empty scan again."""
    assert "azure_devops" in CONCRETE_PROVIDER_PACKAGES
    assert "github" in CONCRETE_PROVIDER_PACKAGES


_KEYRING_IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+keyring\b")
_DOTENV_IMPORT_RE = re.compile(r"^\s*(?:from|import)\s+dotenv\b")


def test_keyring_only_imported_by_secrets_module() -> None:
    """`keyring` is the OS-keychain bridge; everything else goes through
    `docket.config.secrets`. This guards against a surface or service growing
    a direct dependency on the keyring backend, which would bypass the
    `KeyHintConfig` accounting and make the secret store invisible to tests."""
    expected = SRC / "config" / "secrets.py"
    bad: list[str] = []
    for f in SRC.rglob("*.py"):
        if f == expected:
            continue
        for lineno, line in enumerate(f.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if _KEYRING_IMPORT_RE.match(line):
                bad.append(f"{f}:{lineno}: {stripped}")
    assert not bad, "`keyring` may only be imported by docket/config/secrets.py:\n" + "\n".join(bad)


def test_no_module_imports_dotenv() -> None:
    """`.env` support was removed — `config.toml` is the single source of
    truth for non-secret config, the keyring is the source of truth for
    secrets, and the `--workspace` flag is the dev sandboxing escape hatch.
    A stray `from dotenv import …` is a regression."""
    bad: list[str] = []
    for f in SRC.rglob("*.py"):
        for lineno, line in enumerate(f.read_text(encoding="utf-8").splitlines(), start=1):
            stripped = line.strip()
            if stripped.startswith("#"):
                continue
            if _DOTENV_IMPORT_RE.match(line):
                bad.append(f"{f}:{lineno}: {stripped}")
    assert not bad, "`dotenv` was dropped — remove these imports:\n" + "\n".join(bad)
