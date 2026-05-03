/**
 * Tiny Zod → JSON Schema converter, shared by every tool factory.
 *
 * We intentionally avoid the `zod-to-json-schema` package: our tool params
 * are small, hand-typed unions of object/optional/default/nullable/enum/
 * string/number/boolean/array. A 60-line walker handles them with full
 * type fidelity at zero dep cost.
 */

import type { z } from "zod";

/**
 * Loose shape over Zod's `_def` covering every internal field this walker
 * reads. Zod doesn't export per-typeName variants and Zod 4's `$ZodTypeDef`
 * has its own `type: string` discriminator that collides with our
 * `type?: ZodTypeAny` (ZodArray's element). We bridge via `unknown` once
 * here rather than `as unknown as` per branch — the runtime `typeName`
 * switch is what gates safe access.
 */
type ZodDef = {
  typeName?: string;
  shape?: () => Record<string, z.ZodTypeAny>;
  innerType?: z.ZodTypeAny;
  type?: z.ZodTypeAny;
  values?: readonly string[];
};

function defOf(schema: z.ZodTypeAny): ZodDef {
  return schema._def as unknown as ZodDef;
}

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = defOf(schema);
  if (def.typeName === "ZodObject" && def.shape) {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, child] of Object.entries(shape)) {
      properties[key] = zodToJsonSchema(child);
      if (!isOptional(child)) required.push(key);
    }
    return {
      type: "object",
      properties,
      ...(required.length ? { required } : {}),
      additionalProperties: false,
    };
  }
  if ((def.typeName === "ZodOptional" || def.typeName === "ZodDefault") && def.innerType) {
    return zodToJsonSchema(def.innerType);
  }
  if (def.typeName === "ZodNullable" && def.innerType) {
    const inner = zodToJsonSchema(def.innerType);
    const t = (inner as { type?: string | string[] }).type;
    return { ...inner, type: Array.isArray(t) ? [...t, "null"] : t ? [t, "null"] : "null" };
  }
  if (def.typeName === "ZodEnum" && def.values) {
    return { type: "string", enum: def.values };
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodArray" && def.type) {
    return { type: "array", items: zodToJsonSchema(def.type) };
  }
  // Fallback — accept anything.
  return {};
}

export function isOptional(schema: z.ZodTypeAny): boolean {
  const def = defOf(schema);
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}
