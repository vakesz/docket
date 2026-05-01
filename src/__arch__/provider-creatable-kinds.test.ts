/**
 * Architecture guard: every registered provider declares a non-empty
 * `creatableKinds` list of valid `ItemKind` values.
 *
 * The "+ New item" form takes its dropdown options (and its default) from
 * `project.capabilities.creatableKinds`. An empty list would leave the form
 * with no default kind to submit; a stray non-canonical string would slip
 * past the executor's enum check and crash on the provider boundary. Both
 * mistakes are silent at compile time on a `readonly ItemKind[]` shape, so
 * pin them here.
 */

import { describe, expect, it } from "vitest";
import { ITEM_KINDS } from "@/core/types";
import { listProviderSpecs } from "@/server/provider-registry";

describe("arch: provider creatableKinds", () => {
  it("every spec declares at least one creatable kind", () => {
    const empty = listProviderSpecs()
      .filter((spec) => spec.capabilities.creatableKinds.length === 0)
      .map((spec) => spec.typeId);
    expect(empty, `providers with empty creatableKinds: ${empty.join(", ")}`).toEqual([]);
  });

  it("every creatableKinds entry is a canonical ItemKind", () => {
    const valid = new Set<string>(ITEM_KINDS);
    const offenders: string[] = [];
    for (const spec of listProviderSpecs()) {
      for (const kind of spec.capabilities.creatableKinds) {
        if (!valid.has(kind)) offenders.push(`${spec.typeId}:${kind}`);
      }
    }
    expect(offenders, `non-canonical creatableKinds: ${offenders.join(", ")}`).toEqual([]);
  });
});
