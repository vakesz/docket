/**
 * Architecture guard: whole-query raw SQL is forbidden.
 *
 * Style-guide rule 10 (sharpened): `db.execute(sql\`...\`)` /
 * `tx.execute(sql\`...\`)` is the dangerous pattern — it routes around
 * Drizzle's typed query builder entirely and writes a whole query in
 * a string. We forbid that everywhere outside `src/db/` and tests.
 *
 * Embedded `sql\`...\`` fragments — for atomic counter increments
 * (`col + n`), Postgres-only operators (`array_length`, `UNNEST`,
 * `<> ALL`), and partial-index `targetWhere` — stay legal. The typed
 * builder can't express these and we'd just push the same SQL into a
 * helper if we tried.
 *
 * The few files that legitimately use `db.execute(sql\`...\`)` for
 * Postgres-only projections (UNNEST distinct, etc.) are explicitly
 * allowlisted below with a one-line reason. Adding to this list
 * forces a code-review touch — the goal is friction, not zero usage.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "__arch__"]);

const ALLOWED_PREFIXES = ["src/db/"];
// Explicit allowlist for the rare whole-query case. Each entry must
// document *why* the typed builder can't express the query.
const ALLOWLIST_FILES = new Set<string>([
  // UNNEST(array) projection — Postgres-specific; no native helper.
  "src/server/items/router.ts",
]);

const isAllowed = (rel: string) =>
  ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) || ALLOWLIST_FILES.has(rel);
const isTestFile = (rel: string) => /\.test\.[cm]?[tj]sx?$/.test(rel);

// Match the dangerous pattern only: `<x>.execute(sql\`...\`)`. Embedded
// `sql\`...\`` fragments inside `.set(...)`, `where: ...`, etc. are
// allowed.
const RAW_QUERY = /\.execute\s*\(\s*sql`/;

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

describe("arch: whole-query raw SQL is forbidden outside the data layer", () => {
  it("no `db.execute(sql\\`...\\`)` outside src/db/ or the explicit allowlist", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);
    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
      if (isAllowed(rel) || isTestFile(rel)) continue;
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (RAW_QUERY.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(
      offenders,
      `Whole-query raw SQL is forbidden — use the typed query builder, or add the file to ALLOWLIST_FILES with a justification:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
