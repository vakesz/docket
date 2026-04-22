"""Best-effort secret redaction for outbound artifacts.

Runs over conversation transcripts (and anything else we upload) before the
bytes leave the machine. We don't try to be perfect — high-entropy strings in
the wild are noise-heavy and would bury the signal — so we stick to patterns
with recognizable *markers* that identify them as credentials:

  - AWS Access Key IDs and keyed-assignment `aws_secret_access_key = …` lines
  - GCP API keys (`AIza…` format)
  - GitHub personal-access tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`, `github_pat_…`)
  - `Bearer …` Authorization headers
  - `password=…` / `password: …` assignments
  - PEM-wrapped private keys (`-----BEGIN … PRIVATE KEY-----` … `-----END …-----`)

Every hit is replaced with `[REDACTED:<tag>]` so the transcript stays readable
and a reviewer can see which check fired. Ordering matters: the PEM block
pattern runs first because its body would otherwise trigger other regexes.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from re import Pattern

_PLACEHOLDER = "[REDACTED:{tag}]"


@dataclass(frozen=True)
class _Rule:
    tag: str
    pattern: Pattern[str]


_RULES: tuple[_Rule, ...] = (
    _Rule(
        # Multiline so DOTALL-style `.*?` spans the body; non-greedy to keep
        # neighboring blocks separate when several keys are pasted in a row.
        tag="pem-private-key",
        pattern=re.compile(
            r"-----BEGIN (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----"
            r"[\s\S]*?"
            r"-----END (?:RSA |DSA |EC |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----",
        ),
    ),
    _Rule(
        # AWS access-key-id prefixes per the ASIA/AKIA/… family.
        tag="aws-access-key-id",
        pattern=re.compile(r"\b(?:AKIA|ASIA|AIDA|AGPA|AROA|ANPA|ANVA)[A-Z0-9]{16}\b"),
    ),
    _Rule(
        # Only catch secret-key strings when they're adjacent to a labeled
        # assignment — looking for raw 40-char base64 would flag hashes,
        # docker digests, etc.
        tag="aws-secret-access-key",
        pattern=re.compile(
            r"(?i)\baws_secret_access_key\s*[=:]\s*['\"]?[A-Za-z0-9/+=]{40}['\"]?",
        ),
    ),
    _Rule(
        tag="gcp-api-key",
        pattern=re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b"),
    ),
    _Rule(
        # GitHub's public token prefixes, all at least 36 body chars.
        tag="github-token",
        pattern=re.compile(
            r"\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b"
            r"|"
            r"\bgithub_pat_[A-Za-z0-9_]{20,}\b",
        ),
    ),
    _Rule(
        # Case-insensitive so "Authorization: Bearer …" and "authorization:
        # bearer …" both match. Token body stops at whitespace.
        tag="bearer-token",
        pattern=re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-~+/=]{8,}\b"),
    ),
    _Rule(
        # `password=secret`, `password: "secret"`, etc. Stops at the first
        # whitespace or closing quote so we don't eat the rest of the line.
        tag="password-assignment",
        pattern=re.compile(
            r"(?i)\bpassword\s*[=:]\s*['\"]?[^'\"\s]{3,}['\"]?",
        ),
    ),
)


def redact_secrets(text: str) -> str:
    """Return `text` with recognizable credentials replaced.

    Idempotent: running twice produces the same output because the
    `[REDACTED:…]` placeholder doesn't match any of the rule patterns."""
    if not text:
        return text
    out = text
    for rule in _RULES:
        out = rule.pattern.sub(_PLACEHOLDER.format(tag=rule.tag), out)
    return out


__all__ = ["redact_secrets"]
