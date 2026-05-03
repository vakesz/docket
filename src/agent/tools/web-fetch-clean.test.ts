import { describe, expect, it } from "vitest";
import { cleanHtml, shouldCleanHtml } from "./web-fetch-clean";

const BASE = "https://example.com/article";

describe("cleanHtml", () => {
  it("converts an article to markdown with structure preserved", () => {
    const html = `<!doctype html><html><head><title>x</title><style>h1 { color: red; }</style></head><body>
      <h1>Title</h1>
      <p>First paragraph with <a href="https://example.org/x">link</a>.</p>
      <ul><li>one</li><li>two</li></ul>
      <pre><code>const x = 1;</code></pre>
    </body></html>`;
    const { markdown, bytes } = cleanHtml(html, BASE);
    expect(markdown).toContain("# Title");
    expect(markdown).toContain("First paragraph with [link](https://example.org/x)");
    expect(markdown).toMatch(/^-\s+one$/m);
    expect(markdown).toMatch(/^-\s+two$/m);
    expect(markdown).toContain("```");
    expect(markdown).toContain("const x = 1;");
    expect(bytes).toBe(Buffer.byteLength(markdown, "utf8"));
  });

  it("strips script, style, head, noscript, template, iframe, and svg", () => {
    const html = `<!doctype html><html><head><title>noise</title></head>
      <body>
        <script>alert(1)</script>
        <style>body { color: red; }</style>
        <noscript>turn on JS</noscript>
        <template id="t"><span>hidden</span></template>
        <iframe src="https://ads.example/"></iframe>
        <svg><circle cx="5" cy="5" r="5"/></svg>
        <p>Real content.</p>
      </body></html>`;
    const { markdown } = cleanHtml(html, BASE);
    expect(markdown).toBe("Real content.");
  });

  it("strips HTML comments", () => {
    const html = `<html><body><!-- secret --><p>Visible.</p><!-- another --></body></html>`;
    const { markdown } = cleanHtml(html, BASE);
    expect(markdown).toBe("Visible.");
  });

  it("resolves relative anchor hrefs to absolute against the base URL", () => {
    const html = `<html><body><p>See <a href="/docs/intro">intro</a> and <a href="../about">about</a>.</p></body></html>`;
    const { markdown } = cleanHtml(html, "https://example.com/guides/setup");
    expect(markdown).toContain("[intro](https://example.com/docs/intro)");
    expect(markdown).toContain("[about](https://example.com/about)");
  });

  it("preserves already-absolute links unchanged", () => {
    const html = `<html><body><a href="https://other.example/path">x</a></body></html>`;
    const { markdown } = cleanHtml(html, BASE);
    expect(markdown).toContain("[x](https://other.example/path)");
  });

  it("throws when nothing readable remains", () => {
    const html = `<!doctype html><html><head></head><body><script>app()</script></body></html>`;
    expect(() => cleanHtml(html, BASE)).toThrow(/cleaned output was empty/);
  });

  it("recovers from malformed HTML (missing close tags) without throwing", () => {
    const html = `<html><body><h1>Hello<p>world without closing tags`;
    const { markdown } = cleanHtml(html, BASE);
    expect(markdown).toContain("Hello");
    expect(markdown).toContain("world without closing tags");
  });
});

describe("shouldCleanHtml", () => {
  it("cleans text/html", () => {
    expect(shouldCleanHtml("text/html; charset=utf-8", "<html></html>")).toBe(true);
  });

  it("cleans application/xhtml+xml", () => {
    expect(shouldCleanHtml("application/xhtml+xml", "<html></html>")).toBe(true);
  });

  it("does NOT clean application/json", () => {
    expect(shouldCleanHtml("application/json", "{}")).toBe(false);
  });

  it("cleans text/plain only when body sniffs as HTML", () => {
    expect(shouldCleanHtml("text/plain", "just some text")).toBe(false);
    expect(shouldCleanHtml("text/plain", "<!DOCTYPE html><html>...")).toBe(true);
    expect(shouldCleanHtml("text/plain", "<html><body>x</body></html>")).toBe(true);
  });

  it("cleans application/xml only when body sniffs as HTML", () => {
    expect(shouldCleanHtml("application/xml", "<feed><entry/></feed>")).toBe(false);
    expect(shouldCleanHtml("application/xml", "<!DOCTYPE html><html>x</html>")).toBe(true);
  });

  it("cleans missing content-type only when body sniffs as HTML", () => {
    expect(shouldCleanHtml(null, "plain text")).toBe(false);
    expect(shouldCleanHtml(null, "<html><body>x</body></html>")).toBe(true);
  });
});
