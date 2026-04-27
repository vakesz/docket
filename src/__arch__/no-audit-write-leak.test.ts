/**
 * Architecture guard: `Audit` rows may only be written from
 * `src/server/proposals/executor.ts`.
 *
 * The Audit log is the trail the project owner reads to answer "who did
 * what when." Sprinkling `audit.create(...)` calls across routers / tools
 * / UI breaks two properties:
 *
 *   1. *Coverage* — every confirmed-or-rejected mutation should land
 *      exactly one audit row. If callers write their own, some forget;
 *      others double-write.
 *   2. *Trust* — the trail is only as honest as the narrowest write
 *      surface. A central writer in `executor.ts` is auditable on review;
 *      a hundred call sites aren't.
 *
 * If you genuinely need to record a non-proposal action (e.g. project
 * archival), extend `recordAudit` in `executor.ts` and call the helper —
 * don't add a new write site.
 *
 * Allowed callers of `db.audit.create(` / `prisma.audit.create(` /
 * `ctx.db.audit.create(`:
 *   - `src/server/proposals/executor.ts`
 *   - this test itself
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const ALLOWED_FILE = join("src", "server", "proposals", "executor.ts");
const SKIP_DIRS = new Set(["node_modules", "generated", "__arch__"]);

const AUDIT_WRITE = /\baudit\.(create|createMany|update|updateMany|delete|deleteMany|upsert)\s*\(/;

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

describe("arch: audit write boundary", () => {
  it("no file outside the executor writes Audit rows", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (rel === ALLOWED_FILE) continue;

      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (AUDIT_WRITE.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    expect(
      offenders,
      `Forbidden Audit write outside src/server/proposals/executor.ts:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
