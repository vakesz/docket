/*
 * Tiny rehype plugin that highlights `<pre><code class="language-X">` blocks
 * with a curated `lowlight` registry. Sticking to a small set of languages
 * lets the bundler tree-shake the rest. Inline code is left alone; unknown
 * fences render as plain text.
 */

import type { Element, Root } from "hast";
import { toText } from "hast-util-to-text";
import bash from "highlight.js/lib/languages/bash";
import diff from "highlight.js/lib/languages/diff";
import go from "highlight.js/lib/languages/go";
import json from "highlight.js/lib/languages/json";
import markdown from "highlight.js/lib/languages/markdown";
import plaintext from "highlight.js/lib/languages/plaintext";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import yaml from "highlight.js/lib/languages/yaml";
import { createLowlight } from "lowlight";
import { visit } from "unist-util-visit";

const lowlight = createLowlight({
  bash,
  diff,
  go,
  json,
  markdown,
  plaintext,
  python,
  rust,
  sql,
  typescript,
  yaml,
});

const ALIASES: Record<string, string> = {
  sh: "bash",
  shell: "bash",
  md: "markdown",
  text: "plaintext",
  py: "python",
  rs: "rust",
  ts: "typescript",
  tsx: "typescript",
  js: "typescript",
  jsx: "typescript",
  yml: "yaml",
};

function languageOf(node: Element): string | undefined {
  const classes = node.properties?.className;
  if (!Array.isArray(classes)) return undefined;
  for (const c of classes) {
    if (typeof c !== "string") continue;
    if (c.startsWith("language-")) return c.slice("language-".length);
  }
  return undefined;
}

export default function rehypeHljs() {
  return (tree: Root) => {
    visit(tree, "element", (node, _index, parent) => {
      if (
        node.tagName !== "code" ||
        !parent ||
        parent.type !== "element" ||
        (parent as Element).tagName !== "pre"
      ) {
        return;
      }
      const raw = languageOf(node);
      if (!raw) return;
      const lang = ALIASES[raw] ?? raw;
      if (!lowlight.registered(lang)) return;

      const text = toText(node, { whitespace: "pre" });
      const result = lowlight.highlight(lang, text);
      const classes = Array.isArray(node.properties.className)
        ? node.properties.className.filter((c) => typeof c === "string")
        : [];
      if (!classes.includes("hljs")) classes.unshift("hljs");
      if (!classes.includes(`language-${lang}`)) classes.push(`language-${lang}`);
      node.properties.className = classes;
      node.children = result.children as Element["children"];
    });
  };
}
