/**
 * Architecture guard: provider write methods may only be called from
 * `src/server/proposals/executor.ts` and the provider implementation files
 * themselves.
 *
 * Nothing outside the proposal executor may touch `provider.transition` /
 * `patchDescription` / `uploadAttachment` / `addComment` / `createItem` /
 * `setTags` / `addReaction` / `removeReaction`.
 * That keeps the proposal-first mutation invariant load-bearing — every
 * provider write is preceded by a Proposal row, a diff render, and a
 * confirm step.
 *
 * Allowed callers of `.transition(`, `.patchDescription(`, `.uploadAttachment(`,
 * `.addComment(`, `.createItem(`, `.setTags(`, `.addReaction(`, `.removeReaction(`:
 *   - `src/server/proposals/executor.ts` (the executor — the ONE place these
 *     fire as side effects)
 *   - sibling files inside `src/providers/<x>/` (provider implementations
 *     calling each other's helpers)
 *   - this test itself
 *
 * Anything else — UI, routers, builders, agent tools — is a violation.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const ALLOWED_FILE = join("src", "server", "proposals", "executor.ts");
const ALLOWED_PROVIDERS_PREFIX = join("src", "providers") + sep;
const SKIP_DIRS = new Set(["node_modules", "generated", "__arch__"]);

// Match `.<method>(` — fenceposted by `.` so we don't catch unrelated calls
// like `transitionEvent(` or in comments. Comments are tolerated because
// they don't actually invoke anything; the regex requires `.` to keep the
// match tight.
const WRITE_METHODS = [
  "transition",
  "patchDescription",
  "uploadAttachment",
  "addComment",
  "createItem",
  "setTags",
  "addReaction",
  "removeReaction",
] as const;

const WRITE_CALL = new RegExp(`\\.(${WRITE_METHODS.join("|")})\\s*\\(`);

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

describe("arch: provider write-method boundary", () => {
  it("no file outside the executor or src/providers/* calls a provider write method", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; line: number; method: string; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (rel === ALLOWED_FILE) continue;
      if (rel.startsWith(ALLOWED_PROVIDERS_PREFIX)) continue;

      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        const match = line.match(WRITE_CALL);
        if (match) {
          offenders.push({ file: rel, line: i + 1, method: match[1] ?? "", text: line.trim() });
        }
      }
    }

    expect(
      offenders,
      `Forbidden provider write-method calls (only allowed in src/server/proposals/executor.ts and src/providers/**):\n  ${offenders
        .map((o) => `${o.file}:${o.line} (${o.method}) ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
