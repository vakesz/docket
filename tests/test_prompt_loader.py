from __future__ import annotations

import os
from datetime import UTC, datetime
from pathlib import Path

import pytest

from docket.agent.prompt import (
    DEFAULT_KIND_GUIDANCE,
    DEFAULT_SYSTEM_BASE,
    PromptLoader,
    build_system_message,
    configure_prompt_loader,
)
from docket.config.prompt_templates import scaffold
from docket.core.model import Item, ItemKind, ItemState


def _item(kind: ItemKind = ItemKind.STORY) -> Item:
    return Item(
        id="S-1",
        kind=kind,
        title="t",
        description_md="d",
        state=ItemState.NEW,
        assignee=None,
        parent_id=None,
        updated_at=datetime.now(UTC),
    )


def _bump_mtime(path: Path) -> None:
    """Ensure the mtime strictly advances so mtime-keyed caches see a change,
    even on filesystems with low-resolution timestamps."""
    stat = path.stat()
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns + 1_000_000))


def test_unconfigured_loader_returns_defaults() -> None:
    loader = PromptLoader(prompts_dir=None)
    assert loader.system_base() == DEFAULT_SYSTEM_BASE
    assert loader.kind_guidance("story") == DEFAULT_KIND_GUIDANCE["story"]


def test_missing_override_falls_back_to_default(tmp_path: Path) -> None:
    loader = PromptLoader(prompts_dir=tmp_path)
    assert loader.system_base() == DEFAULT_SYSTEM_BASE
    assert loader.kind_guidance("bug") == DEFAULT_KIND_GUIDANCE["bug"]


def test_override_file_is_used(tmp_path: Path) -> None:
    (tmp_path / "system_base.md").write_text("CUSTOM BASE", encoding="utf-8")
    (tmp_path / "kind_story.md").write_text("CUSTOM STORY", encoding="utf-8")
    loader = PromptLoader(prompts_dir=tmp_path)
    assert loader.system_base() == "CUSTOM BASE"
    assert loader.kind_guidance("story") == "CUSTOM STORY"
    # Untouched kinds still fall through.
    assert loader.kind_guidance("bug") == DEFAULT_KIND_GUIDANCE["bug"]


def test_hot_reload_picks_up_edits(tmp_path: Path) -> None:
    path = tmp_path / "system_base.md"
    path.write_text("version 1", encoding="utf-8")
    loader = PromptLoader(prompts_dir=tmp_path)
    assert loader.system_base() == "version 1"

    path.write_text("version 2", encoding="utf-8")
    _bump_mtime(path)
    assert loader.system_base() == "version 2"


def test_unchanged_file_uses_cache(tmp_path: Path) -> None:
    """No extra stat should read the file body twice. We prove it indirectly:
    writing to the cache slot via _cache survives a second call when mtime
    hasn't moved."""
    path = tmp_path / "system_base.md"
    path.write_text("canon", encoding="utf-8")
    loader = PromptLoader(prompts_dir=tmp_path)
    assert loader.system_base() == "canon"
    # Mutate the cache directly to prove the second call doesn't re-read.
    loader._cache["system_base.md"] = (path.stat().st_mtime_ns, "cached only")
    assert loader.system_base() == "cached only"


def test_deleting_override_returns_to_default(tmp_path: Path) -> None:
    path = tmp_path / "system_base.md"
    path.write_text("override", encoding="utf-8")
    loader = PromptLoader(prompts_dir=tmp_path)
    assert loader.system_base() == "override"
    path.unlink()
    assert loader.system_base() == DEFAULT_SYSTEM_BASE


def test_configure_clears_cache(tmp_path: Path) -> None:
    first = tmp_path / "a"
    first.mkdir()
    (first / "system_base.md").write_text("A", encoding="utf-8")
    second = tmp_path / "b"
    second.mkdir()
    (second / "system_base.md").write_text("B", encoding="utf-8")

    loader = PromptLoader(prompts_dir=first)
    assert loader.system_base() == "A"
    loader.configure(second)
    assert loader.system_base() == "B"


def test_build_system_message_reflects_override(tmp_path: Path) -> None:
    (tmp_path / "system_base.md").write_text("BASE", encoding="utf-8")
    (tmp_path / "kind_story.md").write_text("STORY LINE", encoding="utf-8")
    configure_prompt_loader(tmp_path)
    try:
        msg = build_system_message(_item())
        assert "BASE" in msg.content
        assert "STORY LINE" in msg.content
    finally:
        # Restore the module-level loader so other tests stay on defaults.
        configure_prompt_loader(None)


def test_scaffold_creates_canonical_prompt_files(tmp_path: Path) -> None:
    created = scaffold(tmp_path)
    assert "system_base.md" in created
    assert "kind_story.md" in created
    assert (tmp_path / "system_base.md").exists()
    assert (tmp_path / "kind_bug.md").exists()


@pytest.fixture(autouse=True)
def _isolate_loader():
    """Guard every test in this module: start with a clean default loader,
    restore after to avoid leaking overrides into the rest of the suite."""
    configure_prompt_loader(None)
    yield
    configure_prompt_loader(None)
