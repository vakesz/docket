import { createFileRoute, Navigate } from "@tanstack/react-router";

// Prompts now live as a section inside /settings.
export const Route = createFileRoute("/prompts")({
  component: () => <Navigate to="/settings" replace />,
});
