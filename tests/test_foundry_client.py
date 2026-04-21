from __future__ import annotations

import pytest

from docket.agent.foundry_client import _parse_azure_endpoint


def test_parse_full_deployment_url_extracts_base_deployment_and_api_version() -> None:
    base, deployment, api_version = _parse_azure_endpoint(
        "https://sth-ai-resource.cognitiveservices.azure.com/openai/deployments/"
        "gpt-5/chat/completions?api-version=2025-01-01-preview"
    )
    assert base == "https://sth-ai-resource.cognitiveservices.azure.com"
    assert deployment == "gpt-5"
    assert api_version == "2025-01-01-preview"


def test_parse_bare_resource_url() -> None:
    base, deployment, api_version = _parse_azure_endpoint(
        "https://sth-ai-resource.cognitiveservices.azure.com/"
    )
    assert base == "https://sth-ai-resource.cognitiveservices.azure.com"
    assert deployment is None
    assert api_version is None


def test_parse_rejects_non_url() -> None:
    with pytest.raises(ValueError, match="AZURE_OPENAI_ENDPOINT"):
        _parse_azure_endpoint("not-a-url")
