"use client";
import { createTRPCReact } from "@trpc/react-query";
import type { inferRouterInputs, inferRouterOutputs } from "@trpc/server";
import type { AppRouter } from "@/server/routers";

export const trpc = createTRPCReact<AppRouter>();

/**
 * Helpers to derive input/output types from a router path. Use them in
 * components that consume a query/mutation result so the prop type tracks the
 * router automatically:
 *
 *   type ItemRow = RouterOutputs["items"]["list"][number];
 *   type ProposeArgs = RouterInputs["proposals"]["proposeTransition"];
 *
 * Avoids hand-typed shapes that drift from the source of truth.
 */
export type RouterInputs = inferRouterInputs<AppRouter>;
export type RouterOutputs = inferRouterOutputs<AppRouter>;
