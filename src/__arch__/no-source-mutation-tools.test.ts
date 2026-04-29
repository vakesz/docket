/**
 * Architecture guard: the agent has no source-mutating tools.
 *
 * AGENTS.md rule 6 — "Project sources are read-only for the agent" — is
 * the safety property we want pinned in CI. The failure mode is subtle:
 * someone adds a `propose_create_source` or `edit_source` factory to
 * `src/agent/tools/` thinking it's a small convenience, and now the
 * agent can clobber author material the user pasted in. The arch test
 * scans the agent's tool factory files and fails if any tool definition
 * carries a name in the source-mutation namespace.
 *
 * Sources still mutate — through `src/server/sources/router.ts` — but
 * that path is human-driven (UI buttons, tRPC mutations). The agent
 * never sees those.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const TOOLS_ROOT = join(PROJECT_ROOT, "src", "agent", "tools");

/**
 * Verbs we treat as "this writes a source." Strict prefix match against
 * the tool's `name:` literal — adding a defensible read-side helper like
 * `count_sources` stays fine because it doesn't lead with a write verb.
 */
const FORBIDDEN_PREFIXES = [
  "create_source",
  "update_source",
  "delete_source",
  "edit_source",
  "write_source",
  "patch_source",
  "upload_source",
  "propose_source", // a future "we'll proposal-pipeline this" mistake
  "propose_create_source",
  "propose_update_source",
  "propose_delete_source",
  "propose_edit_source",
  "propose_write_source",
];

async function* walk(dir: string): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (entry.isFile() && /\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      yield full;
    }
  }
}

describe("arch: no source-mutating agent tools", () => {
  it("no tool definition under src/agent/tools/ carries a source-write name", async () => {
    expect((await stat(TOOLS_ROOT)).isDirectory()).toBe(true);

    // Match `name: "<identifier>"` inside a tool definition. Quoted both
    // ways since biome / formatter may normalize either. We deliberately
    // scan literal tool names, not handler bodies — the registry only
    // cares what names the model gets to call.
    const NAME_LITERAL = /name:\s*["']([a-z][a-z0-9_]*)["']/g;
    const offenders: { file: string; toolName: string }[] = [];

    for await (const file of walk(TOOLS_ROOT)) {
      const text = await readFile(file, "utf8");
      for (const match of text.matchAll(NAME_LITERAL)) {
        const name = match[1];
        if (
          name &&
          FORBIDDEN_PREFIXES.some((prefix) => name === prefix || name.startsWith(`${prefix}_`))
        ) {
          offenders.push({
            file: relative(PROJECT_ROOT, file),
            toolName: name,
          });
        }
      }
    }

    expect(
      offenders,
      `Agent tools with source-mutation names (AGENTS.md rule 6 — sources are human-only):\n  ${offenders
        .map((o) => `${o.file} → ${o.toolName}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
