/**
 * Architecture guard: every `LLM_KINDS` entry has a `case` in the
 * registry switch.
 *
 * The UI selector and the runtime dispatch both source kinds from
 * `src/agent/llm/types.ts`. If a kind is added there but not wired up in
 * `src/agent/llm/registry.ts`, the form lets users save a row that crashes
 * when an agent loop tries to instantiate it. This regex check fails CI
 * before that can ship.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LLM_KINDS } from "@/agent/llm/types";

const REGISTRY_PATH = join(process.cwd(), "src", "agent", "llm", "registry.ts");

describe("arch: LLM_KINDS ↔ registry alignment", () => {
  it("every LLM_KINDS entry has a `case` in the registry dispatch", async () => {
    const source = await readFile(REGISTRY_PATH, "utf8");
    const missing = LLM_KINDS.filter((kind) => {
      const re = new RegExp(`case\\s+["']${kind}["']\\s*:`);
      return !re.test(source);
    });
    expect(missing, `LLM_KINDS without a registry switch case: ${missing.join(", ")}`).toEqual([]);
  });
});
