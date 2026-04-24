/**
 * Resolve the backend URL and bearer token the frontend should use, mirroring
 * how the Python side (`src/docket/config/paths.py`, `src/docket/config/env.py`)
 * finds them. Goal: `config.toml` is the single source of truth for the token,
 * with `.env` and the process environment acting as overrides.
 *
 * Precedence for the token:
 *   1. `DOCKET_API_TOKEN` in the process env / repo-root `.env`.
 *      Escape hatch for containers, CI, and the pre-setup bootstrap phase
 *      (before `config.toml` exists).
 *   2. `[http] token` in `config.toml` — the post-setup source of truth.
 *   3. "" — same failure mode as before this helper. `server.ts` warns
 *      and still proxies, letting `/api/*` 401 reach the UI.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_API_URL = "http://127.0.0.1:8765";
const HERE = dirname(fileURLToPath(import.meta.url));

export interface BackendConfig {
  apiUrl: string;
  apiToken: string;
}

let cached: BackendConfig | null = null;

export function resolveBackendConfig(): BackendConfig {
  if (cached) return cached;
  const { vars, envDir } = loadProjectEnv();
  const apiUrl = (vars.DOCKET_API_URL ?? "").trim() || DEFAULT_API_URL;
  const fromEnv = (vars.DOCKET_API_TOKEN ?? "").trim();
  const tokenFromConfig = readHttpToken(join(configDir(vars, envDir), "config.toml"));
  cached = { apiUrl, apiToken: fromEnv || tokenFromConfig || "" };
  return cached;
}

interface ProjectEnv {
  vars: Record<string, string>;
  envDir: string | null;
}

/**
 * Walks up from this file looking for `.env`, loading the first match. The
 * process env is the starting point so shell exports stay visible; `.env`
 * values override, matching `load_project_env()`'s `override=True`. We also
 * track the directory that held `.env` so relative `XDG_CONFIG_HOME` values
 * (e.g. `./.docket-dev/config`) resolve against the repo root, not CWD —
 * `cd frontend && bun run dev` would otherwise look in the wrong place.
 */
function loadProjectEnv(): ProjectEnv {
  const vars: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") vars[k] = v;
  }
  let envDir: string | null = null;
  let dir = HERE;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".env");
    if (existsSync(candidate)) {
      envDir = dir;
      applyDotenv(candidate, vars);
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { vars, envDir };
}

function applyDotenv(path: string, env: Record<string, string>): void {
  const content = safeRead(path);
  if (content === null) return;
  for (const raw of content.split("\n")) {
    const line = stripInlineComment(raw).trim();
    if (!line) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    value = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => env[name] ?? "");
    env[key] = value;
  }
}

function stripInlineComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) return line.slice(0, i);
  }
  return line;
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Mirrors `resolve_paths().config_dir` in `src/docket/config/paths.py`:
 * `XDG_CONFIG_HOME` wins on every platform when set; otherwise use the
 * platformdirs default for `PlatformDirs(appname="docket", appauthor=False,
 * roaming=False)`.
 */
function configDir(vars: Record<string, string>, envDir: string | null): string {
  const override = vars.XDG_CONFIG_HOME?.trim();
  if (override) {
    const expanded = expandUser(override);
    const base = envDir ?? process.cwd();
    const absolute = isAbsolute(expanded) ? expanded : resolve(base, expanded);
    return join(absolute, "docket");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "docket");
  }
  if (process.platform === "win32") {
    const base = vars.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
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
