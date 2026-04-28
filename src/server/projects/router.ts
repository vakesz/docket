import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import type { Prisma } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { buildProjectExport } from "@/server/projects/export";
import { getProviderSpec, PROVIDER_TYPE_IDS } from "@/server/provider-registry";
import {
  mutationProcedure,
  projectScopedApproverProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  protectedProcedure,
  router,
} from "@/server/trpc";

const MEMBER_ROLE = z.enum(["viewer", "member", "approver"]);

const PROVIDER_KIND = z.enum(PROVIDER_TYPE_IDS);

const CreateProjectInput = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(2000).default(""),
  providerKind: PROVIDER_KIND,
  providerScope: z.record(z.string(), z.unknown()),
});

export const projectsRouter = router({
  /** List projects the current user owns or is a member of (non-archived). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.session.user.id;
    if (!userId) {
      return [];
    }
    const rows = await ctx.db.project.findMany({
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
        defaultTemperature: true,
        ownerUserId: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    // Precompute scopeLabel server-side so client surfaces never branch on
    // providerKind — labelTemplate is the single rendering rule per spec.
    return rows.map((row) => {
      const spec = getProviderSpec(row.providerKind);
      const scopeObj = asPlainObject(row.providerScope);
      const scopeLabel = spec?.labelTemplate ? spec.labelTemplate(scopeObj) : "";
      return { ...row, scopeLabel };
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
    const spec = getProviderSpec(input.providerKind);
    if (!spec) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: `unknown provider kind: ${input.providerKind}`,
      });
    }
    const rawScope = asPlainObject(input.providerScope);
    let normalizedScope: Record<string, unknown>;
    try {
      normalizedScope = spec.normalizeConfig ? spec.normalizeConfig(rawScope) : rawScope;
    } catch (err) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: err instanceof Error ? err.message : "invalid provider scope",
      });
    }
    return ctx.db.project.create({
      data: {
        name: input.name,
        description: input.description,
        providerKind: input.providerKind,
        providerScope: normalizedScope as Prisma.InputJsonValue,
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

  /**
   * Per-project LLM defaults. Approver-only so a viewer can't reroute the
   * project's agent to a different provider. `llmProviderId === null` clears
   * the project default and falls back to the global default; same for
   * temperature.
   */
  setLlmDefaults: projectScopedMutationProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        llmProviderId: z.string().min(1).nullable(),
        defaultTemperature: z.number().min(0).max(2).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.llmProviderId) {
        const provider = await ctx.db.llmProvider.findUnique({
          where: { id: input.llmProviderId },
          select: { id: true, enabled: true },
        });
        if (!provider) {
          throw new TRPCError({ code: "NOT_FOUND", message: "LLM provider not found" });
        }
        if (!provider.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LLM provider is disabled",
          });
        }
      }
      return ctx.db.project.update({
        where: { id: input.projectId },
        data: {
          defaultLlmProviderId: input.llmProviderId,
          defaultTemperature: input.defaultTemperature,
        },
        select: {
          id: true,
          defaultLlmProviderId: true,
          defaultTemperature: true,
        },
      });
    }),

  /**
   * Export project knowledge + the caller's conversations as a single
   * JSON blob. Read-only; runs through `projectScopedProcedure` so any
   * member can pull their own archive.
   */
  export: projectScopedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx }) => {
      const userId = ctx.session.user.id;
      if (!userId) {
        throw new TRPCError({ code: "UNAUTHORIZED" });
      }
      return buildProjectExport(ctx.db, ctx.projectId, userId);
    }),

  /**
   * List members of a project. Any member can read the roster — knowing
   * who else has access is non-sensitive and useful for picking who to
   * tag in proposals. Owner is rendered separately so the UI can show
   * "owner" as a non-editable, non-removable row.
   */
  members: projectScopedProcedure
    .input(z.object({ projectId: z.string().min(1) }))
    .query(async ({ ctx, input }) => {
      const project = await ctx.db.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: {
          ownerUserId: true,
          owner: { select: { id: true, name: true, email: true, image: true } },
          memberships: {
            select: {
              id: true,
              userId: true,
              role: true,
              createdAt: true,
              user: { select: { id: true, name: true, email: true, image: true } },
            },
            orderBy: [{ createdAt: "asc" }],
          },
        },
      });
      const callerId = ctx.session.user.id;
      return {
        callerIsOwner: project.ownerUserId === callerId,
        owner: project.owner,
        members: project.memberships.map((m) => ({
          membershipId: m.id,
          userId: m.userId,
          role: m.role,
          createdAt: m.createdAt,
          name: m.user.name,
          email: m.user.email,
          image: m.user.image,
        })),
      };
    }),

  /**
   * Add a member to a project by email. Approver-only — keeps roster
   * changes gated to people who can already approve writes. Looks the
   * user up by email; if no row exists yet, fail loudly so the inviter
   * knows the recipient hasn't signed in. (No invite-link flow yet.)
   */
  addMember: projectScopedApproverProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        email: z.string().email(),
        role: MEMBER_ROLE.default("member"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = await ctx.db.user.findUnique({
        where: { email: input.email.toLowerCase() },
        select: { id: true },
      });
      if (!user) {
        throw new TRPCError({
          code: "NOT_FOUND",
          message: "no user with that email has signed in yet",
        });
      }
      const project = await ctx.db.project.findUniqueOrThrow({
        where: { id: input.projectId },
        select: { ownerUserId: true },
      });
      if (project.ownerUserId === user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "user is already the project owner",
        });
      }
      try {
        return await ctx.db.projectMembership.create({
          data: {
            projectId: input.projectId,
            userId: user.id,
            role: input.role,
          },
          select: { id: true, userId: true, role: true, createdAt: true },
        });
      } catch (err) {
        if (
          typeof err === "object" &&
          err !== null &&
          "code" in err &&
          (err as { code: string }).code === "P2002"
        ) {
          throw new TRPCError({
            code: "CONFLICT",
            message: "user is already a member",
          });
        }
        throw err;
      }
    }),

  /** Change a member's role. Approver-only; viewer/member/approver. */
  updateMemberRole: projectScopedApproverProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        membershipId: z.string().min(1),
        role: MEMBER_ROLE,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.projectMembership.findFirst({
        where: { id: input.membershipId, projectId: input.projectId },
        select: { id: true },
      });
      if (!membership) {
        throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
      }
      return ctx.db.projectMembership.update({
        where: { id: membership.id },
        data: { role: input.role },
        select: { id: true, userId: true, role: true },
      });
    }),

  /**
   * Remove a member. Approver-only. Owners cannot be removed (the
   * implicit owner membership doesn't live in this table). Removing
   * yourself is allowed and falls back to "no access to this project".
   */
  removeMember: projectScopedApproverProcedure
    .input(
      z.object({
        projectId: z.string().min(1),
        membershipId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = await ctx.db.projectMembership.findFirst({
        where: { id: input.membershipId, projectId: input.projectId },
        select: { id: true, userId: true },
      });
      if (!membership) {
        throw new TRPCError({ code: "NOT_FOUND", message: "membership not found" });
      }
      await ctx.db.projectMembership.delete({ where: { id: membership.id } });
      return { ok: true as const, membershipId: membership.id };
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
