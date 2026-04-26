import "server-only";
import { z } from "zod";
import type { Prisma } from "@/db/generated/client";
import {
  mutationProcedure,
  projectScopedProcedure,
  protectedProcedure,
  router,
} from "@/server/trpc";

/**
 * Provider kinds the UI exposes in the "create project" form. Source of
 * truth for which providers exist at runtime is `provider-registry.ts`,
 * which is empty in Phase 2; this list mirrors the *planned* kinds so the
 * picker can be wired before the spec rows arrive in Phase 3 / Phase 9.
 */
const PROVIDER_KIND = z.enum(["github", "azure_devops"]);

const CreateProjectInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  providerKind: PROVIDER_KIND,
  /// Free-form per-provider scope (e.g. { owner, repo } for GitHub). Phase 3
  /// adds a provider-aware picker; Phase 2 accepts whatever the form sends.
  providerScope: z.record(z.string(), z.unknown()),
});

export const projectsRouter = router({
  /** List projects the current user owns or is a member of (non-archived). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    if (!userId) {
      return [];
    }
    return ctx.db.project.findMany({
      where: {
        archivedAt: null,
        OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        name: true,
        description: true,
        providerKind: true,
        providerScope: true,
        defaultLlmProviderId: true,
        ownerUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  }),

  /** Get a single project the user has access to. */
  get: projectScopedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(({ ctx }) => ctx.project),

  /**
   * Create a project. The session user becomes the owner and gets an
   * implicit membership row so the (owner OR member) check in
   * `projectScopedProcedure` works uniformly.
   */
  create: mutationProcedure.input(CreateProjectInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.session.user.id;
    if (!userId) {
      throw new Error("session has no user id");
    }
    return ctx.db.project.create({
      data: {
        name: input.name,
        description: input.description,
        providerKind: input.providerKind,
        providerScope: input.providerScope as Prisma.InputJsonValue,
        ownerUserId: userId,
        memberships: {
          create: {
            userId,
            role: "approver",
          },
        },
      },
    });
  }),

  /**
   * Archive — owner only. Items / conversations / proposals / etc. stay in
   * place but the project disappears from list queries. A future restore
   * procedure can flip archivedAt back to null.
   */
  archive: mutationProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      const project = await ctx.db.project.findUnique({
        where: { id: input.projectId },
        select: { ownerUserId: true },
      });
      if (!project || project.ownerUserId !== userId) {
        throw new Error("only the project owner can archive");
      }
      return ctx.db.project.update({
        where: { id: input.projectId },
        data: { archivedAt: new Date() },
      });
    }),
});
