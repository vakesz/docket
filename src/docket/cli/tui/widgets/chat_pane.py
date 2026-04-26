from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Horizontal, Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Button, Checkbox, Input, Markdown, Static

from docket.agent.types import ChatMessage, StreamDelta, Usage
from docket.core.acceptance import AcceptanceCriterion, extract_acceptance_criteria
from docket.core.model import Item
from docket.core.question import Question, QuestionAnswer


class UserTurnRequest(Message):
    """Posted when the user submits a chat message. The parent app is
    responsible for running the agent and calling back into the pane."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text


class TurnFinished(Message):
    """Posted after a chat turn's usage/cost have been computed.

    The app listens so it can roll the per-turn cost into the status-bar
    conversation-total counter. `cost_cents` is 0 when pricing is not
    configured in `[llm]` (price_input_per_1m / price_output_per_1m)."""

    def __init__(self, usage: Usage, cost_cents: int) -> None:
        super().__init__()
        self.usage = usage
        self.cost_cents = cost_cents


class AnswerQuestionRequest(Message):
    """Posted by `QuestionCard` when the user submits answers to a staged
    `ask_user` question. The app handles this by calling
    `conversation_service.submit_question_answer` to resume the agent loop."""

    def __init__(self, question_id: str, answers: tuple[QuestionAnswer, ...]) -> None:
        super().__init__()
        self.question_id = question_id
        self.answers = answers


class QuestionCard(Vertical):
    """Inline structured question card.

    Renders one fieldset per `QuestionItem` with selectable options and an
    optional "Other" input. Posts `AnswerQuestionRequest` when the user
    submits. Disabled state is set by the parent while the resume turn is
    streaming so the user can't double-submit."""

    DEFAULT_CSS = """
    QuestionCard {
        height: auto;
        margin: 0 0 1 0;
        padding: 1 1 1 1;
        border: round $accent;
        background: $boost;
    }
    QuestionCard #q-header {
        height: auto;
        color: $accent;
        text-style: bold;
        padding: 0 0 1 0;
    }
    QuestionCard .q-fieldset {
        height: auto;
        padding: 0 0 1 0;
    }
    QuestionCard .q-prompt {
        height: auto;
        color: $text;
        padding: 0 0 0 0;
    }
    QuestionCard .q-meta {
        height: 1;
        color: $text-muted;
    }
    QuestionCard Checkbox {
        height: auto;
        background: transparent;
        padding: 0 0 0 1;
    }
    QuestionCard .q-other {
        height: 3;
        margin: 0 0 0 1;
    }
    QuestionCard #q-actions {
        height: auto;
        padding-top: 1;
    }
    QuestionCard #q-actions Button { margin-right: 1; }
    """

    def __init__(self, question: Question, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._question = question
        # Pre-allocate one selection set + "other" buffer per question item so
        # the on-toggle handlers can mutate state without re-querying widgets.
        self._selected: list[set[str]] = [set() for _ in question.questions]
        self._other: list[str] = ["" for _ in question.questions]
        self._submitted = False

    @property
    def question_id(self) -> str:
        return self._question.id

    def compose(self) -> ComposeResult:
        yield Static("ask · awaiting your answer", id="q-header")
        for idx, item in enumerate(self._question.questions):
            with Vertical(classes="q-fieldset"):
                kind = "multi-select" if item.multi_select else "pick one"
                yield Static(f"[{item.header}] · {kind}", classes="q-meta")
                yield Static(item.question, classes="q-prompt")
                for opt in item.options:
                    yield Checkbox(
                        opt.label,
                        value=False,
                        id=f"q-opt-{idx}-{_safe_id(opt.label)}",
                        classes=f"q-opt q-opt-{idx}",
                    )
                if item.allow_other:
                    yield Input(
                        placeholder="Other…",
                        id=f"q-other-{idx}",
                        classes="q-other",
                    )
        with Horizontal(id="q-actions"):
            yield Button("Submit", id="q-submit", variant="primary")

    def set_disabled(self, disabled: bool) -> None:
        """Disable every interactive child — used while the resume turn streams.

        Querying with the broad union keeps the call site simple; widgets that
        have no `disabled` attribute (e.g. `Static`) are skipped."""
        for w in list(self.query("Checkbox, Input, Button")):
            w.disabled = disabled

    def on_checkbox_changed(self, event: Checkbox.Changed) -> None:
        cb = event.checkbox
        cb_id = cb.id or ""
        if not cb_id.startswith("q-opt-"):
            return
        # Layout: q-opt-{idx}-{safe-label}
        try:
            idx = int(cb_id.split("-", 3)[2])
        except (IndexError, ValueError):
            return
        item = self._question.questions[idx]
        label = str(cb.label).strip()
        if event.value:
            if not item.multi_select:
                # Single-select: clear every other checkbox in this fieldset
                # (and any "Other" buffer), so the on-screen state matches the
                # one-pick-per-question contract.
                self._selected[idx] = {label}
                self._other[idx] = ""
                other = self._other_input(idx)
                if other is not None:
                    other.value = ""
                for sibling in self.query(f".q-opt-{idx}").results(Checkbox):
                    if sibling is cb:
                        continue
                    if sibling.value:
                        sibling.value = False
            else:
                self._selected[idx].add(label)
        else:
            self._selected[idx].discard(label)

    def on_input_changed(self, event: Input.Changed) -> None:
        inp_id = event.input.id or ""
        if not inp_id.startswith("q-other-"):
            return
        try:
            idx = int(inp_id.split("-", 2)[2])
        except (IndexError, ValueError):
            return
        item = self._question.questions[idx]
        text = event.value
        self._other[idx] = text
        # Single-select: typing into "Other" clears any picked option, matching
        # the frontend card's behavior.
        if text and not item.multi_select:
            self._selected[idx] = set()
            for sibling in self.query(f".q-opt-{idx}").results(Checkbox):
                if sibling.value:
                    sibling.value = False

    def on_input_submitted(self, event: Input.Submitted) -> None:
        # Pressing Enter inside an "Other" field should not submit the form —
        # users may still want to pick a checkbox after typing. Swallow the
        # event so it doesn't bubble to the chat prompt.
        event.stop()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id != "q-submit":
            return
        if self._submitted:
            return
        if not self._is_ready():
            return
        self._submitted = True
        self.set_disabled(True)
        answers = tuple(
            QuestionAnswer(
                selected=tuple(self._selected[idx]),
                other_text=(self._other[idx].strip() or None),
            )
            for idx in range(len(self._question.questions))
        )
        self.post_message(AnswerQuestionRequest(self._question.id, answers))

    def _other_input(self, idx: int) -> Input | None:
        try:
            return self.query_one(f"#q-other-{idx}", Input)
        except Exception:
            return None

    def _is_ready(self) -> bool:
        for idx, item in enumerate(self._question.questions):
            if self._selected[idx]:
                continue
            if item.allow_other and self._other[idx].strip():
                continue
            return False
        return True


def _safe_id(label: str) -> str:
    """Make `label` safe for use inside a Textual widget id.

    Textual ids must match `^[a-zA-Z_][a-zA-Z0-9_-]*$`. We don't need a perfect
    mapping back — the on-change handler reads `cb.label`, not the id."""
    return "".join(c if c.isalnum() else "-" for c in label) or "opt"


class ChatPane(Vertical):
    """Streaming chat for the currently bound item.

    Contract with the app:
      - App calls `bind_item(item)` on selection.
      - When the user submits text, ChatPane posts `UserTurnRequest`.
      - The app drives the agent and pushes assistant output back via
        `begin_assistant()`, `append_delta(text)`, and `finish_turn(usage)`.
        Tool activity is shown via `note(text)`.
    """

    DEFAULT_CSS = """
    ChatPane {
        padding: 0;
        background: transparent;
    }
    ChatPane #chat-title {
        padding: 0 2 0 2;
        color: $text-muted;
        height: auto;
    }
    ChatPane #criteria {
        height: auto;
        max-height: 8;
        margin: 0 2 1 2;
        padding: 0 1 1 1;
        border: round $panel-lighten-1;
        background: $boost;
        display: none;
    }
    ChatPane #criteria.has-items { display: block; }
    ChatPane #criteria-title {
        color: $text-muted;
        height: 1;
    }
    ChatPane #ledger {
        padding: 0 2 1 2;
        color: $text-muted;
        height: auto;
    }
    ChatPane #transcript {
        height: 1fr;
        margin: 0 2 1 2;
        padding: 0 0 1 0;
        border: none;
        background: transparent;
    }
    ChatPane #thinking-indicator {
        height: 1;
        padding: 0 2 0 2;
        color: $accent;
        text-style: italic;
        display: none;
    }
    ChatPane #thinking-indicator.active { display: block; }
    ChatPane #empty-hint {
        height: 1fr;
        content-align: center middle;
        color: $text-disabled;
        padding: 2 4;
        display: none;
    }
    ChatPane #empty-hint.visible { display: block; }
    ChatPane #prompt {
        dock: bottom;
        height: 3;
        margin: 0 2 1 2;
        border: round $panel-lighten-1;
        background: $boost;
        color: $text;
    }
    ChatPane #prompt:focus {
        border: round $accent;
    }
    ChatPane .msg-user {
        color: $accent;
        text-style: bold;
        padding: 0 1 1 0;
    }
    ChatPane .msg-assistant {
        color: $text;
        padding: 0 1 1 0;
        background: transparent;
    }
    ChatPane Markdown.msg-assistant { margin: 0 1 1 0; }
    ChatPane Markdown.msg-assistant MarkdownBlock { margin: 0; }
    ChatPane .msg-tool {
        color: $text-muted;
        padding: 0 1 1 0;
    }
    ChatPane .msg-system {
        color: $text-muted;
        padding: 0 1 1 0;
    }
    """

    def __init__(self, *, id: str | None = None, show_acceptance_criteria: bool = True) -> None:
        super().__init__(id=id)
        self._item: Item | None = None
        self._active_assistant: Static | None = None
        self._active_text: str = ""
        self._show_acceptance_criteria = show_acceptance_criteria
        self._question_card: QuestionCard | None = None
        self.tooltip = (
            "Chat about the selected item, stage proposals, and review acceptance criteria."
        )

    def compose(self) -> ComposeResult:
        yield Static("Select a ticket", id="chat-title")
        with VerticalScroll(id="criteria"):
            yield Static("[b]acceptance criteria[/b]", id="criteria-title")
        yield Static(
            "Select an item from the backlog to start chatting.\n\n"
            "Use [b]/[/b] to filter  ·  [b]:[/b] to open by id  ·  [b]?[/b] for all shortcuts",
            id="empty-hint",
            classes="visible",
        )
        yield VerticalScroll(id="transcript")
        yield Static("thinking…", id="thinking-indicator")
        yield Static("", id="ledger")
        yield Input(placeholder="Ask about this ticket… (enter to send)", id="prompt")

    # -- public API used by the app -----------------------------------------

    def bind_item(self, item: Item | None) -> None:
        self._item = item
        self._active_assistant = None
        self._active_text = ""
        self._question_card = None
        self.set_thinking(False)
        transcript = self.query_one("#transcript", VerticalScroll)
        transcript.remove_children()
        title = self.query_one("#chat-title", Static)
        prompt = self.query_one("#prompt", Input)
        hint = self.query_one("#empty-hint", Static)
        prompt.tooltip = "Press Enter to send the current message."
        if item is None:
            title.update("Select a ticket")
            prompt.disabled = True
            hint.add_class("visible")
            self.set_status("")
            self._render_criteria([])
            return
        hint.remove_class("visible")
        title.update(f"{item.id} · {item.kind.value} · {item.state.value}")
        prompt.disabled = False
        self.set_status("")
        self._render_criteria(extract_acceptance_criteria(item.description_md or ""))

    def _render_criteria(self, criteria: list[AcceptanceCriterion]) -> None:
        """Mount one Checkbox per criterion. State is local UI only — toggling
        never writes back to the ticket, it just lets the triager mentally
        tick items off during the conversation."""
        container = self.query_one("#criteria", VerticalScroll)
        # Keep the header Static, drop the rest.
        for child in list(container.children):
            if child.id != "criteria-title":
                child.remove()
        if not self._show_acceptance_criteria or not criteria:
            container.remove_class("has-items")
            return
        container.add_class("has-items")
        for c in criteria:
            container.mount(Checkbox(c.text, value=c.checked))

    def show_history(self, messages: list[ChatMessage]) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        transcript.remove_children()
        for m in messages:
            if m.role == "user":
                transcript.mount(Static(f"[b]you[/b]  {m.content}", classes="msg-user"))
            elif m.role == "assistant":
                if m.content:
                    transcript.mount(
                        Markdown(
                            f"**assistant**\n\n{m.content}",
                            classes="msg-assistant",
                        )
                    )
                for tc in m.tool_calls:
                    transcript.mount(
                        Static(f"[i]→ {tc.name}({tc.arguments})[/i]", classes="msg-tool")
                    )
            elif m.role == "tool":
                transcript.mount(
                    Static(f"[i]← {m.name or 'tool'}: {m.content[:200]}[/i]", classes="msg-tool")
                )

    def append_user(self, text: str) -> None:
        t = self.query_one("#transcript", VerticalScroll)
        t.mount(Static(f"[b]you[/b]  {text}", classes="msg-user"))
        t.scroll_end(animate=False)

    def begin_assistant(self) -> None:
        """Mark the start of an agent turn. We don't mount the assistant row
        yet — the first delta (or tool note) does that lazily so the
        transcript reflects real arrival order instead of a placeholder
        "…" pinned above later tool rows."""
        self._active_assistant = None
        self._active_text = ""

    def append_delta(self, delta: StreamDelta) -> None:
        if not delta.text:
            return
        if self._active_assistant is None:
            # Either the first delta of the turn, or a delta that arrived
            # after a tool note cleared the active row. Either way, open a
            # fresh assistant Static so subsequent text renders below the
            # preceding tool/system rows in arrival order.
            self._active_text = ""
            self._active_assistant = Static("[b]assistant[/b]  ", classes="msg-assistant")
            self.query_one("#transcript", VerticalScroll).mount(self._active_assistant)
        self._active_text += delta.text
        self._active_assistant.update(f"[b]assistant[/b]  {self._active_text}")
        self.query_one("#transcript", VerticalScroll).scroll_end(animate=False)

    def note(self, text: str, *, cls: str = "msg-tool") -> None:
        """Append a one-line note — typically a tool call or system event."""
        # Seal any in-flight assistant segment as rendered markdown before
        # appending the note, so code blocks/lists from the preceding text
        # render even when a tool call interrupts the stream.
        self._finalize_active_assistant()
        t = self.query_one("#transcript", VerticalScroll)
        t.mount(Static(f"[i]{text}[/i]", classes=cls))
        t.scroll_end(animate=False)

    def _finalize_active_assistant(self) -> None:
        """Swap the streaming assistant Static for a rendered Markdown widget.

        Streaming uses a plain Static so per-delta updates are cheap. Once a
        segment seals (tool call, new segment, or turn end), we replace it
        with a Markdown widget in the same transcript slot so headings,
        lists, and fenced code actually render."""
        if self._active_assistant is None:
            return
        if self._active_text:
            transcript = self.query_one("#transcript", VerticalScroll)
            md = Markdown(
                f"**assistant**\n\n{self._active_text}",
                classes="msg-assistant",
            )
            transcript.mount(md, before=self._active_assistant)
        self._active_assistant.remove()
        self._active_assistant = None
        self._active_text = ""

    def finish_turn(
        self,
        usage: Usage,
        price_input_per_1m: float | None = None,
        price_output_per_1m: float | None = None,
    ) -> None:
        self._finalize_active_assistant()
        self.set_thinking(False)
        line = f"tokens in: {usage.tokens_in}  out: {usage.tokens_out}"
        cost_cents = 0
        if price_input_per_1m is not None and price_output_per_1m is not None:
            # Cached input bills at a much lower rate than fresh input, so
            # subtract it from the full `tokens_in` bucket before pricing.
            fresh_in = max(0, usage.tokens_in - usage.cached_tokens_in)
            cost = (
                fresh_in * price_input_per_1m + usage.tokens_out * price_output_per_1m
            ) / 1_000_000
            line = f"{line}  ${cost:.4f}"
            cost_cents = round(cost * 100)
        self.query_one("#ledger", Static).update(line)
        self.post_message(TurnFinished(usage, cost_cents))

    def set_status(self, text: str) -> None:
        self.query_one("#ledger", Static).update(text)

    def set_thinking(self, value: bool) -> None:
        """Show/hide the in-pane thinking indicator. Kept inside the pane (and
        not only in the status bar) so the user sees the agent is working
        without having to glance at the bottom of the screen."""
        indicator = self.query_one("#thinking-indicator", Static)
        if value:
            indicator.add_class("active")
        else:
            indicator.remove_class("active")

    def show_question(self, question: Question) -> None:
        """Render a structured `ask_user` question card inline at the bottom
        of the transcript and prompt the user for an answer.

        The card stays in place after the user submits — the parent will call
        `clear_question()` once the resume turn finishes, so the user can see
        what they answered alongside the assistant's reply that follows."""
        # Seal any in-flight assistant segment first so the question card lands
        # below the assistant's preamble text in the transcript.
        self._finalize_active_assistant()
        if self._question_card is not None:
            self._question_card.remove()
            self._question_card = None
        card = QuestionCard(question, id="question-card")
        self._question_card = card
        transcript = self.query_one("#transcript", VerticalScroll)
        transcript.mount(card)
        transcript.scroll_end(animate=False)
        prompt = self.query_one("#prompt", Input)
        prompt.placeholder = (
            "Pick from the card above, or type free text to answer the first question."
        )

    def clear_question(self) -> None:
        if self._question_card is not None:
            self._question_card.remove()
            self._question_card = None
        prompt = self.query_one("#prompt", Input)
        prompt.placeholder = "Ask about this ticket… (enter to send)"

    def has_pending_question(self) -> bool:
        return self._question_card is not None

    def set_question_disabled(self, disabled: bool) -> None:
        if self._question_card is not None:
            self._question_card.set_disabled(disabled)

    def seed_input(self, text: str) -> None:
        """Pre-fill the prompt input with `text` and focus it.

        Used by handoff flows like "Refine in chat" on a suggestion: the
        suggestion content lands here as an editable draft so the user can
        tweak it before pressing Enter to send.
        """
        prompt = self.query_one("#prompt", Input)
        prompt.value = text
        # Keep the prompt enabled; if the pane has no item bound (`disabled`
        # is True from `bind_item(None)`), there's nothing useful to seed.
        if not prompt.disabled:
            prompt.focus()
            prompt.cursor_position = len(text)

    def set_show_acceptance_criteria(self, enabled: bool) -> None:
        self._show_acceptance_criteria = enabled
        if self._item is None:
            self._render_criteria([])
            return
        self._render_criteria(extract_acceptance_criteria(self._item.description_md or ""))

    # -- events --------------------------------------------------------------

    def on_input_submitted(self, event: Input.Submitted) -> None:
        if event.input.id != "prompt":
            return
        text = (event.value or "").strip()
        if not text:
            return
        event.input.value = ""
        if self._item is None:
            self.note("Select an item before chatting.", cls="msg-system")
            return
        self.append_user(text)
        self.post_message(UserTurnRequest(text))
