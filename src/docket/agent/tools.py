"""Tool registry.

Tools are Python callables the model can invoke. Each tool declares:
  - a name (what the model sees)
  - a description (what the model reads to decide when to call it)
  - a JSON Schema for its arguments

Handlers return a string that becomes the tool-message content. Handlers
must be side-effect free for read-only tools; mutations go through
`mutation_service.propose` and come back in M5.
"""
from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from docket.agent.types import ToolSchema


ToolHandler = Callable[[dict[str, Any]], str]


@dataclass
class Tool:
    schema: ToolSchema
    handler: ToolHandler


class ToolRegistry:
    """Ordered registry of tools.

    Order matters for cache stability — the tools list is part of the
    prompt prefix, so adding/removing tools invalidates Foundry's cache
    for every ticket. Treat the registry as append-only in hot paths.
    """

    def __init__(self) -> None:
        self._tools: dict[str, Tool] = {}

    def register(
        self,
        name: str,
        description: str,
        parameters: dict[str, Any],
        handler: ToolHandler,
    ) -> None:
        if name in self._tools:
            raise ValueError(f"tool '{name}' already registered")
        self._tools[name] = Tool(
            schema=ToolSchema(name=name, description=description, parameters=parameters),
            handler=handler,
        )

    def schemas(self) -> list[ToolSchema]:
        return [t.schema for t in self._tools.values()]

    def dispatch(self, name: str, arguments: dict[str, Any]) -> str:
        tool = self._tools.get(name)
        if tool is None:
            return json.dumps({"error": f"unknown tool '{name}'"})
        try:
            return tool.handler(arguments)
        except Exception as e:  # tool failure → structured error the model can see
            return json.dumps({"error": str(e), "tool": name})

    def __len__(self) -> int:
        return len(self._tools)

    def __contains__(self, name: object) -> bool:
        return name in self._tools
