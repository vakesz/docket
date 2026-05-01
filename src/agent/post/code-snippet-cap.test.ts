import { describe, expect, it } from "vitest";
import { capCodeSnippets } from "@/agent/post/code-snippet-cap";

const ENABLED = { enabled: true, maxLines: 20, maxSnippetsPerReply: 2 };

describe("capCodeSnippets", () => {
  it("passes plain prose through untouched", () => {
    const text = "Hello world.\n\nNo code here.";
    const result = capCodeSnippets(text, ENABLED);
    expect(result.text).toBe(text);
    expect(result.blocksDropped).toBe(0);
    expect(result.blocksTrimmed).toBe(0);
    expect(result.blocksReplaced).toBe(false);
  });

  it("preserves a short well-formed snippet", () => {
    const text = ["Try this:", "", "```ts", "const x = 1;", "```", ""].join("\n");
    const result = capCodeSnippets(text, ENABLED);
    expect(result.text).toBe(text);
    expect(result.blocksTrimmed).toBe(0);
  });

  it("trims a block past max-lines and stamps a language-aware comment", () => {
    const lines = Array.from({ length: 30 }, (_, i) => `console.log(${i});`);
    const text = ["Long sample:", "```ts", ...lines, "```"].join("\n");
    const result = capCodeSnippets(text, { enabled: true, maxLines: 5, maxSnippetsPerReply: 2 });
    const out = result.text.split("\n");
    // Body retained: 5 original lines + 1 truncation comment.
    const fenceStart = out.indexOf("```ts");
    const fenceEnd = out.indexOf("```", fenceStart + 1);
    const body = out.slice(fenceStart + 1, fenceEnd);
    expect(body).toHaveLength(6);
    expect(body[5]).toBe("// truncated by docket (max-lines policy)");
    expect(result.blocksTrimmed).toBe(1);
    expect(result.blocksDropped).toBe(0);
  });

  it("uses # for python and -- for sql truncation comments", () => {
    const py = ["```py", ...Array.from({ length: 6 }, (_, i) => `print(${i})`), "```"].join("\n");
    const sql = ["```sql", ...Array.from({ length: 6 }, (_, i) => `SELECT ${i};`), "```"].join(
      "\n",
    );
    const opts = { enabled: true, maxLines: 3, maxSnippetsPerReply: 2 };
    expect(capCodeSnippets(py, opts).text).toContain("# truncated by docket (max-lines policy)");
    expect(capCodeSnippets(sql, opts).text).toContain("-- truncated by docket (max-lines policy)");
  });

  it("uses HTML comment for unknown / missing languages and html/markdown", () => {
    const big = Array.from({ length: 6 }, () => "x").join("\n");
    const opts = { enabled: true, maxLines: 3, maxSnippetsPerReply: 2 };
    expect(capCodeSnippets(`\`\`\`\n${big}\n\`\`\``, opts).text).toContain(
      "<!-- truncated by docket (max-lines policy) -->",
    );
    expect(capCodeSnippets(`\`\`\`html\n${big}\n\`\`\``, opts).text).toContain(
      "<!-- truncated by docket (max-lines policy) -->",
    );
    expect(capCodeSnippets(`\`\`\`weird-lang\n${big}\n\`\`\``, opts).text).toContain(
      "<!-- truncated by docket (max-lines policy) -->",
    );
  });

  it("drops blocks past the per-reply cap", () => {
    const block = (label: string) => `\`\`\`ts\nconst ${label} = 1;\n\`\`\``;
    const text = ["Intro.", block("a"), "Middle.", block("b"), "More.", block("c"), "Outro."].join(
      "\n",
    );
    const result = capCodeSnippets(text, { enabled: true, maxLines: 20, maxSnippetsPerReply: 2 });
    expect(result.blocksDropped).toBe(1);
    expect(result.text).toContain("const a = 1;");
    expect(result.text).toContain("const b = 1;");
    expect(result.text).not.toContain("const c = 1;");
    expect(result.text).toContain("Intro.");
    expect(result.text).toContain("Middle.");
    expect(result.text).toContain("Outro.");
  });

  it("replaces every block with the placeholder when disabled", () => {
    const text = [
      "Use these:",
      "```ts",
      "const x = 1;",
      "```",
      "And:",
      "```py",
      "print('hi')",
      "```",
    ].join("\n");
    const result = capCodeSnippets(text, {
      enabled: false,
      maxLines: 20,
      maxSnippetsPerReply: 2,
    });
    expect(result.blocksReplaced).toBe(true);
    expect(result.text).not.toContain("```");
    expect(result.text.match(/\*\[code example omitted by project policy]\*/g)).toHaveLength(2);
    // Surrounding prose still flows.
    expect(result.text).toContain("Use these:");
    expect(result.text).toContain("And:");
  });

  it("treats max-snippets-per-reply = 0 as disabled", () => {
    const text = ["Look:", "```ts", "const x = 1;", "```"].join("\n");
    const result = capCodeSnippets(text, {
      enabled: true,
      maxLines: 20,
      maxSnippetsPerReply: 0,
    });
    expect(result.blocksReplaced).toBe(true);
    expect(result.text).toContain("*[code example omitted by project policy]*");
    expect(result.text).not.toContain("```");
  });

  it("handles ~~~ fences identically to ``` fences", () => {
    const text = ["~~~ts", "const x = 1;", "~~~"].join("\n");
    const result = capCodeSnippets(text, ENABLED);
    expect(result.text).toBe(text);
  });

  it("preserves trailing newline shape", () => {
    const withNl = "x\n```ts\nconst y = 1;\n```\n";
    const withoutNl = "x\n```ts\nconst y = 1;\n```";
    expect(capCodeSnippets(withNl, ENABLED).text).toBe(withNl);
    expect(capCodeSnippets(withoutNl, ENABLED).text).toBe(withoutNl);
  });

  it("leaves an unterminated fence as plain text rather than swallowing the rest", () => {
    const text = "Open: ```ts\nconst x = 1;";
    const result = capCodeSnippets(text, ENABLED);
    // No fence detected (closing fence missing); text passes through.
    expect(result.text).toBe(text);
  });
});
