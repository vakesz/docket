"""Real GitHub Issues + Pull Requests provider.

Auth rides on the user's `gh` CLI session: `gh auth token` mints a short-
lived token, the provider wraps `api.github.com`. The stub lives at
`providers.github_stub` and is still useful for offline demos and
cross-provider integration tests.
"""

from docket.providers.github.provider import GitHubProvider

__all__ = ["GitHubProvider"]
