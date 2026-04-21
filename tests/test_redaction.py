"""Unit tests for the transcript-redaction helper.

Each test uses a synthetic secret (clearly fake, but pattern-matching) so we
can assert the replacement tag is emitted and the original string is gone."""
from __future__ import annotations

import pytest

from docket.core.redaction import redact_secrets


def test_empty_input_passes_through() -> None:
    assert redact_secrets("") == ""


def test_plain_text_is_unchanged() -> None:
    text = "Nothing secret here — just a description about login flows."
    assert redact_secrets(text) == text


def test_aws_access_key_id_redacted() -> None:
    text = "AWS key is AKIAIOSFODNN7EXAMPLE in the config."
    out = redact_secrets(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "[REDACTED:aws-access-key-id]" in out


def test_aws_secret_access_key_assignment_redacted() -> None:
    text = 'aws_secret_access_key = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"'
    out = redact_secrets(text)
    assert "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" not in out
    assert "[REDACTED:aws-secret-access-key]" in out


def test_gcp_api_key_redacted() -> None:
    text = "GOOGLE_API_KEY=AIzaSyA_0000000000000000000000000000000"
    out = redact_secrets(text)
    assert "AIzaSyA_0000000000000000000000000000000" not in out
    assert "[REDACTED:gcp-api-key]" in out


@pytest.mark.parametrize(
    "token",
    [
        "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
        "gho_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
        "ghs_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ",
        "github_pat_" + "A" * 80,
    ],
)
def test_github_token_redacted(token: str) -> None:
    text = f"token: {token}"
    out = redact_secrets(text)
    assert token not in out
    assert "[REDACTED:github-token]" in out


def test_bearer_token_redacted() -> None:
    text = "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature"
    out = redact_secrets(text)
    assert "eyJhbGciOiJIUzI1NiJ9.payload.signature" not in out
    assert "[REDACTED:bearer-token]" in out


def test_password_assignment_redacted() -> None:
    for s in [
        'password="hunter2"',
        "password: sup3r-sekret",
        "PASSWORD=ShouldBeHidden!",
    ]:
        out = redact_secrets(s)
        assert "hunter2" not in out
        assert "sup3r-sekret" not in out
        assert "ShouldBeHidden!" not in out
        assert "[REDACTED:password-assignment]" in out


def test_pem_private_key_block_redacted() -> None:
    text = (
        "Here is my key:\n"
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEAxxxxx\n"
        "yyyyy\n"
        "-----END RSA PRIVATE KEY-----\n"
        "and a trailing comment"
    )
    out = redact_secrets(text)
    assert "MIIEowIBAAKCAQEAxxxxx" not in out
    assert "[REDACTED:pem-private-key]" in out
    # Surrounding text preserved.
    assert "Here is my key:" in out
    assert "trailing comment" in out


def test_redaction_is_idempotent() -> None:
    """Running twice must not re-redact or alter the placeholder."""
    text = "token: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ end"
    once = redact_secrets(text)
    twice = redact_secrets(once)
    assert once == twice


def test_multiple_different_secrets_in_one_string() -> None:
    text = (
        "aws: AKIAIOSFODNN7EXAMPLE\n"
        "github: ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ\n"
        "auth: Bearer eyJhbGciOiJIUzI1NiJ9.aaa.bbb\n"
    )
    out = redact_secrets(text)
    assert "AKIAIOSFODNN7EXAMPLE" not in out
    assert "ghp_abcdefghijklmnopqrstuvwxyzABCDEFGHIJ" not in out
    assert "eyJhbGciOiJIUzI1NiJ9.aaa.bbb" not in out
    # All three tags present.
    assert "[REDACTED:aws-access-key-id]" in out
    assert "[REDACTED:github-token]" in out
    assert "[REDACTED:bearer-token]" in out
