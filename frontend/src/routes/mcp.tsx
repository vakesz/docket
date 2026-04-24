import { createFileRoute, Navigate } from "@tanstack/react-router";

// MCP now lives as a section inside /settings.
export const Route = createFileRoute("/mcp")({
  component: () => <Navigate to="/settings" replace />,
});
