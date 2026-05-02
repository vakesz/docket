/**
 * Architecture guard: canonical db / schema import paths.
 *
 * Style-guide rules 1–3 from the migration plan:
 *
 *   1. Client: `import { db } from "@/db"`. Never `from "@/server/db"`,
 *      never directly from `@/db/client`.
 *   2. Tables: `import { projects, items, ... } from "@/db/schema"`.
 *      Never from `@/db/schema/<file>` directly — the barrel is the
 *      single re-export surface so a schema file rename never ripples
 *      into a hundred consumer files.
 *   3. Row types: `import type { Project, Item } from "@/db/schema/types"`.
 *
 * Files inside `src/db/**` themselves are exempt — they wire the barrel
 * and may import sibling files directly. Test files are also exempt
 * (they sometimes need to grab a sub-module to test it in isolation).
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "__arch__"]);

// Files inside `src/db/` may freely cross-reference each other.
const isInsideDb = (rel: string) => rel.split(/[\\/]/).slice(0, 2).join("/") === "src/db";
const isTestFile = (rel: string) => /\.test\.[cm]?[tj]sx?$/.test(rel);

const BAD_CLIENT = /from\s+["']@\/server\/db["']/;
const BAD_CLIENT_DIRECT = /from\s+["']@\/db\/client["']/;
// Allow `@/db/schema` and `@/db/schema/types`; reject any *other* sub-path.
const BAD_SCHEMA_SUBPATH = /from\s+["']@\/db\/schema\/(?!types["'])/;

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

describe("arch: canonical db/schema import paths", () => {
  it("nobody imports the db client from a non-canonical path", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);
    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
      if (isInsideDb(rel) || isTestFile(rel)) continue;
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (BAD_CLIENT.test(line) || BAD_CLIENT_DIRECT.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(
      offenders,
      `Canonical client import is \`@/db\`. These files use a non-canonical path:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });

  it("nobody imports a schema sub-module — the barrel is the only surface", async () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file).replaceAll("\\", "/");
      if (isInsideDb(rel) || isTestFile(rel)) continue;
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (BAD_SCHEMA_SUBPATH.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    expect(
      offenders,
      `Schema imports must come from \`@/db/schema\` (or \`@/db/schema/types\`). Offenders:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
