"""Pane focus cycling, fullscreen toggle, and resize logic for `DocketApp`.

The three named panes (`#left`, `#mid`, `#right`) are managed as a group:

- Tab / Shift+Tab cycles focus between the tree, detail scroll, and chat
  prompt — Escape parks focus on the owning Pane container so single-key
  bindings work again, and Tab from a Pane re-enters the prompt.
- Ctrl+F toggles a fullscreen layer for the focused pane; the "Maximize"
  button on each Pane mirrors the same action.
- Ctrl+[ / Ctrl+] resize the focused pane by ±5% and steal from its
  neighbor, clamped to 10-80% so nothing collapses.

Mixin assumes the host App has `_PANE_IDS`, `_pane_pct`, and Textual's
`focused`/`screen`/`set_focus`/`query_one` machinery."""

from __future__ import annotations

import contextlib
from typing import TYPE_CHECKING, ClassVar

from textual.widget import Widget
from textual.widgets import Input

from docket.cli.tui.panes import FullscreenToggle, Pane

if TYPE_CHECKING:
    from textual.app import App

    _AppBase = App[None]
else:
    _AppBase = object


class PaneLayoutMixin(_AppBase):
    """Tab cycling, fullscreen toggling, and ±5% resizing for `DocketApp`.

    The mixin pretends to inherit from `App` at type-check time so mypy
    sees Textual's `query_one`/`focused`/`screen`/etc, and declares the
    host's `_PANE_IDS` / `_pane_pct` class attributes so they type-check
    too. At runtime it's just a plain `object` base — `DocketApp` provides
    the real App."""

    # Host-provided attributes (declared so mypy can resolve them).
    _PANE_IDS: ClassVar[tuple[str, ...]]
    _pane_pct: dict[str, int]

    def _defocus_chat_prompt(self) -> bool:
        """If the chat prompt has focus, move focus up to the owning Pane.

        Input widgets capture single-key events, so the app's letter bindings
        (`t`, `n`, `s`, …) silently no-op while the user is typing. Pressing
        Escape parks focus on the outer Pane, which is focusable but has no
        text capture, so those bindings work again. Tab from the Pane re-enters
        the prompt (see `_cycle_pane_focus`)."""
        try:
            prompt = self.query_one("#prompt", Input)
        except Exception:
            return False
        if self.focused is not prompt:
            return False
        pane = self._focused_pane()
        if pane is not None:
            pane.focus()
        else:
            self.set_focus(None)
        return True

    def _pane_focus_targets(self) -> list[Widget]:
        """Return the widget that Tab should land on for each pane — the
        item tree on the left, detail scroll in the middle, chat prompt on
        the right. Missing panes drop out silently."""
        targets: list[Widget] = []
        for pid in self._PANE_IDS:
            target: Widget | None = None
            with contextlib.suppress(Exception):
                pane = self.query_one(f"#{pid}", Widget)
                if pid == "left":
                    target = pane.query_one("#tree", Widget)
                elif pid == "mid":
                    target = pane.query_one("#mid-detail", Widget)
                else:  # right
                    target = pane.query_one("#prompt", Widget)
            if target is not None:
                targets.append(target)
        return targets

    def _cycle_pane_focus(self, direction: int) -> None:
        targets = self._pane_focus_targets()
        if not targets:
            return
        focused = self.focused
        # If focus is parked on a Pane container itself (e.g. after Escape
        # defocused the chat prompt), Tab should re-enter that pane's target
        # rather than jump to the next pane — otherwise a single Esc+Tab would
        # skip past the pane the user was working in.
        if (
            isinstance(focused, Pane)
            and isinstance(focused.id, str)
            and focused.id in self._PANE_IDS
        ):
            pane_idx = self._PANE_IDS.index(focused.id)
            if 0 <= pane_idx < len(targets):
                targets[pane_idx].focus()
                return
        idx = -1
        for i, t in enumerate(targets):
            if focused is t or (focused is not None and t in focused.ancestors):
                idx = i
                break
        next_idx = (idx + direction) % len(targets) if idx >= 0 else 0
        targets[next_idx].focus()

    def action_focus_next_pane(self) -> None:
        self._cycle_pane_focus(1)

    def action_focus_prev_pane(self) -> None:
        self._cycle_pane_focus(-1)

    def action_toggle_fullscreen(self) -> None:
        """Maximize the pane that holds the currently-focused widget; if a
        pane is already maximized, minimize back to the three-pane layout."""
        screen = self.screen
        if screen.maximized is not None:
            screen.minimize()
            self.restore_pane_widths()
            self.sync_fullscreen_icons()
            return
        pane = self._focused_pane()
        if pane is None:
            self.notify("Focus a pane first.", severity="warning")
            return
        self.clear_pane_width_override(pane)
        screen.maximize(pane)
        self.sync_fullscreen_icons()

    def clear_pane_width_override(self, pane: Widget) -> None:
        """Force the pane to fill the maximize layer.

        The base CSS pins each pane to a fraction of the screen (`#main > #mid
        { width: 41% }`), and that selector has higher specificity than
        `Pane.-maximized { width: 100% }` — so clearing the width simply falls
        back to the 41% rule and the "maximized" pane renders in its normal
        column. Setting an inline width wins over the CSS rules regardless of
        specificity, so we park 100% directly on the widget and let
        `restore_pane_widths` reset it when we minimize."""
        pane.styles.width = "100%"
        pane.styles.height = "100%"

    def restore_pane_widths(self) -> None:
        """Re-apply the user's resize preferences after leaving fullscreen."""
        for pid, pct in self._pane_pct.items():
            with contextlib.suppress(Exception):
                self.query_one(f"#{pid}", Widget).styles.width = f"{pct}%"

    def sync_fullscreen_icons(self) -> None:
        """Flip each pane's fullscreen button between "Maximize" and "Restore"
        to match the current screen state.

        Called after Ctrl+F and after clicking a FullscreenToggle so the
        visible button reflects whether this pane is the maximized one."""
        maximized = self.screen.maximized
        for toggle in self.query(FullscreenToggle):
            owner: Widget | None = toggle.parent if isinstance(toggle.parent, Widget) else None
            while owner is not None and not isinstance(owner, Pane):
                owner = owner.parent if isinstance(owner.parent, Widget) else None
            if owner is not None and owner is maximized:
                toggle.update(FullscreenToggle.LABEL_MINIMIZE)
            else:
                toggle.update(FullscreenToggle.LABEL_MAXIMIZE)

    def action_shrink_pane(self) -> None:
        self._resize_focused_pane(-5)

    def action_grow_pane(self) -> None:
        self._resize_focused_pane(+5)

    def _focused_pane(self) -> Widget | None:
        """Walk up the focused widget's ancestors until we hit one of the
        three named panes. Returns None if nothing is focused."""
        node: Widget | None = self.focused
        while node is not None:
            if isinstance(node.id, str) and node.id in self._PANE_IDS:
                return node
            node = node.parent if isinstance(node.parent, Widget) else None
        return None

    def _resize_focused_pane(self, delta_pct: int) -> None:
        """Bump the focused pane's width by delta_pct, taking the offset from
        its right neighbor (or left, if it's the rightmost pane). Each pane
        is clamped to 10-80% so nothing can collapse to zero or monopolize
        the layout."""
        pane = self._focused_pane()
        if pane is None:
            return
        pane_id = pane.id
        if pane_id not in self._pane_pct:
            return
        order = list(self._PANE_IDS)
        idx = order.index(pane_id)
        neighbor_id = order[idx + 1] if idx + 1 < len(order) else order[idx - 1]

        cur = self._pane_pct[pane_id]
        neighbor_cur = self._pane_pct[neighbor_id]
        new_cur = max(10, min(80, cur + delta_pct))
        applied = new_cur - cur
        new_neighbor = neighbor_cur - applied
        if new_neighbor < 10 or new_neighbor > 80:
            return
        self._pane_pct[pane_id] = new_cur
        self._pane_pct[neighbor_id] = new_neighbor
        self.query_one(f"#{pane_id}", Widget).styles.width = f"{new_cur}%"
        self.query_one(f"#{neighbor_id}", Widget).styles.width = f"{new_neighbor}%"


__all__ = ["PaneLayoutMixin"]
