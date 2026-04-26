/**
 * Architecture guard: server routers must not import concrete provider
 * implementations directly.
 *
 * Routers (and anything else that wants a provider) MUST go through the
 * registry indirection (`getProviderSpec`) plus `buildProviderForUser`. If a
 * router starts importing `@/providers/github/...` directly, the registry
 * stops being load-bearing and adding a new provider becomes a multi-file
 * grep-and-edit. That's the same failure mode the Python tree's
 * `tests/unit/test_import_boundary.py` guards against.
 *
 * Allowed importers of `src/providers/<x>/` modules:
 *   - sibling files inside the same `src/providers/<x>/` package
 *   - `src/server/provider-registry.ts` (the registry itself)
 *   - the provider's own arch tests under `src/__arch__/`
 *
 * Anything under `src/server/routers/` or `src/server/<feature>/router.ts`
 * importing a provider package directly is a violation.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const SERVER_ROOT = join("src", "server") + sep;
const PROVIDER_REGISTRY = join("src", "server", "provider-registry.ts");
const PROVIDER_BUILD = join("src", "server", "providers", "build.ts");
const SKIP_DIRS = new Set(["node_modules", "generated", "__arch__"]);

const PROVIDER_IMPORT =
  /from\s+["']@\/providers\/([^"'/]+)(?:\/[^"']*)?["']|require\(\s*["']@\/providers\/([^"'/]+)(?:\/[^"']*)?["']\s*\)/g;

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

describe("arch: server provider-import boundary", () => {
  it("no file under src/server/ (other than the registry / builder) imports a concrete provider package", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; pkg: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (!rel.startsWith(SERVER_ROOT)) continue;
      if (rel === PROVIDER_REGISTRY || rel === PROVIDER_BUILD) continue;

      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(PROVIDER_IMPORT)) {
        const pkg = match[1] ?? match[2];
        if (!pkg) continue;
        offenders.push({ file: rel, pkg });
      }
    }

    expect(
      offenders,
      `Server files importing a concrete provider package directly:\n  ${offenders
        .map((o) => `${o.file} → @/providers/${o.pkg}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
