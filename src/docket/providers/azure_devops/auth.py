from __future__ import annotations

import json
import shutil
import subprocess
from datetime import datetime
from functools import lru_cache

from docket.providers.base import ProviderAuthError

# Azure DevOps resource application ID (well-known constant, documented by Microsoft)
ADO_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798"


@lru_cache(maxsize=1)
def _az_path() -> str:
    path = shutil.which("az")
    if not path:
        raise ProviderAuthError(
            "Azure CLI (`az`) is not on PATH. Install it and run `az login`, "
            "then re-run `docket setup`."
        )
    return path


def get_ado_bearer_token() -> str:
    """Return a short-lived AAD access token for Azure DevOps, using the user's `az` session.

    Raises ProviderAuthError if `az` is missing, the user is not logged in, or the token
    response cannot be parsed.
    """
    try:
        result = subprocess.run(
            [_az_path(), "account", "get-access-token", "--resource", ADO_RESOURCE_ID, "-o", "json"],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except subprocess.CalledProcessError as e:
        raise ProviderAuthError(
            f"`az account get-access-token` failed: {e.stderr.strip() or e.stdout.strip()}. "
            f"Run `az login` and try again."
        ) from e
    except subprocess.TimeoutExpired as e:
        raise ProviderAuthError("`az account get-access-token` timed out after 30s") from e

    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as e:
        raise ProviderAuthError("Could not parse `az` token response as JSON") from e

    token = payload.get("accessToken")
    if not token:
        raise ProviderAuthError("`az` token response did not include `accessToken`")
    return str(token)


def ensure_logged_in() -> str:
    """Return the signed-in account UPN or raise. Used by the wizard's az-check step."""
    try:
        result = subprocess.run(
            [_az_path(), "account", "show", "-o", "json"],
            capture_output=True,
            text=True,
            check=True,
            timeout=10,
        )
    except subprocess.CalledProcessError as e:
        raise ProviderAuthError(
            "No active Azure CLI session. Run `az login` in another terminal, then retry."
        ) from e
    account = json.loads(result.stdout)
    return str(account.get("user", {}).get("name", "<unknown>"))


def token_expires_at(token: str) -> datetime | None:
    """Parse the JWT `exp` claim; returns None if the token is not a JWT we can read.
    We do not verify signatures — we only use the claim as a refresh hint."""
    import base64

    try:
        _, payload_b64, _ = token.split(".")
    except ValueError:
        return None
    padding = "=" * (-len(payload_b64) % 4)
    try:
        decoded = json.loads(base64.urlsafe_b64decode(payload_b64 + padding))
    except (ValueError, json.JSONDecodeError):
        return None
    exp = decoded.get("exp")
    if not isinstance(exp, (int, float)):
        return None
    return datetime.fromtimestamp(exp)
