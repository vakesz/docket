/**
 * Architecture guard: `@octokit/*` may only be imported from
 * `src/providers/github/`.
 *
 * Mirrors the Python tree's `tests/unit/test_import_boundary.py`. The whole
 * point of the provider boundary is that downstream layers (`core/`,
 * `server/`, `agent/`, the UI) speak only to the abstract `WorkItemProvider`
 * — they don't know GitHub exists. If a file outside the GitHub provider
 * package starts importing octokit, this test fails immediately and the
 * fix is to put that code behind a method on the provider interface.
 *
 * Walks the source tree at test time using Node fs; no glob library
 * dependency.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const ALLOWED_PREFIX = join("src", "providers", "github") + sep;

// Skip generated Prisma client (vendored copy of the runtime — not our code).
const SKIP_DIRS = new Set(["node_modules", "generated"]);

const OCTOKIT_IMPORT =
  /from\s+["']@octokit\/[^"']+["']|require\(\s*["']@octokit\/[^"']+["']\s*\)|import\(\s*["']@octokit\/[^"']+["']\s*\)/;

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

describe("arch: octokit boundary", () => {
  it("no file outside src/providers/github/ imports @octokit/*", async () => {
    // Sanity-check the source root exists so we don't pass vacuously when
    // someone moves the tree.
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: string[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (rel.startsWith(ALLOWED_PREFIX)) continue;
      const text = await readFile(file, "utf8");
      if (OCTOKIT_IMPORT.test(text)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `Files outside src/providers/github/ importing @octokit/*: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
