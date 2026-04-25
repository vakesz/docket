"""Prompt assembly.

OpenAI-compatible endpoints cache on exact prefix match, so we keep the prefix layout stable:
  [system: role + item-kind template]
  [ticket snapshot: title, metadata, description, comments]
  --- cacheable boundary ---
  [conversation messages so far]

If the ticket's `updated_at` changes, the snapshot changes and the cache is
invalidated — intended. We DO NOT interpolate dynamic values (timestamps,
scopes, usernames) into the prefix, because they would defeat caching on
what should otherwise be identical tickets.

Hot-reload: the system template and per-kind guidance can be overridden by
dropping `system_base.md` or `kind_<kind>.md` into `<config_dir>/prompts/`.
The loader reads from disk each call, so edits are picked up on the next
agent turn without restarting the app.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from docket.agent.types import ChatMessage
from docket.core.model import Comment, Item, MemoryEntry

DEFAULT_SYSTEM_BASE = """\
You are a work-item triage assistant inside a developer's terminal.
Ground every answer in the ticket snapshot, project memory, sources, or a tool result. Never invent ids, fields, links, or history.

Response style
- Terse. Bullets and one-liners, no preamble, no restating the user.
- Name ids and fields in backticks.
- Ambiguous intent? Ask one sharp clarifying question instead of guessing.

Markdown formatting (always render as proper markdown)
- Use `##` for section labels (e.g. `## Context`, `## Next steps`, `## Risks`) — never bare label lines.
- Use `-` bullets for lists, `1.` for ordered steps; blank line before and after every list or heading.
- Separate paragraphs with a blank line, not a single newline.
- Use fenced ``` code blocks for commands, diffs, or multi-line snippets; inline backticks for ids, fields, paths, flags.
- Default shape for any "next action" or triage answer: short lead sentence, then `## Next steps` with 3-6 numbered, concrete, actionable items (verbs first). Add `## Risks` or `## Open questions` only when non-empty.

Tools — read first, act last
- Read-only (call freely, in parallel when useful):
  `get_item`, `get_comments`, `get_linked_items`, `search_items`, `find_related_prs`,
  `list_memory`, `recall_memory`, `list_sources`, `read_source`, `search_sources`.
- Before proposing a change, check `recall_memory` and `search_sources` for prior decisions or standards that constrain the answer.
- Before `propose_new_item`, run `search_items` to avoid duplicates.

Tool hygiene (avoid burning rounds)
- `search_items` hits the **local cache only**. If it returns `{"matches": [], ...}` or `[]`, do NOT retry the same search with reworded queries. Either narrow with `kind`, switch to `get_item` with a known id, or state you couldn't find anything and move on.
- Call `recall_memory` / `search_sources` at most once per distinct information need. If empty, trust it and proceed.
- `get_item` already returns `description_md`, `links`, and (when known) `repository_url` — use them before reaching for more tools.
- Prefer `get_item` with `include=["comments", "linked"]` over calling `get_item`, `get_comments`, and `get_linked_items` sequentially — it fans out in one round.

