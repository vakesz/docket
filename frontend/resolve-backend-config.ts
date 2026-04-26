/**
 * Resolve the backend URL and bearer token the frontend should use.
 *
 * `config.toml` (in `XDG_CONFIG_HOME/docket/` or the platform default) is the
 * single source of truth for the bearer token; the dev process can override
 * via `DOCKET_API_URL` / `DOCKET_API_TOKEN` for CI and pre-setup phases. We do
 * NOT walk parent directories for a `.env` — the backend dropped `.env`
 * support, so the frontend follows.
 *
 * Precedence for the token:
 *   1. `DOCKET_API_TOKEN` in the process env. Escape hatch for containers,
 *      CI, and the pre-setup bootstrap phase (before `config.toml` exists).
 *   2. `[http] token` in `config.toml`.
 *   3. "" — same failure mode as before this helper. `server.ts` warns
 *      and still proxies, letting `/api/*` 401 reach the UI.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const DEFAULT_API_URL = "http://127.0.0.1:8765";

export interface BackendConfig {
  apiUrl: string;
  apiToken: string;
}

let cached: BackendConfig | null = null;

export function resolveBackendConfig(): BackendConfig {
  if (cached) return cached;
  const apiUrl = (process.env.DOCKET_API_URL ?? "").trim() || DEFAULT_API_URL;
  const fromEnv = (process.env.DOCKET_API_TOKEN ?? "").trim();
  const tokenFromConfig = readHttpToken(join(configDir(), "config.toml"));
  cached = { apiUrl, apiToken: fromEnv || tokenFromConfig || "" };
  return cached;
}

function safeRead(path: string): string | null {
  try {
    if (!existsSync(path)) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Mirrors `resolve_paths().config_dir` in `src/docket/config/paths.py`:
 * `XDG_CONFIG_HOME` wins on every platform when set; otherwise use the
 * platformdirs default for `PlatformDirs(appname="docket", appauthor=False,
 * roaming=False)`. Relative `XDG_CONFIG_HOME` values resolve against the
 * current working directory at vite startup, matching how the backend's
 * `--workspace` flag is invoked from the repo root.
 */
function configDir(): string {
  const override = process.env.XDG_CONFIG_HOME?.trim();
  if (override) {
    const expanded = expandUser(override);
    const absolute = isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
    return join(absolute, "docket");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "docket");
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "docket");
  }
  return join(homedir(), ".config", "docket");
}

function expandUser(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

/**
 * Line-based extraction of `[http] token = "..."`. Pulling a TOML library
 * for one string key would be overkill — tomli-w on the Python side writes
 * tokens as plain double-quoted strings (see `save_config` in loader.py),
 * and `secrets.token_urlsafe` never produces characters that need escaping.
 */
function readHttpToken(configPath: string): string | null {
  const content = safeRead(configPath);
  if (content === null) return null;
  let inHttp = false;
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inHttp = line === "[http]";
      continue;
    }
    if (!inHttp) continue;
    const match = line.match(/^token\s*=\s*"([^"\\]*)"\s*$/);
    if (match?.[1]) return match[1];
  }
  return null;
}
