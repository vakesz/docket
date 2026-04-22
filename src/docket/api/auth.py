"""Static bearer-token auth for the HTTP surface.

The server carries a single configured token. Compared with `secrets.compare_digest`
so we don't leak the correct token through timing. A non-empty token is mandatory —
if the config is empty we refuse to bind at all (enforced in `app.create_app`).
"""

from __future__ import annotations

import secrets

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_scheme = HTTPBearer(auto_error=False)


def require_bearer(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_scheme),
) -> None:
    expected = getattr(request.app.state, "bearer_token", "")
    if not expected:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="HTTP surface is not configured with a bearer token.",
        )
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    if not secrets.compare_digest(creds.credentials, expected):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )


def require_setup_token(
    request: Request,
    creds: HTTPAuthorizationCredentials | None = Depends(_scheme),
) -> None:
    """Auth gate for the /setup/* mutating endpoints.

    Accepts either the setup token (bootstrap mode, before config.toml exists)
    or the regular bearer token (lets an admin re-run setup later). Either is
    fine because both already represent full control of the server."""
    setup_token = getattr(request.app.state, "setup_token", "")
    bearer_token = getattr(request.app.state, "bearer_token", "")
    if not setup_token and not bearer_token:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Setup surface requires either DOCKET_SETUP_TOKEN or a configured bearer token.",
        )
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    supplied = creds.credentials
    if setup_token and secrets.compare_digest(supplied, setup_token):
        return
    if bearer_token and secrets.compare_digest(supplied, bearer_token):
        return
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid bearer token.",
        headers={"WWW-Authenticate": "Bearer"},
    )


__all__ = ["require_bearer", "require_setup_token"]