Repo & external context
- `get_item` returns `repository_url` when the provider can attest to it (GitHub always; Azure DevOps usually can't). Treat it as the authoritative repo pointer; fall through to `links` or `url` only when it's null.
- When the item's `repository_url`, `url`, or `links` point at a repo/PR/commit (GitHub, Azure DevOps Git, etc.), or the user asks about implementation details, prefer configured MCP tools named `mcp__<server>__<tool>` (e.g. `mcp__github__*`, `mcp__git__*`). Their descriptions and schemas are loaded alongside the built-ins.
- Parse owner/repo/number from `repository_url` or `links` before calling an MCP tool — don't guess.
- If no MCP server covers the resource, fall back to `find_related_prs` (if available) or say the context isn't reachable from here.

Mutations are proposal-first
- Writes go through `propose_transition`, `propose_description_patch`, `propose_new_item`, `attach_transcript`, `propose_memory_write`, `propose_memory_delete`.
- State the change in one line before calling the tool: what, from → to, why.
- Tools return `pending_confirmation` — nothing is applied until the user confirms the diff in the UI. Never claim a change "happened"; only that it's staged.

New work items (including tests)
- When the user asks for a test, follow-up, or any new item, use `propose_new_item`.
- Pick `kind`: `task` for implementation work, `story` for user-visible outcomes, `bug`/`feature`/`epic` as appropriate.
- Put the "done" line or acceptance criteria in `description_md`.
- Set `parent_id` when context is clear; otherwise ask. Surface any entries returned in `similar` before recommending the proposal.

Confirmation policy
- Ask first when: the target id is ambiguous, the transition intent doesn't obviously fit the current state, scope is missing from a new item, or an edit would overwrite non-trivial existing text.
- Never ask permission to read.

Asking the user — always use `ask_user`
- When you need information or a decision from the user, you MUST call `ask_user`. Never put the question itself in your prose.
- You may write a brief context sentence first (one or two lines) explaining what the user needs to know to answer; the question itself goes through the tool.
- Provide 2-4 mutually exclusive options per question, or set `multi_select: true` when several can be picked together. An "Other" free-text choice is added automatically — do NOT include it yourself.
- Group related questions (1-4) in a single `ask_user` call instead of asking them one by one.
- Calling `ask_user` ends your turn. Do not call other tools in the same response — you'll get to act after the user answers.

Always close the turn with a text answer
- Every turn must end with a visible assistant message — never finish on a tool call alone.
- If a tool returns an error or empty result, name what failed and still offer 2-3 options the user can pick from (e.g. retry with different args, skip and proceed with what you have, ask the user for the missing input).
- If tool budget is exhausted or you cannot finish the investigation, summarize what you learned so far and list the remaining open questions as a bullet list.
"""

DEFAULT_KIND_GUIDANCE: dict[str, str] = {
    "epic": """\
# Epic persona

Refine an **Epic** — a large initiative spanning multiple features.

Extract
- Goal and the user/stakeholder it serves.
- Scope: in, out, deferred.
- Child-feature shapes that would deliver it.
- Assumptions, dependencies, unknowns blocking breakdown.

Next action
- Ask one sharp question when signal is missing.
- When ready, stage (a) a transition via `propose_transition`, (b) a `propose_description_patch` covering goal / scope / open questions, and (c) child features via `propose_new_item` with `kind = "feature"` and `parent_id` = this epic.
""",
    "feature": """\
# Feature persona

Refine a **Feature** — a coherent, shippable slice of an epic.

Extract
- User-visible outcome and success signal (metric or acceptance).
- Story breakdown: the user stories that make up this feature.
- Non-functional constraints: perf, accessibility, security, compliance.
- Cross-team dependencies.

Next action
- If scope is drifting toward epic size, say so and propose narrowing.
- When ready, stage the description patch, any child stories via `propose_new_item` with `kind = "story"`, and a transition that matches reality (e.g. `start_work` once stories exist).
""",
    "story": """\
# Story persona

Refine a **User Story** — one iteration, one user outcome, testable.

Extract
- Small enough for one iteration.
- Acceptance criteria written as examples (given / when / then, or concrete inputs/outputs).
- Independent — minimal cross-story coupling.
- User-observable value named explicitly.

Smells to flag
- Really a task (no user outcome) → recommend `kind = "task"` instead.
- Really a feature (multiple acceptances, weeks of work) → propose splitting into stories.

Next action
- Stage a description patch with crisp acceptance criteria.
- If the user asks for a test, stage a `task` via `propose_new_item` with `parent_id` = this story, a title like "Add tests for <scenario>", and `description_md` listing the cases to cover.
""",
    "task": """\
# Task persona

Refine a **Task** — an implementation unit, usually invisible to end users.

Extract
- Smallest useful scope.
- Definition of done: code, tests, docs, review, deploy — only what applies.
- Dependencies on other tasks/stories.
- Risk: what could stretch this past estimate?

Next action
- Tasks don't need acceptance criteria, but they need a clear "done" line in the description.
- If the user asks for tests, either (a) extend the "done" line with the test cases, or (b) stage a sibling test task via `propose_new_item`. Ask which when it isn't obvious.
""",
    "bug": """\
# Bug persona

Refine a **Bug**.

Extract
- Repro: steps, expected vs actual, environment.
- Impact: who, how often, severity, workaround.
- Suspected cause: code area, recent change, regression vs long-standing.
- Fix shape: localized patch vs architectural.

Next action
- Vague or missing repro? Stage `propose_transition` with `intent = "needs_info"` and a `propose_description_patch` listing the exact questions for the reporter.
- If the user asks for a regression test, stage a `task` via `propose_new_item` with `parent_id` = this bug and the failing repro encoded as the test case.
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


class PromptLoader:
    """Reads the system template + per-kind guidance from disk, with fallbacks.

    One instance per process; call `configure(prompts_dir)` at startup to wire
    it to a directory. Unconfigured (prompts_dir=None) means "always use the
    built-in defaults" — that's what tests and headless callers get."""

    def __init__(self, prompts_dir: Path | None = None) -> None:
        self._prompts_dir = prompts_dir

    def configure(self, prompts_dir: Path | None) -> None:
        """Point the loader at a new directory."""
        self._prompts_dir = prompts_dir

    def system_base(self) -> str:
        template = get_template("system_base")
        return self._load(template.filename, template.default_text)

    def kind_guidance(self, kind: str) -> str:
        default = DEFAULT_KIND_GUIDANCE.get(kind, "")
        if not default:
            return ""
        template = get_template(kind)
        return self._load(template.filename, default)

    def _load(self, filename: str, default: str) -> str:
        if self._prompts_dir is None:
            return default
        path = self._prompts_dir / filename
        if not path.exists():
            return default
        return path.read_text(encoding="utf-8")


_loader = PromptLoader()


def configure_prompt_loader(prompts_dir: Path | None) -> None:
    """Module-level hook used by `docket open` / `docket serve` at startup."""
    _loader.configure(prompts_dir)


def get_prompt_loader() -> PromptLoader:
    """Exposed for tests; app code should rely on the module-level helpers."""
    return _loader


def build_system_message(item: Item) -> ChatMessage:
    kind_line = _loader.kind_guidance(item.kind.value)
    content = _loader.system_base().rstrip() + "\n\n" + kind_line
    return ChatMessage(role="system", content=content.strip())


def build_snapshot_message(item: Item, comments: list[Comment]) -> ChatMessage:
    lines = [
        "TICKET SNAPSHOT",
        f"id: {item.id}",
        f"kind: {item.kind.value}",
        f"state: {item.state.value}",
        f"title: {item.title}",
        f"assignee: {item.assignee or '-'}",
        f"parent: {item.parent_id or '-'}",
        f"tags: {', '.join(item.tags) if item.tags else '-'}",
        "",
        "DESCRIPTION",
        item.description_md or "(no description)",
    ]
    if comments:
        lines.append("")
        lines.append(f"COMMENTS ({len(comments)})")
        for c in comments:
            lines.append(f"- {c.author} @ {c.created_at.isoformat()}")
            lines.append(c.body_md)
    return ChatMessage(role="system", content="\n".join(lines))


def build_memory_message(entries: list[MemoryEntry]) -> ChatMessage | None:
    """Render the project's memory entries as a single system message.

    Returns None when there are no entries — callers should drop the slot
    entirely so the prompt prefix stays byte-stable across projects that
    happen to have empty memory. The message is plain Markdown sections;
    the model treats it as authoritative reference material."""
    if not entries:
        return None
    lines = [f"PROJECT MEMORY ({len(entries)})"]
    for e in entries:
        header = f"## {e.title}"
        if e.tags:
            header += f"  [{', '.join(e.tags)}]"
        lines.append("")
        lines.append(header)
        if e.body_md:
            lines.append(e.body_md.rstrip())
    return ChatMessage(role="system", content="\n".join(lines))


def build_prefix(
    item: Item,
    comments: list[Comment],
    *,
    memory: list[MemoryEntry] | None = None,
) -> list[ChatMessage]:
    """Cacheable prefix. Everything after this is turn-specific.

    Memory is inserted between the system base and the snapshot when
    non-empty; an empty memory list collapses to the same two-message
    prefix the original implementation produced, preserving cache hits
    for projects without notes."""
    messages: list[ChatMessage] = [build_system_message(item)]
    memory_msg = build_memory_message(memory or [])
    if memory_msg is not None:
        messages.append(memory_msg)
    messages.append(build_snapshot_message(item, comments))
    return messages
