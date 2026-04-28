/**
 * Architecture guard: NextAuth provider helpers are quarantined to the
 * auth-build dispatch and each provider's own package.
 *
 * The OAuth-agnostic story is symmetric to the LLM-agnostic one: nothing
 * outside `src/server/providers/auth-build.ts` (the dispatch hub) and
 * `src/providers/<kind>/**` (each provider's own module) should reach for
 * a concrete `next-auth/providers/<name>` import. If a router or page
 * starts pulling in `next-auth/providers/github` directly, adding the
 * next OAuth provider becomes a multi-file refactor instead of one
 * sibling case in `buildAuthProvider`.
 *
 * Type-only umbrella imports (`from "next-auth/providers"` with no
 * trailing path segment) are intentionally allowed — they only carry
 * shared type aliases like `Provider` / `OIDCConfig`, no vendor coupling.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "generated"]);

// Match concrete subpath imports like `next-auth/providers/github` but not
// the bare umbrella `next-auth/providers` (which only re-exports types).
const CONCRETE_PROVIDER_IMPORT =
  /(?:from|import|require)\s*\(?\s*["']next-auth\/providers\/[^"']+["']/;

const ALLOWED_FILE = join("src", "server", "providers", "auth-build.ts");
const ALLOWED_DIR_PREFIX = join("src", "providers") + sep;

function isAllowed(rel: string): boolean {
  return rel === ALLOWED_FILE || rel.startsWith(ALLOWED_DIR_PREFIX);
}

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

describe("arch: NextAuth provider boundary", () => {
  it("no file outside the auth-build dispatch or a provider package imports a concrete next-auth/providers/* helper", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: string[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (isAllowed(rel)) continue;
      const text = await readFile(file, "utf8");
      if (CONCRETE_PROVIDER_IMPORT.test(text)) {
        offenders.push(rel);
      }
    }

    expect(
      offenders,
      `Files importing a concrete next-auth/providers/* helper from outside auth-build.ts or src/providers/**:\n  ${offenders.join("\n  ")}`,
    ).toEqual([]);
  });
});
