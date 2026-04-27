/**
 * Tiny Zod → JSON Schema converter, shared by every tool factory.
 *
 * We intentionally avoid the `zod-to-json-schema` package: our tool params
 * are small, hand-typed unions of object/optional/default/nullable/enum/
 * string/number/boolean/array. A 60-line walker handles them with full
 * type fidelity at zero dep cost.
 */

import type { z } from "zod";

export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string };
  if (def.typeName === "ZodObject") {
    const shape = (def as { shape: () => Record<string, z.ZodTypeAny> }).shape();
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
  if (def.typeName === "ZodOptional" || def.typeName === "ZodDefault") {
    return zodToJsonSchema((def as unknown as { innerType: z.ZodTypeAny }).innerType);
  }
  if (def.typeName === "ZodNullable") {
    const inner = zodToJsonSchema((def as unknown as { innerType: z.ZodTypeAny }).innerType);
    const t = (inner as { type?: string | string[] }).type;
    return { ...inner, type: Array.isArray(t) ? [...t, "null"] : t ? [t, "null"] : "null" };
  }
  if (def.typeName === "ZodEnum") {
    return { type: "string", enum: (def as unknown as { values: readonly string[] }).values };
  }
  if (def.typeName === "ZodString") return { type: "string" };
  if (def.typeName === "ZodNumber") return { type: "number" };
  if (def.typeName === "ZodBoolean") return { type: "boolean" };
  if (def.typeName === "ZodArray") {
    return {
      type: "array",
      items: zodToJsonSchema((def as unknown as { type: z.ZodTypeAny }).type),
    };
  }
  // Fallback — accept anything.
  return {};
}

export function isOptional(schema: z.ZodTypeAny): boolean {
  const def = schema._def as { typeName?: string };
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}
