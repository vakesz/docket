"use client";

import "./markdown.css";
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

// Typography lives entirely in markdown.css under `.docket-md` — these
// component overrides only carry behavior (external-link rel/target).

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
      ...(defaultSchema.attributes?.["a"] ?? []),
      ["target", "_blank"],
      ["rel", "noopener", "noreferrer"],
    ],
    img: [...(defaultSchema.attributes?.["img"] ?? []), "width", "height", "loading"],
    video: ["src", "controls", "width", "height", "poster"],
    source: ["src", "type", "media", "srcset"],
    details: ["open"],
    code: [
      ...(defaultSchema.attributes?.["code"] ?? []),
      ["className", /^hljs(-|$)/, /^language-/],
    ],
    span: [...(defaultSchema.attributes?.["span"] ?? []), ["className", /^hljs-/]],
    pre: [...(defaultSchema.attributes?.["pre"] ?? []), "className"],
  },
};

// Hoisted to module scope so each Markdown render reuses the same array
// references — keeps react-markdown's plugin pipeline cache stable.
const REMARK_PLUGINS: PluggableList = [remarkGfm, remarkBreaks];
const REHYPE_PLUGINS: PluggableList = [rehypeRaw, rehypeHljs, [rehypeSanitize, sanitizeSchema]];
const COMPONENTS = {
  a: AnchorRenderer,
};

export const Markdown = memo(function Markdown({
  source,
  className,
}: {
  source: string;
  className?: string;
}) {
  if (!source?.trim()) {
    return <p className="text-muted-foreground/70 text-sm italic">(no content)</p>;
  }
  return (
    <div className={cn("docket-md wrap-break-word min-w-0 text-foreground text-sm", className)}>
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

function AnchorRenderer({ href, ...rest }: ComponentProps<"a">) {
  const isExternal = !!href && /^https?:\/\//i.test(href);
  return (
    <a
      {...rest}
      href={href}
      target={isExternal ? "_blank" : rest.target}
      rel={isExternal ? "noopener noreferrer" : rest.rel}
    />
  );
}
