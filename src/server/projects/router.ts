import "server-only";
import { TRPCError } from "@trpc/server";
import { and, asc, desc, eq, exists, isNull, or } from "drizzle-orm";
import { z } from "zod";
import { slugify } from "@/core/slug";
import { asConversationId, type ProjectId } from "@/core/types";
import { llmProviders, projectMemberships, projects, users } from "@/db/schema";
import { asPlainObject } from "@/lib/json";
import { logger } from "@/server/logger";
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

/**
 * Postgres unique-violation SQLSTATE. postgres-js surfaces it on `err.code`.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "23505"
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
    const rows = await ctx.db.query.projects.findMany({
      where: and(
        isNull(projects.archivedAt),
        or(
          eq(projects.ownerUserId, userId),
          exists(
            ctx.db
              .select({ id: projectMemberships.id })
              .from(projectMemberships)
              .where(
                and(
                  eq(projectMemberships.projectId, projects.id),
                  eq(projectMemberships.userId, userId),
                ),
              ),
          ),
        ),
      ),
      orderBy: [desc(projects.createdAt)],
      // Backstop against unbounded fan-out — a user with thousands of project
      // memberships would otherwise pull them all into the switcher.
      limit: 200,
      columns: {
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
        stateEncodingTags: [],
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
      const created = await ctx.db.transaction(async (tx) => {
        const [row] = await tx
          .insert(projects)
          .values({
            name: input.name,
            slug,
            description: input.description,
            providerKind: input.providerKind,
            providerScope: normalizedScope,
            ownerUserId: userId,
          })
          .returning();
        if (!row) throw new Error("project create returned no row");
        await tx.insert(projectMemberships).values({
          projectId: row.id,
          userId,
          role: "approver",
        });
        return row;
      });
      logger.info(
        {
          actorUserId: userId,
          projectId: created.id,
          slug: created.slug,
          providerKind: created.providerKind,
        },
        "projects: created",
      );
      return created;
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
        const [row] = await ctx.db
          .update(projects)
          .set({ name: input.name, slug })
          .where(eq(projects.id, ctx.projectId))
          .returning({ id: projects.id, slug: projects.slug, name: projects.name });
        if (!row) throw new Error("project rename returned no row");
        return row;
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
    const [archived] = await ctx.db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, ctx.projectId))
      .returning();
    if (!archived) throw new Error("project archive returned no row");
    logger.info(
      { actorUserId: ctx.userId, projectId: ctx.projectId, slug: ctx.project.slug },
      "projects: archived",
    );
    return archived;
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
      let resolvedId: ProjectId | null = null;
      if (input.projectSlug) {
        const project = assertFound(
          await ctx.db.query.projects.findFirst({
            where: and(
              eq(projects.slug, input.projectSlug),
              isNull(projects.archivedAt),
              or(
                eq(projects.ownerUserId, userId),
                exists(
                  ctx.db
                    .select({ id: projectMemberships.id })
                    .from(projectMemberships)
                    .where(
                      and(
                        eq(projectMemberships.projectId, projects.id),
                        eq(projectMemberships.userId, userId),
                      ),
                    ),
                ),
              ),
            ),
            columns: { id: true },
          }),
          "project not found or you no longer have access",
        );
        resolvedId = project.id;
      }
      await ctx.db.update(users).set({ defaultProjectId: resolvedId }).where(eq(users.id, userId));
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
          await ctx.db.query.llmProviders.findFirst({
            where: eq(llmProviders.id, input.llmProviderId),
            columns: { id: true, enabled: true },
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
      const [updated] = await ctx.db
        .update(projects)
        .set({
          defaultLlmProviderId: input.llmProviderId,
          defaultTemperature: input.defaultTemperature,
        })
        .where(eq(projects.id, ctx.projectId))
        .returning({
          id: projects.id,
          slug: projects.slug,
          defaultLlmProviderId: projects.defaultLlmProviderId,
          defaultTemperature: projects.defaultTemperature,
        });
      if (!updated) throw new Error("project setLlmDefaults returned no row");
      return updated;
    }),

  /**
   * Export project knowledge + the caller's conversations. Cursor-paginated
   * so the server doesn't have to materialize a chatty user's entire history
   * in one shot — the client loops on `nextCursor` and merges the pages into
   * a single download. Read-only; runs through `projectScopedProcedure` so
   * any member can pull their own archive.
   */
  export: projectScopedProcedure
    .input(
      projectSlugSchema.extend({
        cursor: z
          .object({
            startedAt: z.string(),
            conversationId: z.string().transform(asConversationId),
          })
          .nullish(),
      }),
    )
    .query(async ({ ctx, input }) => {
      return buildProjectExport(ctx.db, ctx.projectId, ctx.userId, input.cursor ?? null);
    }),

  /**
   * List members of a project. Any member can read the roster — knowing
   * who else has access is non-sensitive and useful for picking who to
   * tag in proposals. Owner is rendered separately so the UI can show
   * "owner" as a non-editable, non-removable row.
   */
  members: projectScopedProcedure.input(projectSlugSchema).query(async ({ ctx }) => {
    const project = await ctx.db.query.projects.findFirst({
      where: eq(projects.id, ctx.projectId),
      columns: { ownerUserId: true },
      with: {
        owner: { columns: { id: true, name: true, email: true, image: true } },
        memberships: {
          columns: { id: true, userId: true, role: true, createdAt: true },
          with: { user: { columns: { id: true, name: true, email: true, image: true } } },
          orderBy: [asc(projectMemberships.createdAt)],
        },
      },
    });
    if (!project) {
      throw new TRPCError({ code: "NOT_FOUND", message: "project not found" });
    }
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
        await ctx.db.query.users.findFirst({
          where: eq(users.email, input.email.toLowerCase()),
          columns: { id: true },
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
        const [created] = await ctx.db
          .insert(projectMemberships)
          .values({
            projectId: ctx.projectId,
            userId: user.id,
            role: input.role,
          })
          .returning({
            id: projectMemberships.id,
            userId: projectMemberships.userId,
            role: projectMemberships.role,
            createdAt: projectMemberships.createdAt,
          });
        if (!created) throw new Error("addMember returned no row");
        logger.info(
          {
            actorUserId: ctx.userId,
            projectId: ctx.projectId,
            membershipId: created.id,
            grantedUserId: created.userId,
            role: created.role,
          },
          "projects: member added",
        );
        return created;
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
        await ctx.db.query.projectMemberships.findFirst({
          where: and(
            eq(projectMemberships.id, input.membershipId),
            eq(projectMemberships.projectId, ctx.projectId),
          ),
          columns: { id: true },
        }),
        "membership not found",
      );
      const [updated] = await ctx.db
        .update(projectMemberships)
        .set({ role: input.role })
        .where(eq(projectMemberships.id, membership.id))
        .returning({
          id: projectMemberships.id,
          userId: projectMemberships.userId,
          role: projectMemberships.role,
        });
      if (!updated) throw new Error("updateMemberRole returned no row");
      logger.info(
        {
          actorUserId: ctx.userId,
          projectId: ctx.projectId,
          membershipId: updated.id,
          targetUserId: updated.userId,
          role: updated.role,
        },
        "projects: member role changed",
      );
      return updated;
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
        await ctx.db.query.projectMemberships.findFirst({
          where: and(
            eq(projectMemberships.id, input.membershipId),
            eq(projectMemberships.projectId, ctx.projectId),
          ),
          columns: { id: true, userId: true },
        }),
        "membership not found",
      );
      await ctx.db.delete(projectMemberships).where(eq(projectMemberships.id, membership.id));
      logger.info(
        {
          actorUserId: ctx.userId,
          projectId: ctx.projectId,
          membershipId: membership.id,
          removedUserId: membership.userId,
        },
        "projects: member removed",
      );
      return { ok: true as const, membershipId: membership.id };
    }),

  /** Read the caller's profile bits the UI needs (default project picker). */
  me: protectedProcedure.query(async ({ ctx }) => {
    return ctx.db.query.users.findFirst({
      where: eq(users.id, ctx.userId),
      columns: { id: true, name: true, email: true, defaultProjectId: true },
    });
  }),
});
