/**
 * Reusable Zod schemas that mint branded IDs at parse time. Centralizes the
 * `z.string().min(1).transform((v) => v as <Brand>)` pattern that was
 * previously duplicated across routers and agent tools — every boundary
 * crosses through these so the brand stamping happens in exactly one place.
 *
 * Pure boundary plumbing: no runtime side effects, no DB calls. Safe to
 * import from both `src/server/**` and `src/agent/**` (and from anywhere
 * else that needs to validate an external string into a branded id).
 */

import { z } from "zod";
import type { ProjectId, ProposalId, ProviderItemId, UserId } from "@/core/types";

const brandedIdSchema = <B extends string>() =>
  z
    .string()
    .min(1)
    .transform((v) => v as B);

export const providerItemIdSchema = brandedIdSchema<ProviderItemId>();
export const proposalIdSchema = brandedIdSchema<ProposalId>();
export const projectIdSchema = brandedIdSchema<ProjectId>();
export const userIdSchema = brandedIdSchema<UserId>();
