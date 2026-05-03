"use client";

import dynamic from "next/dynamic";

/**
 * Client-only lazy variant of `Markdown`. Use this in chat bubbles and
 * other interactive surfaces where the ~240KB of `react-markdown` +
 * `rehype-*` + highlight.js can be deferred past first paint without
 * hurting perceived performance — bubbles render the streaming text
 * incrementally anyway, so paying the bundle cost up-front gains nothing.
 *
 * Server-rendered surfaces (item description in `DetailPane`, etc.)
 * should keep importing the eager `@/ui/markdown/markdown` so SSR carries
 * the formatted body in the first response.
 */
export const MarkdownLazy = dynamic(
  () => import("@/ui/markdown/markdown").then((mod) => mod.Markdown),
  {
    ssr: false,
    // `loading` paints nothing — bubbles already show the raw text frame
    // around it, and the chunk arrives within a few hundred ms.
    loading: () => null,
  },
);

/**
 * Trigger the `react-markdown` chunk fetch on idle so the first chat
 * bubble doesn't wait on the dynamic import to resolve. Safe to call
 * repeatedly; the dynamic-import cache deduplicates. SSR-safe — bails
 * when there's no `window`.
 */
export function prewarmMarkdown(): void {
  if (typeof window === "undefined") return;
  const load = () => {
    void import("@/ui/markdown/markdown");
  };
  const ric = (
    window as Window &
      typeof globalThis & {
        requestIdleCallback?: (cb: () => void, opts?: { timeout?: number }) => number;
      }
  ).requestIdleCallback;
  if (typeof ric === "function") ric(load, { timeout: 2000 });
  else window.setTimeout(load, 200);
}
