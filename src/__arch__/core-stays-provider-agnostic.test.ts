/**
 * Architecture guard: nothing under `src/core/` may reference concrete
 * provider modules, vendor SDKs, or hardcoded provider-specific tokens.
 *
 * Core is the canonical-types layer — every other module imports from it,
 * so smuggling provider-specific knowledge in here ripples outward and
 * defeats the ports-and-adapters split. Examples this guard catches:
 *
 *   - imports of @/providers/<name>/...
 *   - imports of @octokit/* or LLM vendor SDKs
 *   - hardcoded reaction shortcodes baked into a core/ const — those
 *     belong in the provider that owns them and reach core only via
 *     ProviderCapabilities.supportedReactions.
 *
 * Adding new provider-agnostic types under `src/core/` is fine; this test
 * just keeps the door shut on provider-aware ones.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const CORE_ROOT = join(PROJECT_ROOT, "src", "core");
const SKIP_DIRS = new Set(["node_modules", "generated", "__arch__"]);

const FORBIDDEN_IMPORTS = [
  /from\s+["']@\/providers\//,
  /from\s+["']@\/server\//,
  /from\s+["']@\/agent\//,
  /from\s+["']@octokit\//,
  /from\s+["']openai["']/,
  /from\s+["']@anthropic-ai\//,
  /from\s+["']azure-devops-node-api["']/,
];

// Provider-specific tokens that should never appear as bare string literals
// inside `src/core/`. These are the GitHub reaction shortcodes — the canonical
// example of provider-specific knowledge that doesn't belong in core. If
// another provider's tokens leak in later, add them here.
const FORBIDDEN_TOKEN_LITERALS = [
  '"+1"',
  '"-1"',
  '"hooray"',
  '"laugh"',
  '"confused"',
  '"rocket"',
  '"eyes"',
];

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("arch: core stays provider-agnostic", () => {
  it("no file under src/core/ imports from a server, agent, or provider package", async () => {
    expect((await stat(CORE_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; pattern: string }[] = [];
    for await (const file of walk(CORE_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      const text = await readFile(file, "utf8");
      for (const re of FORBIDDEN_IMPORTS) {
        if (re.test(text)) {
          offenders.push({ file: rel, pattern: re.source });
        }
      }
    }

    expect(
      offenders,
      `Core files reaching outside core:\n  ${offenders.map((o) => `${o.file} → ${o.pattern}`).join("\n  ")}`,
    ).toEqual([]);
  });

  it("no provider-specific reaction shortcodes appear as literals inside src/core/", async () => {
    const offenders: { file: string; token: string }[] = [];
    for await (const file of walk(CORE_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      const text = await readFile(file, "utf8");
      for (const token of FORBIDDEN_TOKEN_LITERALS) {
        if (text.includes(token)) {
          offenders.push({ file: rel, token });
        }
      }
    }

    expect(
      offenders,
      `Provider-specific tokens in core:\n  ${offenders.map((o) => `${o.file} → ${o.token}`).join("\n  ")}`,
    ).toEqual([]);
  });
});
