"""Known-good MCP server presets.

Hand-editing the stdio command / args / env for well-known MCP servers is
error-prone and defeats the point of "run `docket setup`, be done". A preset
is a named, frozen recipe: transport + command + args + env-var placeholders
that the user fills in. Surfaces (CLI, HTTP) resolve the preset into a real
`MCPServerEntry` by overlaying caller-supplied env values.

To add a new preset, append a new `MCPPreset` to `_PRESETS`. The schema is
intentionally shallow — anything that needs conditional logic belongs in a
custom `add` command, not here.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from docket.config.models import MCPServerEntry


@dataclass(frozen=True)
class MCPPresetEnvVar:
    """One environment variable the preset needs the user to supply.

    `required` controls whether the surface should refuse to apply the preset
    when the value is missing. `placeholder` shows what the value looks like
    (never a real token) and is used for form hints."""

    name: str
    description: str
    required: bool = True
    placeholder: str = ""


@dataclass(frozen=True)
class MCPPreset:
    """Named recipe for an MCP server entry.

    `default_name` is the suggested key under `projects.<id>.mcp.<default_name>`.
    Surfaces let the user override it if they want to run two instances side by
    side (rare — mostly useful when testing upgrades)."""

    id: str
    label: str
    description: str
    default_name: str
    command: str
    args: list[str] = field(default_factory=list)
    env: list[MCPPresetEnvVar] = field(default_factory=list)
    docs_url: str = ""
    transport: str = "stdio"
    startup_timeout_seconds: float = 15.0


_PRESETS: tuple[MCPPreset, ...] = (
    MCPPreset(
        id="github",
        label="GitHub",
        description=(
            "Official GitHub MCP server. Exposes issues, pull requests, code "
            "search, and repo metadata as agent tools."
        ),
        default_name="github",
        command="npx",
        args=["-y", "@modelcontextprotocol/server-github"],
        env=[
            MCPPresetEnvVar(
                name="GITHUB_PERSONAL_ACCESS_TOKEN",
                description=(
                    "Classic or fine-grained GitHub PAT with `repo` + `read:org` "
                    "scopes. Create one at github.com/settings/tokens."
                ),
                placeholder="ghp_xxx",
            )
        ],
        docs_url="https://github.com/modelcontextprotocol/servers/tree/main/src/github",
        startup_timeout_seconds=20.0,
    ),
)


class UnknownPresetError(KeyError):
    """Raised when the caller asks for a preset id that isn't registered."""


class MissingPresetEnvError(ValueError):
    """Raised when the caller applies a preset without a required env value."""


def list_presets() -> list[MCPPreset]:
    """Return all registered presets in catalog order."""
    return list(_PRESETS)


def get_preset(preset_id: str) -> MCPPreset:
    """Look up one preset by id. Raises `UnknownPresetError` on miss."""
    for preset in _PRESETS:
        if preset.id == preset_id:
            return preset
    raise UnknownPresetError(preset_id)


def apply_preset(
    preset_id: str,
    *,
    env: dict[str, str] | None = None,
    enabled: bool = True,
) -> MCPServerEntry:
    """Resolve a preset into a ready-to-save `MCPServerEntry`.

    `env` supplies values for the preset's declared env vars plus any extras
    the user wants. Missing values for `required=True` vars raise
    `MissingPresetEnvError` — the caller should surface a clear prompt rather
    than saving a half-configured server."""
    preset = get_preset(preset_id)
    supplied = dict(env or {})
    merged: dict[str, str] = {}
    missing: list[str] = []
    for var in preset.env:
        value = supplied.pop(var.name, "")
        if value:
            merged[var.name] = value
        elif var.required:
            missing.append(var.name)
    if missing:
        raise MissingPresetEnvError(
            f"Preset '{preset_id}' requires env value(s): {', '.join(missing)}"
        )
    # Anything left in `supplied` is a user-supplied extra — keep it.
    merged.update(supplied)
    return MCPServerEntry(
        transport=preset.transport,
        command=preset.command,
        args=list(preset.args),
        env=merged,
        enabled=enabled,
        startup_timeout_seconds=preset.startup_timeout_seconds,
    )


__all__ = [
    "MCPPreset",
    "MCPPresetEnvVar",
    "MissingPresetEnvError",
    "UnknownPresetError",
    "apply_preset",
    "get_preset",
    "list_presets",
]
