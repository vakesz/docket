/**
 * HTML → cleaned-markdown pass for the web_fetch tool.
 *
 * Two goals:
 *   1. Strip head/script/style/noscript/template/iframe/svg + HTML comments,
 *      so chrome and inline assets don't bloat the agent's context.
 *   2. Convert the remaining body to markdown via Turndown so structure
 *      (headings, lists, fenced code, links) survives in a token-efficient
 *      form.
 *
 * Relative `<a href>` and `<img src>` URLs are resolved against the response
 * URL before Turndown runs, so the agent sees absolute URLs it can follow on
 * its own without juggling base URLs.
 *
 * Failure modes the caller (web-fetch.ts) handles:
 *   - parse error → `EmptyCleanedOutputError` is *not* thrown; we throw the
 *     underlying error and the caller falls back to raw.
 *   - cleaned markdown is whitespace-only → throws `EmptyCleanedOutputError`
 *     so the caller can record `cleanError` and fall back to raw.
 */

import "server-only";
import { JSDOM } from "jsdom";
import TurndownService from "turndown";

const NOISE_TAGS = ["head", "script", "style", "noscript", "template", "iframe", "svg"] as const;

export class EmptyCleanedOutputError extends Error {
  constructor() {
    super("cleaned output was empty (likely a client-rendered page)");
    this.name = "EmptyCleanedOutputError";
  }
}

export type CleanedHtml = {
  markdown: string;
  bytes: number;
};

export function cleanHtml(html: string, baseUrl: string): CleanedHtml {
  const dom = new JSDOM(html, { url: baseUrl });
  const doc = dom.window.document;

  for (const tag of NOISE_TAGS) {
    for (const el of Array.from(doc.getElementsByTagName(tag))) {
      el.remove();
    }
  }

  const walker = doc.createTreeWalker(doc, dom.window.NodeFilter.SHOW_COMMENT);
  const comments: Node[] = [];
  let node = walker.nextNode();
  while (node) {
    comments.push(node);
    node = walker.nextNode();
  }
  for (const c of comments) c.parentNode?.removeChild(c);

  // Resolve relative URLs to absolute. JSDOM's parser already attaches the
  // document's base URL, so anchor.href / img.src / link.href reflect the
  // resolved value. Writing it back to the attribute makes Turndown emit
  // absolute URLs without needing its own base-URL plumbing.
  for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
    const resolved = (a as HTMLAnchorElement).href;
    if (resolved) a.setAttribute("href", resolved);
  }
  for (const img of Array.from(doc.querySelectorAll("img[src]"))) {
    const resolved = (img as HTMLImageElement).src;
    if (resolved) img.setAttribute("src", resolved);
  }

  const root = doc.body ?? doc.documentElement;
  const innerHtml = root?.innerHTML ?? "";

  const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    linkStyle: "inlined",
  });
  const markdown = turndown.turndown(innerHtml).trim();

  if (markdown.length === 0) {
    throw new EmptyCleanedOutputError();
  }

  return {
    markdown,
    bytes: Buffer.byteLength(markdown, "utf8"),
  };
}

/**
 * Decide whether a response should be HTML-cleaned.
 *
 * - text/html and application/xhtml+xml → always cleaned.
 * - application/xml and text/plain → only cleaned when the body sniffs as HTML
 *   (DOCTYPE or <html> tag in the first ~512 bytes).
 * - everything else → passed through.
 *
 * The sniff is deliberately permissive — better to clean a page that turns
 * out to be plain text (Turndown will produce an essentially identical
 * output) than to bloat the context with HTML chrome that slipped past on a
 * mislabelled content-type.
 */
export function shouldCleanHtml(contentType: string | null, body: string): boolean {
  const ct = (contentType ?? "").toLowerCase().split(";")[0]?.trim() ?? "";
  if (ct.startsWith("text/html") || ct.startsWith("application/xhtml")) return true;
  if (ct === "application/xml" || ct.startsWith("text/plain") || ct === "") {
    return looksLikeHtml(body);
  }
  return false;
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 512).toLowerCase();
  return head.includes("<!doctype html") || /<html[\s>]/i.test(head);
}
