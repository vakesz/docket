import { TRPCError } from "@trpc/server";

/**
 * Generic NOT_FOUND assertion for service code. Throws a `TRPCError` so
 * routers translate it to a 404, while server-side callers (e.g. the
 * proposals executor) can use the same helper without dragging in the
 * tRPC-builder + next-auth surface that lives in `./trpc.ts`.
 */
export function assertFound<T>(value: T | null | undefined, message: string): T {
  if (value === null || value === undefined) {
    throw new TRPCError({ code: "NOT_FOUND", message });
  }
  return value;
}
