import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "~/lib/cn";

export function Markdown({ source, className }: { source: string; className?: string }) {
  if (!source?.trim()) {
    return <p className="text-sm italic text-zinc-400">No description.</p>;
  }
  return (
    <div
      className={cn(
        "prose prose-sm max-w-none text-zinc-800 dark:prose-invert dark:text-zinc-200",
        "prose-headings:font-semibold prose-headings:tracking-tight",
        "prose-code:rounded prose-code:bg-zinc-100 prose-code:px-1 prose-code:py-0.5 prose-code:before:content-none prose-code:after:content-none",
        "dark:prose-code:bg-zinc-900",
        "prose-a:text-accent",
        className,
      )}
    >
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
    </div>
  );
}
