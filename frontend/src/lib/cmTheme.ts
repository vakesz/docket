import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import type { Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { tags as t } from "@lezer/highlight";

/**
 * CodeMirror theme bound to Docket's semantic tokens.
 *
 * Every color references a CSS custom property (the same tokens used by
 * Tailwind utilities), so swapping `data-theme` on <html> reflows the editor
 * automatically — no React state, no remount. One extension covers every
 * Docket theme (light, dark, nord, catppuccin, etc.).
 */
export function docketCodeMirrorTheme(): Extension[] {
  const base = EditorView.theme(
    {
      "&": {
        color: "var(--color-fg)",
        backgroundColor: "var(--color-bg)",
        height: "100%",
      },
      ".cm-scroller": {
        fontFamily: "var(--font-mono)",
      },
      ".cm-content": {
        caretColor: "var(--color-accent)",
      },
      ".cm-cursor, .cm-dropCursor": {
        borderLeftColor: "var(--color-accent)",
      },
      "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
        backgroundColor: "color-mix(in oklab, var(--color-accent) 28%, transparent)",
      },
      ".cm-activeLine": {
        backgroundColor: "color-mix(in oklab, var(--color-fg) 6%, transparent)",
      },
      ".cm-gutters": {
        backgroundColor: "var(--color-surface)",
        color: "var(--color-fg-faint)",
        borderRight: "1px solid var(--color-border)",
      },
      ".cm-activeLineGutter": {
        backgroundColor: "color-mix(in oklab, var(--color-fg) 6%, transparent)",
        color: "var(--color-fg-muted)",
      },
      ".cm-foldPlaceholder": {
        backgroundColor: "var(--color-surface-alt)",
        color: "var(--color-fg-muted)",
        border: "1px solid var(--color-border)",
      },
      ".cm-selectionMatch": {
        backgroundColor: "color-mix(in oklab, var(--color-accent) 20%, transparent)",
      },
      ".cm-matchingBracket, .cm-nonmatchingBracket": {
        backgroundColor: "color-mix(in oklab, var(--color-accent) 25%, transparent)",
        outline: "1px solid var(--color-accent)",
      },
      ".cm-tooltip": {
        backgroundColor: "var(--color-surface)",
        color: "var(--color-fg)",
        border: "1px solid var(--color-border)",
      },
      ".cm-tooltip .cm-tooltip-arrow:before": {
        borderTopColor: "var(--color-border)",
        borderBottomColor: "var(--color-border)",
      },
      ".cm-tooltip .cm-tooltip-arrow:after": {
        borderTopColor: "var(--color-surface)",
        borderBottomColor: "var(--color-surface)",
      },
      ".cm-searchMatch": {
        backgroundColor: "color-mix(in oklab, var(--color-warning) 35%, transparent)",
        outline: "1px solid var(--color-warning)",
      },
      ".cm-searchMatch.cm-searchMatch-selected": {
        backgroundColor: "color-mix(in oklab, var(--color-warning) 55%, transparent)",
      },
    },
    { dark: false },
  );

  const highlight = HighlightStyle.define([
    { tag: [t.keyword, t.operatorKeyword, t.modifier], color: "var(--color-accent)" },
    {
      tag: [t.name, t.deleted, t.character, t.propertyName, t.macroName],
      color: "var(--color-fg)",
    },
    { tag: [t.function(t.variableName), t.labelName], color: "var(--color-accent)" },
    { tag: [t.color, t.constant(t.name), t.standard(t.name)], color: "var(--color-warning)" },
    { tag: [t.definition(t.name), t.separator], color: "var(--color-fg-muted)" },
    {
      tag: [t.typeName, t.className, t.number, t.changed, t.annotation, t.self, t.namespace],
      color: "var(--color-warning)",
    },
    { tag: [t.string, t.regexp, t.special(t.string)], color: "var(--color-success)" },
    { tag: [t.meta, t.comment], color: "var(--color-fg-faint)", fontStyle: "italic" },
    { tag: t.link, color: "var(--color-accent)", textDecoration: "underline" },
    { tag: t.heading, color: "var(--color-accent)", fontWeight: "bold" },
    { tag: [t.atom, t.bool, t.special(t.variableName)], color: "var(--color-danger)" },
    { tag: t.invalid, color: "var(--color-danger)" },
    { tag: t.strong, fontWeight: "bold" },
    { tag: t.emphasis, fontStyle: "italic" },
    { tag: t.strikethrough, textDecoration: "line-through" },
    { tag: t.url, color: "var(--color-accent)", textDecoration: "underline" },
    { tag: [t.processingInstruction, t.inserted], color: "var(--color-success)" },
    { tag: [t.quote], color: "var(--color-fg-muted)", fontStyle: "italic" },
    { tag: [t.list], color: "var(--color-fg)" },
  ]);

  return [base, syntaxHighlighting(highlight)];
}
