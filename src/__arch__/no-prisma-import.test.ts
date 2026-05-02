/**
 * Architecture guard: nothing in the codebase imports Prisma artifacts.
 *
 * Permanent guard against accidental re-introduction after the
 * Prisma → Drizzle migration. We forbid every Prisma touchpoint:
 *
 *   - `prisma` (root package)
 *   - `@prisma/*` (engine, adapter, client subpath)
 *   - `@auth/prisma-adapter` (NextAuth adapter)
 *   - `@/db/generated/*` (the generated client output dir, deleted)
 *
 * If any of these reappear, we want CI to bounce the change before it
 * ships — Drizzle is the only ORM, and the generated/ directory is
 * gone for good.
 */

import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const ROOTS = [join(PROJECT_ROOT, "src"), join(PROJECT_ROOT, "bin")];
const SKIP_DIRS = new Set(["node_modules", "__arch__"]);

const FORBIDDEN_PATTERNS = [
  // Match `from "..."` imports, not the test's own description strings.
  /from\s+["']prisma["']/,
  /from\s+["']@prisma\//,
  /from\s+["']@auth\/prisma-adapter["']/,
  /from\s+["']@\/db\/generated\//,
];

async function* walk(dir: string): AsyncGenerator<string> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
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

describe("arch: no Prisma imports anywhere", () => {
  it("rejects prisma, @prisma/*, @auth/prisma-adapter, @/db/generated/*", async () => {
    for (const root of ROOTS) {
      try {
        expect((await stat(root)).isDirectory()).toBe(true);
      } catch {
        // bin/ may legitimately not exist in some checkouts; src/ must.
        if (root.endsWith("src")) throw new Error(`missing root ${root}`);
      }
    }

    const offenders: { file: string; line: number; text: string }[] = [];
    for (const root of ROOTS) {
      for await (const file of walk(root)) {
        const rel = relative(PROJECT_ROOT, file);
        const text = await readFile(file, "utf8");
        const lines = text.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          for (const pattern of FORBIDDEN_PATTERNS) {
            if (pattern.test(line)) {
              offenders.push({ file: rel, line: i + 1, text: line.trim() });
              break;
            }
          }
        }
      }
    }

    expect(
      offenders,
      `Prisma re-introduced — every reference to Prisma must be replaced with Drizzle:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
