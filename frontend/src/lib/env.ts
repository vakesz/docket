/**
 * Server-side env access. Never import from a browser component — these values
 * carry the bearer token and must stay on the Bun/Node side.
 */

const _getEnv = (key: string, fallback?: string): string => {
  const v = (typeof process !== "undefined" && process.env[key]) || undefined;
  if (v !== undefined && v !== "") return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`Missing required env var: ${key}`);
};

export const serverEnv = {
  apiUrl: () => _getEnv("DOCKET_API_URL", "http://127.0.0.1:8765").replace(/\/$/, ""),
  apiToken: () => _getEnv("DOCKET_API_TOKEN"),
};
