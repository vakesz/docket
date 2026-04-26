"""Static bearer-token auth for the HTTP surface.

The server carries a single configured token (or, in bootstrap mode, also a
setup token). Tokens are compared with `secrets.compare_digest` so the
correct token doesn't leak through timing. A non-empty bearer token is
mandatory in live mode — `app.create_app` refuses to bind without one,
which is why the gate doesn't separately raise 503 for an empty bearer.
"""

from __future__ import annotations

import secrets
from collections.abc import Callable

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

_scheme = HTTPBearer(auto_error=False)


def _extract_bearer(creds: HTTPAuthorizationCredentials | None) -> str:
    """Validate shape of the `Authorization: Bearer …` header.

    Returns the token string on success; raises HTTP 401 with the
    WWW-Authenticate challenge when the header is missing, non-bearer,
    or empty."""
    if creds is None or creds.scheme.lower() != "bearer" or not creds.credentials:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return creds.credentials


def _make_token_gate(
    *attrs: str, missing_detail: str | None = None
) -> Callable[[Request, HTTPAuthorizationCredentials | None], None]:
    """Build a FastAPI dependency that accepts any of the named app.state tokens.

    `missing_detail` set means "raise 503 when none of the named tokens are
    configured" — used by the setup gate where bootstrap mode may genuinely
    have no tokens. Leave it None when an empty token implies misconfiguration
    that `create_app` already rejected (the gate will simply 401 instead)."""

    def gate(
        request: Request,
        creds: HTTPAuthorizationCredentials | None = Depends(_scheme),
    ) -> None:
        candidates = [t for t in (getattr(request.app.state, a, "") for a in attrs) if t]
        if not candidates and missing_detail is not None:
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail=missing_detail,
            )
        supplied = _extract_bearer(creds)
        for expected in candidates:
            if secrets.compare_digest(supplied, expected):
                return
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid bearer token.",
            headers={"WWW-Authenticate": "Bearer"},
        )

    return gate


require_bearer = _make_token_gate("bearer_token")
require_setup_token = _make_token_gate(
    "setup_token",
    "bearer_token",
    missing_detail="Setup surface requires a bootstrap bearer token from config.toml.",
)


__all__ = ["require_bearer", "require_setup_token"]
