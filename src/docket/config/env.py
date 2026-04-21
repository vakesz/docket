from __future__ import annotations

import os

from dotenv import find_dotenv, load_dotenv

from docket.config.paths import Paths


def load_project_env() -> None:
    """Load a project-local `.env` found by walking up from CWD.

    Project-local `.env` wins over the shell — standard convention for
    per-project dev overrides. Without this, a shell that already exports
    XDG_CONFIG_HOME (common on Linux and some macOS setups) would drown
    out the `.docket-dev/` redirect users actually wrote in the repo's `.env`.
    """
    path = find_dotenv(usecwd=True)
    if path:
        load_dotenv(path, override=True)


def load_env(paths: Paths) -> None:
    """Load secrets from $XDG_CONFIG_HOME/docket/.env if present.

    Existing process env wins — we do not override. This lets users set secrets
    via their shell or a launcher without editing the .env file.
    """
    if paths.env_file.exists():
        load_dotenv(paths.env_file, override=False)


def get_foundry_api_key() -> str | None:
    return os.environ.get("AZURE_OPENAI_API_KEY")


def get_foundry_endpoint() -> str | None:
    return os.environ.get("AZURE_OPENAI_ENDPOINT") or None


def get_foundry_deployment() -> str | None:
    return os.environ.get("AZURE_OPENAI_DEPLOYMENT") or None


def get_foundry_api_version() -> str | None:
    return os.environ.get("AZURE_OPENAI_API_VERSION") or None
