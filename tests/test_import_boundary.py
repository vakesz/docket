"""Guards the architectural invariant that core/, cli/, api/, storage/, and agent/
do not import provider-specific modules directly. The CLI is a known exception — it
constructs providers by name and therefore imports the concrete implementation; the
test excludes it explicitly. Breaking this test means a provider-specific concept
has leaked into provider-neutral code."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "src" / "docket"
FORBIDDEN = "docket.providers.azure_devops"


def _python_files_under(subpkg: str) -> list[Path]:
    return list((ROOT / subpkg).rglob("*.py"))


def _has_forbidden_import(path: Path) -> list[str]:
    bad: list[str] = []
    for i, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.strip()
        if stripped.startswith("#"):
            continue
        if FORBIDDEN in stripped and (
            stripped.startswith("import ") or stripped.startswith("from ")
        ):
            bad.append(f"{path}:{i}: {stripped}")
    return bad


def test_core_does_not_import_azure_devops_provider() -> None:
    bad: list[str] = []
    for pkg in ("core", "storage", "agent", "api"):
        for f in _python_files_under(pkg):
            bad.extend(_has_forbidden_import(f))
    assert not bad, "Provider leak:\n" + "\n".join(bad)
