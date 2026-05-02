// Runs after the agent response is fully assembled — the streamed deltas
// stay untouched on the wire; the trim only lands on persisted text and
// staged proposal bodies. Truncation markers are inserted as syntactically
// valid comments so renderers don't choke on the trimmed block.

const COMMENT_BY_LANGUAGE: Record<string, string> = {
  ts: "//",
  tsx: "//",
  js: "//",
  jsx: "//",
  go: "//",
  rs: "//",
  java: "//",
  kt: "//",
  swift: "//",
  c: "//",
  cpp: "//",
  cs: "//",
  php: "//",
  scala: "//",
  dart: "//",
  groovy: "//",
  py: "#",
  rb: "#",
  sh: "#",
  bash: "#",
  zsh: "#",
  yaml: "#",
  yml: "#",
  toml: "#",
  dockerfile: "#",
  makefile: "#",
  r: "#",
  nix: "#",
  conf: "#",
  sql: "--",
  lua: "--",
  hs: "--",
  elm: "--",
  lisp: ";;",
  clj: ";;",
  cljs: ";;",
  scheme: ";;",
};

const HTML_LANGUAGES = new Set(["html", "xml", "svg", "md", "markdown"]);

const TRUNCATION_MESSAGE = "truncated by docket (max-lines policy)";

const PLACEHOLDER = "*[code example omitted by project policy]*";

export type CodeSnippetCapOptions = {
  enabled: boolean;
  maxLines: number;
  maxSnippetsPerReply: number;
};

export type CodeSnippetCapResult = {
  text: string;
  /** How many fenced blocks were dropped because of the per-reply cap. */
  blocksDropped: number;
  /** How many surviving blocks had their bodies trimmed by the line cap. */
  blocksTrimmed: number;
  /** True when policy disabled fenced blocks and we substituted placeholders. */
  blocksReplaced: boolean;
};

/**
 * Build the language-aware truncation comment line for a given fence
 * info string. Unknown / missing languages get the HTML-comment form so
 * the marker never reads as a stray identifier.
 */
function truncationCommentFor(rawLang: string): string {
  const lang = rawLang.trim().toLowerCase();
  if (!lang || HTML_LANGUAGES.has(lang)) {
    return `<!-- ${TRUNCATION_MESSAGE} -->`;
  }
  const prefix = COMMENT_BY_LANGUAGE[lang];
  if (prefix) {
    return `${prefix} ${TRUNCATION_MESSAGE}`;
  }
  return `<!-- ${TRUNCATION_MESSAGE} -->`;
}

type FenceMatch = {
  /** Fence character ('`' or '~'). */
  char: string;
  /** Number of fence characters on the opening line. */
  count: number;
  /** Info string after the fence (language hint, etc.). */
  info: string;
};

/**
 * Match a fence opener / closer. Markdown allows up to 3 leading
 * spaces of indentation; we don't normalize indentation since we
 * round-trip the original line, but we accept it on detection.
 */
