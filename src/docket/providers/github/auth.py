"""GitHub auth helpers — ride on the user's `gh` CLI session.

Mirrors `providers.azure_devops.auth`: one thin wrapper around a short-
lived token, one session-status probe, and cached-path resolution. We
never ask for a PAT — if `gh auth token` fails we surface the actionable
error and point back at `gh auth login`.
"""

from __future__ import annotations

import json
import shutil
import subprocess
from functools import lru_cache

from docket.providers.base import ProviderAuthError


@lru_cache(maxsize=1)
def _gh_path() -> str:
    path = shutil.which("gh")
    if not path:
        raise ProviderAuthError(
            "GitHub CLI (`gh`) is not on PATH. Install it and run `gh auth login`, "
            "then re-run `docket setup`."
        )
    return path


def get_gh_token() -> str:
    """Return a short-lived GitHub token from the current `gh` session."""
    try:
        result = subprocess.run(
            [_gh_path(), "auth", "token"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as e:
        raise ProviderAuthError(
            f"`gh auth token` failed: {e.stderr.strip() or e.stdout.strip()}. "
            f"Run `gh auth login` and try again."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise ProviderAuthError("`gh auth token` timed out after 10s") from e
    token = result.stdout.strip()
    if not token:
        raise ProviderAuthError("`gh auth token` returned an empty token")
    return token


def ensure_logged_in() -> str:
    """Return the signed-in GitHub login, or raise. Used by the wizard's gh-check step."""
    try:
        result = subprocess.run(
            [_gh_path(), "api", "user", "--jq", ".login"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as e:
        raise ProviderAuthError(
            "No active GitHub CLI session. Run `gh auth login` in another terminal, then retry."
        ) from e
    login = result.stdout.strip()
    if not login:
        raise ProviderAuthError("`gh api user` returned no login")
    return login


def signed_in_email() -> str | None:
    """Return the signed-in user's email, or None if unavailable.

    `gh api user` returns email only when the user has it public. This is
    best-effort — a None just means the wizard can't pre-populate the
    assignee field."""
    try:
        result = subprocess.run(
            [_gh_path(), "api", "user"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
        payload = json.loads(result.stdout)
    except (
        subprocess.CalledProcessError,
        subprocess.TimeoutExpired,
        json.JSONDecodeError,
        ProviderAuthError,
    ):
        return None
    email = payload.get("email")
    return email if isinstance(email, str) and email else None
