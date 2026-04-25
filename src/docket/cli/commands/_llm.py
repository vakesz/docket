from __future__ import annotations

from typing import TYPE_CHECKING

from docket._console import console
from docket.config.env import (
    get_llm_api_key,
    get_llm_api_version,
    get_llm_deployment,
    get_llm_endpoint,
)

if TYPE_CHECKING:
    from docket.agent.llm_client import AzureOpenAIClient
    from docket.config.models import LlmConfig


def build_llm_client(llm_cfg: LlmConfig) -> AzureOpenAIClient | None:
    """Build the LLM client. `.env` wins over config.toml so users can keep all
    LLM settings in one place alongside the API key."""
    api_key = get_llm_api_key()
    endpoint = get_llm_endpoint() or (str(llm_cfg.endpoint) if llm_cfg.endpoint else None)
    deployment = get_llm_deployment() or llm_cfg.deployment
    api_version = get_llm_api_version()
    if not api_key or not endpoint:
        missing = [
            label
            for label, value in (
                ("AZURE_OPENAI_API_KEY", api_key),
                ("AZURE_OPENAI_ENDPOINT", endpoint),
            )
            if not value
        ]
        console.print(
            f"[yellow]Chat disabled[/yellow]: set {', '.join(missing)} in "
            "your .env (repo-local or ~/.config/docket/.env), or run `docket setup` "
            "to persist the endpoint into config.toml."
        )
        return None
    from docket.agent.llm_client import AzureOpenAIClient

    return AzureOpenAIClient(
        endpoint=endpoint,
        api_key=api_key,
        deployment=deployment,
        api_version=api_version,
    )
