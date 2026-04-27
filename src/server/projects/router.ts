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
 * truth for which providers exist at runtime is `provider-registry.ts`.
 */
const PROVIDER_KIND = z.enum(["github", "azure_devops"]);

const CreateProjectInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  providerKind: PROVIDER_KIND,
  /// Free-form per-provider scope (e.g. { owner, repo } for GitHub).
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

  /**
   * Per-user landing project. `null` clears it and falls landing back to
   * "first available project". Validates that the caller still has access
   * before persisting so a stale id doesn't get pinned.
   */
  setDefault: mutationProcedure
    .input(z.object({ projectId: z.string().min(1).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.session.user.id;
      if (input.projectId) {
        const project = await ctx.db.project.findFirst({
          where: {
            id: input.projectId,
            archivedAt: null,
            OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
          },
          select: { id: true },
        });
        if (!project) {
          throw new Error("project not found or you no longer have access");
        }
      }
      await ctx.db.user.update({
        where: { id: userId },
        data: { defaultProjectId: input.projectId },
      });
      return { defaultProjectId: input.projectId };
    }),

  /** Read the caller's profile bits the UI needs (default project picker). */
  me: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    const user = await ctx.db.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, email: true, defaultProjectId: true },
    });
    return user;
  }),
});
