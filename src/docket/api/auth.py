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


__all__ = ["require_bearer"]
