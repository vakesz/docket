/**
 * Postgres error helpers shared across routers.
 *
 * postgres-js surfaces the SQLSTATE on `err.code` as a string. The check
 * has to be defensive because anything thrown out of a transaction could
 * be a postgres error, a Drizzle wrapper, or a JS Error from our own
 * code — the duck-typing handles all three.
 */

const PG_UNIQUE_VIOLATION = "23505";

export function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === PG_UNIQUE_VIOLATION
  );
}
