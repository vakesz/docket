/**
 * Architecture guard: vendor LLM SDKs are quarantined to a single
 * adapter file each.
 *
 * The whole point of `LlmAdapter` is that the agent loop, the prompt
 * builder, the tool registry, and every UI surface speak only to a
 * vendor-neutral interface. If the `openai` SDK starts being imported
 * anywhere except `src/agent/llm/openai.ts`, that property is silently
 * broken — the next vendor (Anthropic, Gemini, Bedrock, …) lands as a
 * multi-file leak instead of a single sibling adapter.
 *
 * The test enumerates `(sdkPackage, allowedFile)` pairs, walks the
 * source tree once, and fails if any file outside its allow-list
 * imports the matching package.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = process.cwd();
const SRC_ROOT = join(PROJECT_ROOT, "src");
const SKIP_DIRS = new Set(["node_modules", "generated"]);

type Quarantine = {
  sdk: string;
  /**
   * Files allowed to import the quarantined SDK. The chat adapter
   * (`agent/llm/openai.ts`) and the guardrail LLM-judge
   * (`agent/guardrail/llm-judge.ts`) both legitimately need the openai
   * SDK; everything else must go through the vendor-neutral interface.
   */
  allowedFiles: readonly string[];
  matcher: RegExp;
};

const QUARANTINES: Quarantine[] = [
  {
    sdk: "openai",
    allowedFiles: [
      join("src", "agent", "llm", "openai.ts"),
      join("src", "agent", "guardrail", "llm-judge.ts"),
    ],
    // Match the bare "openai" package (and submodules) but not "openai-foo".
    matcher:
      /from\s+["']openai(?:\/[^"']+)?["']|require\(\s*["']openai(?:\/[^"']+)?["']\s*\)|import\(\s*["']openai(?:\/[^"']+)?["']\s*\)/,
  },
];

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

describe("arch: LLM vendor SDK boundary", () => {
  it("no file outside its adapter imports a quarantined LLM SDK", async () => {
    expect((await stat(SRC_ROOT)).isDirectory()).toBe(true);

    const offenders: { file: string; sdk: string }[] = [];
    for await (const file of walk(SRC_ROOT)) {
      const rel = relative(PROJECT_ROOT, file);
      const text = await readFile(file, "utf8");
      for (const q of QUARANTINES) {
        if (q.allowedFiles.includes(rel)) continue;
        if (q.matcher.test(text)) {
          offenders.push({ file: rel, sdk: q.sdk });
        }
      }
    }

    expect(
      offenders,
      `Files importing a quarantined LLM SDK from outside its adapter:\n  ${offenders
        .map((o) => `${o.file} → ${o.sdk}`)
        .join("\n  ")}`,
    ).toEqual([]);
  });
});
