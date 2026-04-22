"""Extract acceptance-criteria checklists from Markdown ticket descriptions.

The chat pane mounts the result as live checkboxes so triagers can cross
items off during a conversation without editing the ticket. Two patterns
count as acceptance criteria:

1. Any GitHub-flavored task-list item anywhere in the description:
      - [ ] ship the migration
      - [x] add the feature flag

2. A bulleted list (task-list or plain `-` / `*`) immediately under an
   `## Acceptance Criteria` (or similar) heading. The heading match is
   case-insensitive and tolerates "Acceptance criteria", "acceptance
   criteria:", etc.

Only one pattern needs to hit; if both are present, the task-list items
anywhere in the document take precedence so no criterion is dropped. We
lean GFM-task-list because it survives round-trips through the ADO and
GitHub Markdown renderers we actually write to.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

_TASK_LIST = re.compile(r"^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$")
_PLAIN_BULLET = re.compile(r"^\s*[-*]\s+(?!\[[ xX]\])(.+?)\s*$")
_HEADING = re.compile(r"^\s*#+\s*(.+?)\s*$")
_ACCEPTANCE_HEADING = re.compile(r"^\s*acceptance\s+criteria\s*:?\s*$", re.IGNORECASE)


@dataclass(frozen=True)
class AcceptanceCriterion:
    text: str
    checked: bool


def extract_acceptance_criteria(description_md: str) -> list[AcceptanceCriterion]:
    """Pull a checklist out of a Markdown description. Empty list if none."""
    if not description_md:
        return []

    lines = description_md.splitlines()

    # Pass 1: every GFM task-list item, anywhere in the doc.
    task_items = [m for m in (_TASK_LIST.match(line) for line in lines) if m is not None]
    if task_items:
        return [
            AcceptanceCriterion(text=m.group(2), checked=m.group(1).lower() == "x")
            for m in task_items
        ]

    # Pass 2: bullets under an `## Acceptance Criteria` heading.
    out: list[AcceptanceCriterion] = []
    in_section = False
    for line in lines:
        heading = _HEADING.match(line)
        if heading is not None:
            in_section = _ACCEPTANCE_HEADING.match(heading.group(1)) is not None
            continue
        if not in_section:
            continue
        plain = _PLAIN_BULLET.match(line)
        if plain is not None:
            out.append(AcceptanceCriterion(text=plain.group(1), checked=False))
            continue
        # A blank line inside the section is fine; anything else ends it.
        if line.strip() and not plain:
            in_section = False
    return out


__all__ = ["AcceptanceCriterion", "extract_acceptance_criteria"]
