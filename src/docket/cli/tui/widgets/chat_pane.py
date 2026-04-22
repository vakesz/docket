from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Checkbox, Input, Static

from docket.agent.types import ChatMessage, StreamDelta, Usage
from docket.config.env import get_price_input_per_1m, get_price_output_per_1m
from docket.core.acceptance import AcceptanceCriterion, extract_acceptance_criteria
from docket.core.model import Item


class UserTurnRequest(Message):
    """Posted when the user submits a chat message. The parent app is
    responsible for running the agent and calling back into the pane."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text


class NewThreadRequest(Message):
    pass


class TurnFinished(Message):
    """Posted after a chat turn's usage/cost have been computed.

    The app listens so it can roll the per-turn cost into the status-bar
    conversation-total counter. `cost_cents` is 0 when no pricing env is set."""

    def __init__(self, usage: Usage, cost_cents: int) -> None:
        super().__init__()
        self.usage = usage
        self.cost_cents = cost_cents


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
        self.tooltip = (
            "Chat about the selected item, stage proposals, and review acceptance criteria."
        )

    def compose(self) -> ComposeResult:
        yield Static("Select a ticket", id="chat-title")
        with VerticalScroll(id="criteria"):
            yield Static("[b]acceptance criteria[/b]", id="criteria-title")
        yield VerticalScroll(id="transcript")
        yield Static("", id="ledger")
        yield Input(placeholder="Ask about this ticket… (enter to send)", id="prompt")

    # -- public API used by the app -----------------------------------------

    def bind_item(self, item: Item | None) -> None:
        self._item = item
        self._active_assistant = None
        self._active_text = ""
        transcript = self.query_one("#transcript", VerticalScroll)
        transcript.remove_children()
        title = self.query_one("#chat-title", Static)
        prompt = self.query_one("#prompt", Input)
        prompt.tooltip = "Press Enter to send the current message."
        if item is None:
            title.update("Select a ticket")
            prompt.disabled = True
            self.set_status("")
            self._render_criteria([])
            return
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
                        Static(f"[b]assistant[/b]  {m.content}", classes="msg-assistant")
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
        self._active_text = ""
        self._active_assistant = Static("[b]assistant[/b]  ", classes="msg-assistant")
        t = self.query_one("#transcript", VerticalScroll)
        t.mount(self._active_assistant)
        t.scroll_end(animate=False)

    def append_delta(self, delta: StreamDelta) -> None:
        if delta.text and self._active_assistant is not None:
            self._active_text += delta.text
            self._active_assistant.update(f"[b]assistant[/b]  {self._active_text}")
            self.query_one("#transcript", VerticalScroll).scroll_end(animate=False)

    def note(self, text: str, *, cls: str = "msg-tool") -> None:
        """Append a one-line note — typically a tool call or system event."""
        self._active_assistant = None  # next assistant text starts a new row
        t = self.query_one("#transcript", VerticalScroll)
        t.mount(Static(f"[i]{text}[/i]", classes=cls))
        t.scroll_end(animate=False)

    def finish_turn(self, usage: Usage) -> None:
        self._active_assistant = None
        self._active_text = ""
        line = f"tokens in: {usage.tokens_in}  out: {usage.tokens_out}"
        cost_cents = 0
        price_in = get_price_input_per_1m()
        price_out = get_price_output_per_1m()
        if price_in is not None and price_out is not None:
            # Cached input bills at a much lower rate than fresh input, so
            # subtract it from the full `tokens_in` bucket before pricing.
            fresh_in = max(0, usage.tokens_in - usage.cached_tokens_in)
            cost = (fresh_in * price_in + usage.tokens_out * price_out) / 1_000_000
            line = f"{line}  ${cost:.4f}"
            cost_cents = round(cost * 100)
        self.query_one("#ledger", Static).update(line)
        self.post_message(TurnFinished(usage, cost_cents))

    def set_status(self, text: str) -> None:
        self.query_one("#ledger", Static).update(text)

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
