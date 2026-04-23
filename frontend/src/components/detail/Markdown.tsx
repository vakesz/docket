import type { ComponentProps, ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/cn";
import { ISSUE_REF_PATTERN, type IssueLinkContext } from "~/lib/issueLinks";

/**
 * Allow the small extra HTML surface that GitHub issue/PR bodies often
 * embed (collapsibles, alignment, simple inline elements, image sizing).
 * Anything not in this schema — `<script>`, event handlers, weird URLs —
 * is silently dropped by `rehype-sanitize`.
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
        "prose-code:rounded prose-code:bg-surface-alt prose-code:px-1 prose-code:py-0.5 prose-code:text-fg prose-code:before:content-none prose-code:after:content-none",
        "prose-a:text-accent",
        "prose-img:max-w-full prose-img:rounded",
        className,
      )}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        rehypePlugins={[rehypeRaw, [rehypeSanitize, sanitizeSchema]]}
        components={{
          a: makeAnchorRenderer(issueLinks),
          // react-markdown defaults `text` to a string node; we wrap it so
          // we can splice issue references into clickable spans.
          p: ({ children, ...rest }) => <p {...rest}>{linkifyChildren(children, issueLinks)}</p>,
          li: ({ children, ...rest }) => <li {...rest}>{linkifyChildren(children, issueLinks)}</li>,
          td: ({ children, ...rest }) => <td {...rest}>{linkifyChildren(children, issueLinks)}</td>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
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
