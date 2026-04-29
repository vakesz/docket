import { describe, expect, it } from "vitest";
import { slugify } from "@/core/slug";

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("ACME / Web")).toBe("acme-web");
  });

  it("collapses runs of non-alphanumeric chars", () => {
    expect(slugify("foo  --  bar !!! baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing dashes", () => {
    expect(slugify("---hi---")).toBe("hi");
  });

  it("strips diacritics", () => {
    expect(slugify("Café Résumé")).toBe("cafe-resume");
  });

  it("returns null for empty / punctuation-only input", () => {
    expect(slugify("")).toBeNull();
    expect(slugify("   ")).toBeNull();
    expect(slugify("///")).toBeNull();
  });

  it("preserves digits", () => {
    expect(slugify("Project 42")).toBe("project-42");
  });
});
