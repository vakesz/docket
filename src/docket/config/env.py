from __future__ import annotations

import os

from dotenv import find_dotenv, load_dotenv

from docket.config.paths import Paths

_project_env_loaded = False


def load_project_env() -> None:
    """Load a project-local `.env` found by walking up from CWD.

    Project-local `.env` wins over the shell — standard convention for
    per-project dev overrides. Without this, a shell that already exports
    XDG_CONFIG_HOME (common on Linux and some macOS setups) would drown
    out the `.docket-dev/` redirect users actually wrote in the repo's `.env`.

    Idempotent: the first call loads `.env`, subsequent calls no-op. This
    lets `resolve_paths()` call it unconditionally so every entry point —
    Typer CLI, uvicorn workers, FastAPI bootstrap, tests, REPL — picks up
    the override without each entry needing its own gate.
    """
    global _project_env_loaded
    if _project_env_loaded:
        return
    path = find_dotenv(usecwd=True)
    if path:
        load_dotenv(path, override=True)
    _project_env_loaded = True


def reset_project_env_cache() -> None:
    """Re-enable `load_project_env()` for the next call. Test-only helper:
    CWD-dependent tests that want to re-evaluate the `.env` lookup can call
    this between cases."""
    global _project_env_loaded
    _project_env_loaded = False


def load_env(paths: Paths) -> None:
    """Load secrets from $XDG_CONFIG_HOME/docket/.env if present.

    Existing process env wins — we do not override. This lets users set secrets
    via their shell or a launcher without editing the .env file.
    """
    if paths.env_file.exists():
        load_dotenv(paths.env_file, override=False)


def get_llm_api_key() -> str | None:
    return os.environ.get("AZURE_OPENAI_API_KEY")


def get_llm_endpoint() -> str | None:
    return os.environ.get("AZURE_OPENAI_ENDPOINT") or None


def get_llm_deployment() -> str | None:
    return os.environ.get("AZURE_OPENAI_DEPLOYMENT") or None


def get_llm_api_version() -> str | None:
    return os.environ.get("AZURE_OPENAI_API_VERSION") or None


# Per-1M-token pricing is user-supplied — no hardcoded fallback, since rates
# vary by deployment (GPT-5 vs mini vs nano vs Pro), region, and enterprise
# contract. When either env var is unset the TUI ledger just omits the price.
def _float_env(key: str) -> float | None:
    raw = os.environ.get(key)
    if raw is None or raw.strip() == "":
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def get_price_input_per_1m() -> float | None:
    return _float_env("DOCKET_PRICE_INPUT_PER_1M")


def get_price_output_per_1m() -> float | None:
    return _float_env("DOCKET_PRICE_OUTPUT_PER_1M")


def get_read_only() -> bool:
    """Global read-only switch. CLI `--read-only` flags OR into this so any
    source (env var, flag, wrapper script) can enable demo-safe mode."""
    raw = os.environ.get("DOCKET_READ_ONLY", "").strip().lower()
    return raw in {"1", "true", "yes", "on"}


def get_setup_token() -> str:
    """Bootstrap-mode bearer token. Required when config.toml is missing so
    `docket serve` can run the HTTP setup wizard."""
    return os.environ.get("DOCKET_SETUP_TOKEN", "").strip()