function matchFence(line: string): FenceMatch | null {
  const m = line.match(/^[ ]{0,3}(`{3,}|~{3,})([^\n]*)$/);
  if (!m) return null;
  const fence = m[1] ?? "";
  const info = m[2] ?? "";
  return { char: fence[0] ?? "", count: fence.length, info };
}

function isClosing(line: string, opener: FenceMatch): boolean {
  const closer = matchFence(line);
  if (!closer) return false;
  // Closing fence must use the same character, be at least as long as
  // the opener, and carry no info string.
  return (
    closer.char === opener.char && closer.count >= opener.count && closer.info.trim().length === 0
  );
}

type Segment =
  | { kind: "text"; lines: string[] }
  | { kind: "block"; openLine: string; closeLine: string; bodyLines: string[]; opener: FenceMatch };

function parseSegments(input: string): { segments: Segment[]; trailingNewline: boolean } {
  const trailingNewline = input.endsWith("\n");
  const lines = input.split("\n");
  // split() leaves a trailing empty string when the input ends with
  // "\n"; drop it so we don't emit a stray blank line at the end.
  if (trailingNewline) lines.pop();

  const segments: Segment[] = [];
  let i = 0;
  let textBuffer: string[] = [];
  while (i < lines.length) {
    const line = lines[i] ?? "";
    const opener = matchFence(line);
    if (opener) {
      // Find the matching closer.
      let j = i + 1;
      while (j < lines.length && !isClosing(lines[j] ?? "", opener)) {
        j += 1;
      }
      if (j >= lines.length) {
        // Unterminated fence — bail out and treat the rest as text so
        // we don't accidentally swallow the whole document.
        break;
      }
      if (textBuffer.length > 0) {
        segments.push({ kind: "text", lines: textBuffer });
        textBuffer = [];
      }
      segments.push({
        kind: "block",
        openLine: line,
        closeLine: lines[j] ?? "",
        bodyLines: lines.slice(i + 1, j),
        opener,
      });
      i = j + 1;
      continue;
    }
    textBuffer.push(line);
    i += 1;
  }
  // Append any unterminated tail as plain text so the document round-trips.
  if (i < lines.length) {
    textBuffer.push(...lines.slice(i));
  }
  if (textBuffer.length > 0) {
    segments.push({ kind: "text", lines: textBuffer });
  }
  return { segments, trailingNewline };
}

function renderSegments(segments: readonly Segment[], trailingNewline: boolean): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (segment.kind === "text") {
      parts.push(segment.lines.join("\n"));
    } else {
      parts.push([segment.openLine, ...segment.bodyLines, segment.closeLine].join("\n"));
    }
  }
  let out = parts.join("\n");
  if (trailingNewline) out += "\n";
  return out;
}

/**
 * Apply the configured caps to a single piece of assistant-authored
 * markdown text. Returns the transformed text plus counters callers
 * can feed into observability (e.g. `code_snippets_emitted` / `_trimmed`).
 */
export function capCodeSnippets(
  input: string,
  options: CodeSnippetCapOptions,
): CodeSnippetCapResult {
  if (!input) {
    return { text: input, blocksDropped: 0, blocksTrimmed: 0, blocksReplaced: false };
  }

  const { segments, trailingNewline } = parseSegments(input);
  const blockSegments = segments.filter(
    (s): s is Extract<Segment, { kind: "block" }> => s.kind === "block",
  );
  if (blockSegments.length === 0) {
    return { text: input, blocksDropped: 0, blocksTrimmed: 0, blocksReplaced: false };
  }

  // Policy treats both "explicitly disabled" and "max-snippets = 0" the
  // same way: every fenced block becomes a one-line italic placeholder.
  if (!options.enabled || options.maxSnippetsPerReply === 0) {
    const replaced: Segment[] = segments.map((s) =>
      s.kind === "text" ? s : { kind: "text", lines: [PLACEHOLDER] },
    );
    return {
      text: renderSegments(replaced, trailingNewline),
      blocksDropped: 0,
      blocksTrimmed: 0,
      blocksReplaced: true,
    };
  }

  let kept = 0;
  let dropped = 0;
  let trimmed = 0;
  const out: Segment[] = [];

  for (const segment of segments) {
    if (segment.kind === "text") {
      out.push(segment);
      continue;
    }
    if (kept >= options.maxSnippetsPerReply) {
      dropped += 1;
      continue;
    }
    kept += 1;
    if (segment.bodyLines.length > options.maxLines) {
      const head = segment.bodyLines.slice(0, options.maxLines);
      head.push(truncationCommentFor(segment.opener.info));
      out.push({ ...segment, bodyLines: head });
      trimmed += 1;
    } else {
      out.push(segment);
    }
  }

  return {
    text: renderSegments(out, trailingNewline),
    blocksDropped: dropped,
    blocksTrimmed: trimmed,
    blocksReplaced: false,
  };
}
