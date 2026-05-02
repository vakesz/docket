/**
 * Architecture guard: `Audit` rows may only be written from a small,
 * explicit set of modules.
 *
 * The Audit log is the trail the project owner reads to answer "who did
 * what when." Sprinkling `audit.create(...)` calls across routers / tools
 * / UI breaks two properties:
 *
 *   1. *Coverage* — every confirmed-or-rejected mutation should land
 *      exactly one audit row. If callers write their own, some forget;
 *      others double-write.
 *   2. *Trust* — the trail is only as honest as the narrowest write
 *      surface. A central writer module is auditable on review; a
 *      hundred call sites aren't.
 *
 * `proposals/executor.ts` covers proposal-driven writes. Non-proposal
 * audit-worthy events (e.g. an MCP OAuth connection completing) flow
 * through `server/audit/log.ts`, which exports purpose-built helpers
 * for each event kind. To add a new audit event, extend that module —
 * don't add a new write site.
 *
 * Allowed callers of `db.insert(audits)` / `tx.insert(audits)`:
 *   - `src/server/proposals/executor.ts`
 *   - `src/server/audit/log.ts`
 *   - this test itself
 *
 * The append-only invariant is also defended here: only the same
 * allowlisted files may `update(audits)` or `delete(audits)`. The
 * single legitimate caller is `pruneAuditOlderThan` inside the
 * executor — a retention-policy sweep driven by an operator setting.
 * No other site is allowed to mutate the trail.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const ALLOWED_FILES = new Set([
  join("src", "server", "proposals", "executor.ts"),
  join("src", "server", "audit", "log.ts"),
]);
const SKIP_DIRS = new Set(["node_modules", "generated", "__arch__"]);

// Drizzle equivalents: `db.insert(audits)`, `tx.insert(audits)`,
// `ctx.db.insert(audits)`, etc. Match any insert against the `audits` table.
const AUDIT_INSERT = /\binsert\s*\(\s*audits\s*[),]/;
// Append-only: nobody updates or deletes. These are forbidden everywhere,
// including the otherwise-allowed files above.
const AUDIT_MUTATE = /\b(update|delete)\s*\(\s*audits\s*[),]/;

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
  it("no file outside the allowlist inserts Audit rows", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (ALLOWED_FILES.has(rel)) continue;

      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (AUDIT_INSERT.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }

    const allowed = [...ALLOWED_FILES].join(", ");
    expect(
      offenders,
      `Forbidden Audit insert outside { ${allowed} }:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });

  it("only allowlisted files update or delete Audit rows", async () => {
    const offenders: { file: string; line: number; text: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      if (ALLOWED_FILES.has(rel)) continue;
      const text = await readFile(file, "utf8");
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] ?? "";
        if (AUDIT_MUTATE.test(line)) {
          offenders.push({ file: rel, line: i + 1, text: line.trim() });
        }
      }
    }
    const allowed = [...ALLOWED_FILES].join(", ");
    expect(
      offenders,
      `Audit log mutations are only allowed inside { ${allowed} }:\n  ${offenders
        .map((o) => `${o.file}:${o.line} ${o.text}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
