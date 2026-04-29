"use client";

import type { ComponentProps } from "react";
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import type { PluggableList } from "unified";
import { cn } from "@/lib/utils";
import rehypeHljs from "@/ui/markdown/rehype-hljs";

/**
 * Allow the small extra HTML surface that GitHub issue/PR bodies often
 * embed (collapsibles, alignment, simple inline elements, image sizing),
 * plus the `hljs`/`hljs-*`/`language-*` class names that `rehypeHljs`
 * stamps on `pre`/`code`/`span`. Anything else (script, event handlers,
 * weird URLs) is dropped silently by `rehype-sanitize`.
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

// Hoisted to module scope so each Markdown render reuses the same array
// references — keeps react-markdown's plugin pipeline cache stable.
const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: PluggableList = [rehypeRaw, rehypeHljs, [rehypeSanitize, sanitizeSchema]];
const COMPONENTS = {
  a: AnchorRenderer,
  code: CodeRenderer,
  pre: PreRenderer,
};

export const Markdown = memo(function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  if (!source?.trim()) {
    return <p className="text-sm italic text-muted-foreground-faint">(no content)</p>;
  }
  return (
    <div className={cn("docket-md break-words text-sm text-foreground", className)}>
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={COMPONENTS}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});

function AnchorRenderer({ href, children, ...rest }: ComponentProps<"a">) {
  const isExternal = !!href && /^https?:\/\//i.test(href);
  return (
    <a
      {...rest}
      href={href}
      target={isExternal ? "_blank" : rest.target}
      rel={isExternal ? "noopener noreferrer" : rest.rel}
      className="text-primary hover:underline"
    >
      {children}
    </a>
  );
}

function CodeRenderer({ className, children, ...rest }: ComponentProps<"code">) {
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
      className={cn(
        "rounded bg-muted px-1 py-0.5 font-mono text-[0.9em] text-foreground",
        className,
      )}
    >
      {children}
    </code>
  );
}

function PreRenderer({ className, children, ...rest }: ComponentProps<"pre">) {
  return (
    <pre
      {...rest}
      className={cn("my-2 overflow-x-auto rounded border border-border bg-muted p-3", className)}
    >
      {children}
    </pre>
  );
}
