/*
 * Switch between highlight.js's bundled GitHub light/dark themes based on
 * the `.dark` class that `lib/theme.ts` toggles on `<html>`. Vite's `?inline`
 * import yields each theme's CSS as a string at build time, so we just swap
 * the contents of one shared <style> tag when the class flips. No custom
 * token mapping, no per-app-theme stylesheet.
 */
import lightCss from "highlight.js/styles/github.css?inline";
import darkCss from "highlight.js/styles/github-dark.css?inline";

let installed = false;

export function installHljsTheme(): void {
  if (installed || typeof document === "undefined") return;
  installed = true;

  const styleEl = document.createElement("style");
  styleEl.dataset.hljsTheme = "true";
  document.head.appendChild(styleEl);

  const apply = () => {
    const isDark = document.documentElement.classList.contains("dark");
    styleEl.textContent = isDark ? darkCss : lightCss;
  };

  apply();

  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}
