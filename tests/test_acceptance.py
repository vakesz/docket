"""Unit tests for the acceptance-criteria parser.

Covers both patterns (`- [ ]` task list anywhere, `## Acceptance Criteria`
heading with plain bullets) plus the precedence rule and edge cases that
showed up while hand-writing real tickets.
"""

from __future__ import annotations

import pytest

from docket.core.acceptance import AcceptanceCriterion, extract_acceptance_criteria


def test_empty_and_none_return_empty_list() -> None:
    assert extract_acceptance_criteria("") == []
    assert extract_acceptance_criteria("just a paragraph, no bullets.") == []


def test_task_list_items_are_extracted_with_state() -> None:
    md = "## Notes\n- [ ] ship the migration\n- [x] add the feature flag\n- [X] write the runbook\n"
    assert extract_acceptance_criteria(md) == [
        AcceptanceCriterion(text="ship the migration", checked=False),
        AcceptanceCriterion(text="add the feature flag", checked=True),
        AcceptanceCriterion(text="write the runbook", checked=True),
    ]


def test_task_list_wins_over_acceptance_section() -> None:
    """If a ticket has both styles, the explicit task-list wins — it's the
    most durable signal and already carries check state."""
    md = "## Acceptance Criteria\n- plain bullet ignored\n\n## Elsewhere\n- [ ] real criterion\n"
    assert extract_acceptance_criteria(md) == [
        AcceptanceCriterion(text="real criterion", checked=False),
    ]


def test_acceptance_heading_picks_up_plain_bullets() -> None:
    md = (
        "Intro paragraph.\n"
        "\n"
        "## Acceptance Criteria\n"
        "- user sees a login button\n"
        "* user can submit the form\n"
        "\n"
        "- still in section after blank line\n"
    )
    assert extract_acceptance_criteria(md) == [
        AcceptanceCriterion(text="user sees a login button", checked=False),
        AcceptanceCriterion(text="user can submit the form", checked=False),
        AcceptanceCriterion(text="still in section after blank line", checked=False),
    ]


def test_acceptance_heading_is_case_and_colon_tolerant() -> None:
    md = "### acceptance criteria:\n- one\n- two\n"
    assert [c.text for c in extract_acceptance_criteria(md)] == ["one", "two"]


def test_section_ends_on_next_heading_or_prose() -> None:
    md = "## Acceptance Criteria\n- first\n## Notes\n- should-not-be-included\n"
    assert [c.text for c in extract_acceptance_criteria(md)] == ["first"]


def test_section_ends_on_non_bullet_prose() -> None:
    md = "## Acceptance Criteria\n- first\nSome prose that ends the section.\n- not included\n"
    assert [c.text for c in extract_acceptance_criteria(md)] == ["first"]


@pytest.mark.parametrize(
    "heading",
    [
        "# Acceptance Criteria",
        "## Acceptance Criteria",
        "### Acceptance Criteria ",
        "##   acceptance criteria",
    ],
)
def test_various_heading_levels_all_match(heading: str) -> None:
    md = f"{heading}\n- one\n"
    assert [c.text for c in extract_acceptance_criteria(md)] == ["one"]
