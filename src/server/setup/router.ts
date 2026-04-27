import "server-only";
import { applyBootstrap, BootstrapInput } from "@/server/setup/bootstrap";
import { getSetupStatus } from "@/server/setup/status";
import { publicProcedure, router } from "@/server/trpc";

/**
 * Bootstrap router for the in-browser wizard.
 *
 * Exposed as `publicProcedure` because there are no users yet on a fresh
 * deployment — `protectedProcedure` would lock the operator out of their
 * own first sign-in. Safety lives inside `applyBootstrap`: once
 * `setup.complete` is true every subsequent call rejects with
 * `CONFLICT`.
 *
 * Why not also gate on `app.read-only`: read-only mode is for locking
 * down a *running* deployment. A deployment that hasn't completed
 * bootstrap has no UI for an operator to flip the toggle yet, so the
 * gate is moot here.
 */
export const setupRouter = router({
  /**
   * Public read of bootstrap state, used by the wizard form so it can
   * show "this row already exists" badges and skip the subsection rather
   * than render a duplicate input.
   */
  status: publicProcedure.query(async ({ ctx }) => {
    return getSetupStatus(ctx.db);
  }),

  bootstrap: publicProcedure.input(BootstrapInput).mutation(async ({ ctx, input }) => {
    return applyBootstrap(ctx.db, input);
  }),
});
