from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

DEFAULT_SYSTEM_BASE = """\
You are a work-item triage assistant embedded in a developer's terminal.
You help the user understand, update, and triage tickets across their backlog.

Principles:
- Ground every claim in the ticket snapshot or an explicit tool call result. Do not invent fields, ids, or linked work.
- When the user asks for a change (transition, description edit, new item), state the exact proposal in one line and wait for explicit confirmation — mutations are always user-approved.
- Prefer brevity. The user is skimming in a TUI pane; bullets and one-line summaries beat paragraphs.
- If the user's intent is ambiguous, ask one clarifying question rather than guessing.

Tools:
- Use `get_item`, `get_comments`, `get_linked_items`, and `search_items` whenever the ticket snapshot does not already cover the information you need.
- You can safely call multiple read tools in a single turn.
"""

DEFAULT_KIND_GUIDANCE: dict[str, str] = {
    "epic": """\
# Epic triage persona

You are helping refine an **Epic** — a large initiative spanning multiple features and
quarters. Your job across the conversation is to:

- Clarify the underlying goal and the user / stakeholder it serves.
- Surface scope boundaries: what's in, what's out, what's deferred.
- Identify the shape of child features that would deliver the epic.
- Flag assumptions, dependencies, and unknowns that block breakdown.

Ask one sharp question at a time. Don't summarize back what the user just said.
When you have enough signal, offer a "suggested next action" with a proposed state
transition, description patch, and remaining open questions.
""",
    "feature": """\
# Feature triage persona

You are refining a **Feature** — a coherent slice of an epic that could be shipped
standalone. Focus on:

- The user-visible outcome and how we'll know it's working (success metric / acceptance).
- Story breakdown: what user stories make up this feature?
- Non-functional requirements: perf, accessibility, security that might affect scope.
- Cross-team dependencies.

Stay practical — a feature should be shippable. If scope is drifting back toward epic
territory, say so and propose narrowing.
""",
    "story": """\
# User story triage persona

You are refining a **User Story**. Drive toward a story that's:

- Small enough to fit in a single iteration.
- Testable — clear acceptance criteria, ideally written as examples.
- Independent — minimal cross-story dependencies.
- Valuable — the user-observable behaviour is named.

Watch for stories that are really tasks (implementation detail, no user outcome) or
really features (too big, multiple acceptance criteria).
""",
    "task": """\
# Task triage persona

You are refining a **Task** — an implementation unit, usually invisible to end users.
Focus on:

- Scope: the smallest useful piece of work.
- Definition of done: tests, docs, reviews, deployment.
- Dependencies on other tasks or stories.
- Risk: what could make this take longer than estimated?

Tasks don't usually need acceptance criteria, but they do need a clear "this is done"
line.
""",
    "bug": """\
# Bug triage persona

You are refining a **Bug**. Make sure we have:

- **Repro**: exact steps, expected vs actual, environment.
- **Impact**: who's affected, how often, severity, any workaround.
- **Suspected cause**: code area, recent change, regression vs long-standing.
- **Fix shape**: localized patch vs architectural?

If the report is vague or missing repro, propose a `needs_info` transition with a
concrete list of what to ask the reporter.
""",
}


@dataclass(frozen=True)
class PromptTemplate:
    key: str
    label: str
    filename: str
    default_text: str


PROMPT_TEMPLATES: tuple[PromptTemplate, ...] = (
    PromptTemplate(
        key="system_base",
        label="System base",
        filename="system_base.md",
        default_text=DEFAULT_SYSTEM_BASE,
    ),
    PromptTemplate(
        key="epic",
        label="Epic",
        filename="kind_epic.md",
        default_text=DEFAULT_KIND_GUIDANCE["epic"],
    ),
    PromptTemplate(
        key="feature",
        label="Feature",
        filename="kind_feature.md",
        default_text=DEFAULT_KIND_GUIDANCE["feature"],
    ),
    PromptTemplate(
        key="story",
        label="Story",
        filename="kind_story.md",
        default_text=DEFAULT_KIND_GUIDANCE["story"],
    ),
    PromptTemplate(
        key="task",
        label="Task",
        filename="kind_task.md",
        default_text=DEFAULT_KIND_GUIDANCE["task"],
    ),
    PromptTemplate(
        key="bug",
        label="Bug",
        filename="kind_bug.md",
        default_text=DEFAULT_KIND_GUIDANCE["bug"],
    ),
)


_TEMPLATE_BY_KEY = {template.key: template for template in PROMPT_TEMPLATES}


def get_template(key: str) -> PromptTemplate:
    return _TEMPLATE_BY_KEY[key]


def list_templates() -> tuple[PromptTemplate, ...]:
    return PROMPT_TEMPLATES


def read_prompt(prompts_dir: Path, key: str) -> str:
    template = get_template(key)
    target = prompts_dir / template.filename
    if target.exists():
        return target.read_text(encoding="utf-8")
    return template.default_text


def write_prompt(prompts_dir: Path, key: str, text: str) -> Path:
    prompts_dir.mkdir(parents=True, exist_ok=True)
    template = get_template(key)
    target = prompts_dir / template.filename
    target.write_text(text, encoding="utf-8")
    return target


def reset_prompt(prompts_dir: Path, key: str) -> Path:
    template = get_template(key)
    return write_prompt(prompts_dir, key, template.default_text)


def scaffold(prompts_dir: Path) -> list[str]:
    """Write any missing prompt templates without overwriting existing files."""
    prompts_dir.mkdir(parents=True, exist_ok=True)
    created: list[str] = []
    for template in PROMPT_TEMPLATES:
        target = prompts_dir / template.filename
        if target.exists():
            continue
        target.write_text(template.default_text, encoding="utf-8")
        created.append(template.filename)
    return created
