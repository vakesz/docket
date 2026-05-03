import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { integer, jsonb, numeric, text, timestamp, uuid } from "drizzle-orm/pg-core";

// Reusable column factories. One declaration site for every recurring column
// shape — branded UUIDs, FKs, timestamp pairs, JSON defaults, text-array
// defaults — so a change ripples to every table that uses them. Tables only
// reach for the raw Drizzle column helpers when the shape is genuinely
// one-of-a-kind.

export const pkUuid = <Brand extends string = string>() =>
  uuid().$type<Brand>().primaryKey().defaultRandom();

export const fkUuid = <Brand extends string = string>(
  target: () => AnyPgColumn,
  onDelete: "cascade" | "set null" | "restrict" = "cascade",
) => uuid().$type<Brand>().notNull().references(target, { onDelete });

export const optionalFkUuid = <Brand extends string = string>(
  target: () => AnyPgColumn,
  onDelete: "cascade" | "set null" = "set null",
) => uuid().$type<Brand>().references(target, { onDelete });

export const timestamps = () => ({
  createdAt: timestamp({ withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp({ withTimezone: true, mode: "date" })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

export const cents = () => integer().notNull().default(0);

// `Decimal(12, 4)` exact decimal arithmetic, matching the previous Prisma
// shape on `LlmProvider.{input,output}PriceCentsPerMtok`. postgres-js returns
// `numeric` as JS `string` by default; consumers parse with `Number()` at the
// single call site (`src/server/billing/budget.ts`). Same runtime behaviour
// as the previous Prisma `Decimal` column — no JS-side `Decimal` math.
export const decimal4 = () => numeric({ precision: 12, scale: 4 }).$type<string>();

export const emptyTextArray = <Brand extends string = string>() =>
  text().array().$type<Brand[]>().notNull().default(sql`'{}'`);

export const emptyJsonbObject = <Shape = Record<string, unknown>>() =>
  jsonb().$type<Shape>().notNull().default(sql`'{}'::jsonb`);
