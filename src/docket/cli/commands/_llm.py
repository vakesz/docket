from __future__ import annotations

from typing import TYPE_CHECKING

from docket._console import console
from docket.config.secrets import get_llm_api_key

if TYPE_CHECKING:
    from docket.agent.llm_client import AzureOpenAIClient
    from docket.config.models import LlmConfig


def build_llm_client(llm_cfg: LlmConfig) -> AzureOpenAIClient | None:
    """Build the LLM client.

    The API key comes from the OS keyring; everything else comes from
    `config.toml`'s `[llm]` block. If either the key or the endpoint is
    missing, chat is disabled and the user is pointed at the setup wizard."""
    api_key = get_llm_api_key()
    endpoint = str(llm_cfg.endpoint) if llm_cfg.endpoint else None
    deployment = llm_cfg.deployment
    if not api_key or not endpoint:
        missing = []
        if not api_key:
            missing.append("API key (run `docket setup --step=llm`)")
        if not endpoint:
            missing.append("[llm].endpoint in config.toml")
        console.print(
            f"[yellow]Chat disabled[/yellow]: missing {', '.join(missing)}. "
            "Run `docket setup` to configure."
        )
        return None
    from docket.agent.llm_client import AzureOpenAIClient

    return AzureOpenAIClient(
        endpoint=endpoint,
        api_key=api_key,
        deployment=deployment,
        api_version=None,
    )
