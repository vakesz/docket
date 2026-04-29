import "server-only";

/**
 * Normalize a thrown value into the `{ err, stack? }` shape pino consumers
 * across the server expect. Used by the proposal executor and the sync
 * worker — both surface failures as structured log entries.
 */
export function errFields(err: unknown): { err: string; stack?: string } {
  if (err instanceof Error) {
    return { err: err.message, ...(err.stack !== undefined ? { stack: err.stack } : {}) };
  }
  return { err: String(err) };
}
