/**
 * Wire-format helpers for `LlmProvider.{input,output}PriceCentsPerMtok`.
 *
 * The columns are Drizzle `decimal` (Postgres numeric), which surfaces in
 * JS as `string | null` to preserve precision. Callers want `number | null`
 * because the rest of the cost path runs in plain JS numbers; these
 * helpers do the round-trip in one place so the router and the bootstrap
 * wizard can't drift on null-handling.
 *
 * Validation schema is shared too: USD cents per million tokens is a
 * non-negative number capped at 1M (a defensive ceiling — anything past
 * that is almost certainly a unit-conversion mistake by the operator).
 */

import { z } from "zod";

export const PriceCentsPerMtokSchema = z.number().min(0).max(1_000_000).nullable();

export function priceToString(value: number | null): string | null {
  return value === null ? null : value.toString();
}

export function priceFromString(value: string | null): number | null {
  return value === null ? null : Number(value);
}
