import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const coreDir = path.resolve(__dirname);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      yield* walkTs(full);
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".test.ts")) {
      yield full;
    }
  }
}

const importLine = /from\s+["']([^"']+)["']/g;

function imports(file: string): string[] {
  const src = readFileSync(file, "utf8");
  return Array.from(src.matchAll(importLine), (m) => m[1] ?? "");
}

describe("architecture: import boundaries", () => {
  it("src/core/** must not import from src/providers/**, src/server/**, or src/agent/**", () => {
    const violations: string[] = [];
    for (const file of walkTs(coreDir)) {
      for (const dep of imports(file)) {
        const isForbiddenAlias =
          dep.startsWith("@/providers") || dep.startsWith("@/server") || dep.startsWith("@/agent");
        const isForbiddenRelative =
          dep.startsWith(".") &&
          (path.resolve(path.dirname(file), dep).startsWith(path.join(repoRoot, "src/providers")) ||
            path.resolve(path.dirname(file), dep).startsWith(path.join(repoRoot, "src/server")) ||
            path.resolve(path.dirname(file), dep).startsWith(path.join(repoRoot, "src/agent")));
        if (isForbiddenAlias || isForbiddenRelative) {
          violations.push(`${path.relative(repoRoot, file)} → ${dep}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
