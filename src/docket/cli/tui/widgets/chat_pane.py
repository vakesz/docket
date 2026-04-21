from __future__ import annotations

from textual.app import ComposeResult
from textual.containers import Vertical, VerticalScroll
from textual.message import Message
from textual.widgets import Input, Static

from docket.agent.types import ChatMessage, StreamDelta, Usage
from docket.core.model import Item


class UserTurnRequest(Message):
    """Posted when the user submits a chat message. The parent app is
    responsible for running the agent and calling back into the pane."""

    def __init__(self, text: str) -> None:
        super().__init__()
        self.text = text


class NewThreadRequest(Message):
    pass


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
    ChatPane { padding: 0; }
    ChatPane #chat-title { padding: 0 1; color: $text-muted; height: 1; }
    ChatPane #ledger { padding: 0 1; color: $text-muted; height: 1; }
    ChatPane #transcript { height: 1fr; border-top: tall $primary-darken-1;
                           border-bottom: tall $primary-darken-1; padding: 0 1; }
    ChatPane #prompt { dock: bottom; height: 3; }
    ChatPane .msg-user { color: $accent; padding-bottom: 1; }
    ChatPane .msg-assistant { padding-bottom: 1; }
    ChatPane .msg-tool { color: $warning; padding-bottom: 1; }
    ChatPane .msg-system { color: $text-muted; padding-bottom: 1; }
    """

    def __init__(self, *, id: str | None = None) -> None:
        super().__init__(id=id)
        self._item: Item | None = None
        self._active_assistant: Static | None = None
        self._active_text: str = ""

    def compose(self) -> ComposeResult:
        yield Static("Chat — select an item", id="chat-title")
        yield VerticalScroll(id="transcript")
        yield Static("tokens in: 0  out: 0  cached: 0", id="ledger")
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
        if item is None:
            title.update("Chat — select an item")
            prompt.disabled = True
            return
        title.update(f"Chat · {item.id} — {item.title}")
        prompt.disabled = False

    def show_history(self, messages: list[ChatMessage]) -> None:
        transcript = self.query_one("#transcript", VerticalScroll)
        transcript.remove_children()
        for m in messages:
            if m.role == "user":
                transcript.mount(Static(f"[b]you[/b]  {m.content}", classes="msg-user"))
            elif m.role == "assistant":
                if m.content:
                    transcript.mount(Static(f"[b]assistant[/b]  {m.content}", classes="msg-assistant"))
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
        self.query_one("#ledger", Static).update(
            f"tokens in: {usage.tokens_in}  out: {usage.tokens_out}  cached: {usage.cached_tokens_in}"
        )

    def set_status(self, text: str) -> None:
        self.query_one("#ledger", Static).update(text)

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
