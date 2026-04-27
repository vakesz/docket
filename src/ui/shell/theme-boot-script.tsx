/**
 * Inline script that runs before the body paints, so the chosen theme is
 * applied without a flash from the default light palette. Mirrors the logic
 * in `@/lib/theme` (kept in sync by hand — a duplicated constant is the
 * cost of avoiding a JS bundle round-trip on first paint).
 */

import { ADAPTIVE_VARIANTS, STORAGE_KEY, THEMES } from "@/lib/theme";

export function ThemeBootScript() {
  const adaptiveJson = JSON.stringify(ADAPTIVE_VARIANTS);
  const darkConcrete = JSON.stringify(THEMES.filter((t) => t.group === "dark").map((t) => t.id));
  const validIds = JSON.stringify(THEMES.map((t) => t.id));

  const script = `(() => {
  try {
    var key = ${JSON.stringify(STORAGE_KEY)};
    var adaptive = ${adaptiveJson};
    var darkSet = new Set(${darkConcrete});
    var valid = new Set(${validIds});
    var stored = localStorage.getItem(key);
    var id = stored && valid.has(stored) ? stored : "system";
    var concrete = id;
    if (adaptive[id]) {
      var prefersDark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
      concrete = prefersDark ? adaptive[id].dark : adaptive[id].light;
    }
    document.documentElement.dataset.theme = concrete;
    if (darkSet.has(concrete)) document.documentElement.classList.add("dark");
  } catch (e) {
    // Ignore — fall back to the default theme tokens.
  }
})();`;

  // biome-ignore lint/security/noDangerouslySetInnerHtml: inline boot script content is built from constants in @/lib/theme; required to apply the theme before first paint and avoid FOUC.
  return <script dangerouslySetInnerHTML={{ __html: script }} />;
}
