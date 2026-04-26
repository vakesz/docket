import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/cn";
import { ISSUE_REF_PATTERN, type IssueLinkContext } from "~/lib/issueLinks";
import { installHljsTheme } from "./hljsTheme";
import rehypeHljs from "./rehypeHljs";

// Install the GitHub light/dark hljs stylesheets the first time this module
// is imported. Markdown is in a lazy chunk, so this only runs when a chat or
// item-detail view actually mounts.
installHljsTheme();

/**
 * Allow the small extra HTML surface that GitHub issue/PR bodies often
 * embed (collapsibles, alignment, simple inline elements, image sizing),
 * plus the `hljs`/`hljs-*`/`language-*` class names that `rehype-highlight`
 * stamps on `pre`/`code`/`span`. The default schema's regex on
 * `code.className` is `/^language-/`, which would otherwise strip the bare
 * `hljs` token from `class="hljs language-python"`.
 *
 * Anything not listed here — `<script>`, event handlers, weird URLs — is
 * dropped silently by `rehype-sanitize`.
 */
const sanitizeSchema = {
  ...defaultSchema,
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    "details",
    "summary",
    "kbd",
    "sub",
    "sup",
    "mark",
    "ins",
    "abbr",
    "u",
    "s",
    "strike",
    "small",
    "div",
    "span",
    "picture",
    "source",
    "video",
    "figure",
    "figcaption",
  ],
  attributes: {
    ...defaultSchema.attributes,
    "*": [...(defaultSchema.attributes?.["*"] ?? []), "align", "id", "title"],
    a: [
      ...(defaultSchema.attributes?.a ?? []),
      ["target", "_blank"],
      ["rel", "noopener", "noreferrer"],
    ],
    img: [...(defaultSchema.attributes?.img ?? []), "width", "height", "loading"],
    video: ["src", "controls", "width", "height", "poster"],
    source: ["src", "type", "media", "srcset"],
    details: ["open"],
    code: [...(defaultSchema.attributes?.code ?? []), ["className", /^hljs(-|$)/, /^language-/]],
    span: [...(defaultSchema.attributes?.span ?? []), ["className", /^hljs-/]],
    pre: [...(defaultSchema.attributes?.pre ?? []), "className"],
  },
};

interface MarkdownProps {
  source: string;
  className?: string;
  /**
   * Optional issue-link resolver. When provided, plain-text references
   * such as `#123` or `owner/repo#7` inside the rendered output become
   * clickable links to the right provider URL.
   */
  issueLinks?: IssueLinkContext;
}

export function Markdown({ source, className, issueLinks }: MarkdownProps) {
  if (!source?.trim()) {
    return <p className="text-sm italic text-fg-faint">No description.</p>;
  }
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none break-words text-fg dark:prose-invert",
        "prose-headings:font-semibold prose-headings:tracking-tight prose-headings:text-fg",
        "prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-accent",
        "prose-img:max-w-full prose-img:rounded",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        // Order matters: parse raw HTML into hast first, then highlight (so
        // raw `<pre><code>` blocks from issue/PR bodies also get tokenized),
        // then sanitize so the allowlist is the last word.
        // Order matters: parse raw HTML into hast first, then highlight (so
        // raw `<pre><code>` blocks from issue/PR bodies also get tokenized),
        // then sanitize so the allowlist is the last word.
        rehypePlugins={[rehypeRaw, rehypeHljs, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a: makeAnchorRenderer(issueLinks),
          // react-markdown defaults `text` to a string node; we wrap it so
          // we can splice issue references into clickable spans.
          p: ({ children, ...rest }) => <p {...rest}>{linkifyChildren(children, issueLinks)}</p>,
          li: ({ children, ...rest }) => <li {...rest}>{linkifyChildren(children, issueLinks)}</li>,
          td: ({ children, ...rest }) => <td {...rest}>{linkifyChildren(children, issueLinks)}</td>,
          code: CodeRenderer,
          pre: PreRenderer,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function CodeRenderer({ className, children, ...rest }: ComponentProps<"code">) {
  // react-markdown 10 exposes block vs inline by whether the parent is `<pre>`.
  // We detect that via the language class rehype-highlight stamps on block
  // code (`hljs language-…`) — inline code never carries those.
  const isBlock = typeof className === "string" && /\bhljs\b/.test(className);
  if (isBlock) {
    return (
      <code {...rest} className={cn(className, "block font-mono text-xs leading-relaxed")}>
        {children}
      </code>
    );
  }
  return (
    <code
      {...rest}
      className={cn("rounded bg-surface-alt px-1 py-0.5 font-mono text-[0.9em] text-fg", className)}
    >
      {children}
    </code>
  );
}

function PreRenderer({ className, children, ...rest }: ComponentProps<"pre">) {
  return (
    <pre
      {...rest}
      className={cn(
        "my-2 overflow-x-auto rounded border border-border bg-surface-alt p-3",
        className,
      )}
    >
      {children}
    </pre>
  );
}

function makeAnchorRenderer(issueLinks: IssueLinkContext | undefined) {
  return function Anchor({ href, children, ...rest }: ComponentProps<"a">) {
    const isExternal = !!href && /^https?:\/\//i.test(href);
    return (
      <a
        {...rest}
        href={href}
        target={isExternal ? "_blank" : rest.target}
        rel={isExternal ? "noopener noreferrer" : rest.rel}
      >
        {linkifyChildren(children, issueLinks)}
      </a>
    );
  };
}

type Tag = "p" | "li" | "td";

// Tag wrappers are defined inline in the `components` map above to keep
// React's tag-specific HTML attribute typing intact. `_LinkifiedTags` is
// exported only as documentation for which elements participate in
// linkification.
export type _LinkifiedTags = Tag;

function linkifyChildren(children: ReactNode, issueLinks: IssueLinkContext | undefined): ReactNode {
  if (!issueLinks) return children;
  return mapTextNodes(children, (text) => linkifyText(text, issueLinks));
}

function mapTextNodes(node: ReactNode, fn: (text: string) => ReactNode): ReactNode {
  if (typeof node === "string") return fn(node);
  if (Array.isArray(node)) {
    return node.map((child, idx) => {
      const mapped = mapTextNodes(child, fn);
      // Preserve a stable key for plain-string children we transformed.
      if (typeof child === "string") {
        // biome-ignore lint/suspicious/noArrayIndexKey: rendered children are produced in source order each call; index is stable within a single Markdown render.
        return <span key={`t-${idx}`}>{mapped}</span>;
      }
      return mapped;
    });
  }
  return node;
}

function linkifyText(text: string, ctx: IssueLinkContext): ReactNode {
  if (!text) return text;
  const out: ReactNode[] = [];
  let lastIndex = 0;
  ISSUE_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((match = ISSUE_REF_PATTERN.exec(text)) !== null) {
    const ref = match[0];
    const url = ctx.resolve(ref);
    if (!url) continue;
    if (match.index > lastIndex) {
      out.push(text.slice(lastIndex, match.index));
    }
    out.push(
      <a
        key={`ref-${match.index}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:underline"
      >
        {ref}
      </a>,
    );
    lastIndex = match.index + ref.length;
  }
  if (lastIndex === 0) return text;
  if (lastIndex < text.length) out.push(text.slice(lastIndex));
  return out;
}
