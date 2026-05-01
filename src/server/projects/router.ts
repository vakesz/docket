import "server-only";
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { slugify } from "@/core/slug";
import type { Prisma } from "@/db/generated/client";
import { asPlainObject } from "@/lib/json";
import { buildProjectExport } from "@/server/projects/export";
import { getProviderSpec, listProviderSpecs, PROVIDER_TYPE_IDS } from "@/server/provider-registry";
import {
  assertFound,
  mutationProcedure,
  projectScopedApproverProcedure,
  projectScopedMutationProcedure,
  projectScopedProcedure,
  projectSlugSchema,
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

/**
 * Derive a project's URL slug from its display name. Returns the slug or
 * throws a `BAD_REQUEST` if the name has no slug-worthy characters (e.g.
 * "///" alone). The unique constraint on `Project.slug` is the second line
 * of defense — collisions surface as `CONFLICT` from the create/rename
 * mutations.
 */
function nameToSlug(name: string): string {
  const slug = slugify(name);
  if (!slug) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "project name must contain at least one letter or digit",
    });
  }
  return slug;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

export const projectsRouter = router({
  /**
   * Public-shaped catalog of registered provider kinds. Surfaces consume
   * this so they don't have to branch on `providerKind` — the project
   * picker, the OAuth provider form, the setup wizard, and the filter
   * bar all read from here. Returns only JSON-safe metadata (no
   * factories, no matchers); per-spec functions stay server-side.
   *
   * `oauth` is null when the provider doesn't support OAuth sign-in (the
   * field is omitted from the form picker in that case). `hasAvatarFetcher`
   * lets the filter bar render avatar chips conditionally without
   * importing the registry into client code.
   */
  kinds: protectedProcedure.query(() =>
    listProviderSpecs().map((spec) => ({
      typeId: spec.typeId,
      displayName: spec.displayName,
      setupFields: spec.setupFields,
      oauth: spec.oauth,
      capabilities: spec.capabilities,
      hasAvatarFetcher: spec.avatarFetcher !== null,
    })),
  ),

  /** List projects the current user owns or is a member of (non-archived). */
  list: protectedProcedure.query(async ({ ctx }) => {
    const userId = ctx.userId;
    const rows = await ctx.db.project.findMany({
      where: {
        archivedAt: null,
        OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
      },
      orderBy: [{ createdAt: "desc" }],
      select: {
        id: true,
        slug: true,
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

  /**
   * Get a single project the user has access to. Includes the provider's
   * capability map so client surfaces can branch on
   * `capabilities.supportedReactions.length` (etc.) without re-importing the
   * registry. `hasAvatarFetcher` lets the filter bar decide whether to
   * even attempt the avatar route for assignee chips.
   */
  get: projectScopedProcedure.input(projectSlugSchema).query(({ ctx }) => {
    const spec = getProviderSpec(ctx.project.providerKind);
    return {
      ...ctx.project,
      capabilities: spec?.capabilities ?? {
        supportedReactions: [],
        ciStatus: false,
        pullRequestDiffs: false,
        linkedItems: false,
        creatableKinds: ["task"],
      },
      hasAvatarFetcher: spec?.avatarFetcher != null,
    };
  }),

  /**
   * Create a project. The session user becomes the owner and gets an
   * implicit membership row so the (owner OR member) check in
   * `projectScopedProcedure` works uniformly.
   */
  create: mutationProcedure.input(CreateProjectInput).mutation(async ({ ctx, input }) => {
    const userId = ctx.userId;
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
    const slug = nameToSlug(input.name);
    try {
      return await ctx.db.project.create({
        data: {
          name: input.name,
          slug,
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
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw new TRPCError({
          code: "CONFLICT",
          message: `a project with the slug "${slug}" already exists — pick a different name`,
        });
      }
      throw err;
    }
  }),

  /**
   * Rename a project. Owner only — renaming changes the slug, which changes
   * the URL, so other members shouldn't be able to do it. The new slug is
   * derived from the new name; collisions surface as `CONFLICT`.
   */
  rename: projectScopedMutationProcedure
    .input(projectSlugSchema.extend({ name: z.string().min(1).max(120) }))
    .mutation(async ({ ctx, input }) => {
      if (ctx.project.ownerUserId !== ctx.userId) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "only the project owner can rename",
        });
      }
      const slug = nameToSlug(input.name);
      try {
        return await ctx.db.project.update({
          where: { id: ctx.projectId },
          data: { name: input.name, slug },
          select: { id: true, slug: true, name: true },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw new TRPCError({
            code: "CONFLICT",
            message: `a project with the slug "${slug}" already exists — pick a different name`,
          });
        }
        throw err;
      }
    }),

  /**
   * Archive — owner only. Items / conversations / proposals / etc. stay in
   * place but the project disappears from list queries. A future restore
   * procedure can flip archivedAt back to null.
   */
  archive: projectScopedMutationProcedure.input(projectSlugSchema).mutation(async ({ ctx }) => {
    if (ctx.project.ownerUserId !== ctx.userId) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "only the project owner can archive",
      });
    }
    return ctx.db.project.update({
      where: { id: ctx.projectId },
      data: { archivedAt: new Date() },
    });
  }),

  /**
   * Per-user landing project. `null` clears it and falls landing back to
   * "first available project". Validates that the caller still has access
   * before persisting so a stale id doesn't get pinned.
   */
  setDefault: mutationProcedure
    .input(z.object({ projectSlug: z.string().min(1).nullable() }))
    .mutation(async ({ ctx, input }) => {
      const userId = ctx.userId;
      let resolvedId: string | null = null;
      if (input.projectSlug) {
        const project = assertFound(
          await ctx.db.project.findFirst({
            where: {
              slug: input.projectSlug,
              archivedAt: null,
              OR: [{ ownerUserId: userId }, { memberships: { some: { userId } } }],
            },
            select: { id: true },
          }),
          "project not found or you no longer have access",
        );
        resolvedId = project.id;
      }
      await ctx.db.user.update({
        where: { id: userId },
        data: { defaultProjectId: resolvedId },
      });
      return { defaultProjectId: resolvedId };
    }),

  /**
   * Per-project LLM defaults. Approver-only so a viewer can't reroute the
   * project's agent to a different provider. `llmProviderId === null` clears
   * the project default and falls back to the global default; same for
   * temperature.
   */
  setLlmDefaults: projectScopedMutationProcedure
    .input(
      projectSlugSchema.extend({
        llmProviderId: z.string().min(1).nullable(),
        defaultTemperature: z.number().min(0).max(2).nullable(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      if (input.llmProviderId) {
        const provider = assertFound(
          await ctx.db.llmProvider.findUnique({
            where: { id: input.llmProviderId },
            select: { id: true, enabled: true },
          }),
          "LLM provider not found",
        );
        if (!provider.enabled) {
          throw new TRPCError({
            code: "BAD_REQUEST",
            message: "LLM provider is disabled",
          });
        }
      }
      return ctx.db.project.update({
        where: { id: ctx.projectId },
        data: {
          defaultLlmProviderId: input.llmProviderId,
          defaultTemperature: input.defaultTemperature,
        },
        select: {
          id: true,
          slug: true,
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
  export: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const userId = ctx.userId;
    return buildProjectExport(ctx.db, ctx.projectId, userId);
  }),

  /**
   * List members of a project. Any member can read the roster — knowing
   * who else has access is non-sensitive and useful for picking who to
   * tag in proposals. Owner is rendered separately so the UI can show
   * "owner" as a non-editable, non-removable row.
   */
  members: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const project = await ctx.db.project.findUniqueOrThrow({
      where: { id: ctx.projectId },
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
    return {
      callerIsOwner: project.ownerUserId === ctx.userId,
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
      projectSlugSchema.extend({
        email: z.string().email(),
        role: MEMBER_ROLE.default("member"),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const user = assertFound(
        await ctx.db.user.findUnique({
          where: { email: input.email.toLowerCase() },
          select: { id: true },
        }),
        "no user with that email has signed in yet",
      );
      if (ctx.project.ownerUserId === user.id) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "user is already the project owner",
        });
      }
      try {
        return await ctx.db.projectMembership.create({
          data: {
            projectId: ctx.projectId,
            userId: user.id,
            role: input.role,
          },
          select: { id: true, userId: true, role: true, createdAt: true },
        });
      } catch (err) {
        if (isUniqueViolation(err)) {
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
      projectSlugSchema.extend({
        membershipId: z.string().min(1),
        role: MEMBER_ROLE,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = assertFound(
        await ctx.db.projectMembership.findFirst({
          where: { id: input.membershipId, projectId: ctx.projectId },
          select: { id: true },
        }),
        "membership not found",
      );
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
      projectSlugSchema.extend({
        membershipId: z.string().min(1),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const membership = assertFound(
        await ctx.db.projectMembership.findFirst({
          where: { id: input.membershipId, projectId: ctx.projectId },
          select: { id: true, userId: true },
        }),
        "membership not found",
      );
      await ctx.db.projectMembership.delete({ where: { id: membership.id } });
      return { ok: true as const, membershipId: membership.id };
    }),

  /** Read the caller's profile bits the UI needs (default project picker). */
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.user.findUnique({
      where: { id: ctx.userId },
      select: { id: true, name: true, email: true, defaultProjectId: true },
    });
  }),
});
