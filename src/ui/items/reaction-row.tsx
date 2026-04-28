"use client";

import { Button } from "@headlessui/react";
import { Loader2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { Reactions } from "@/core/types";
import { trpc } from "@/lib/trpc-client";
import { cn } from "@/lib/utils";
import { ProposalDialog } from "@/ui/proposals/proposal-dialog";

// Presentation-layer maps for known reaction shortcodes. Keyed by the opaque
// string the provider declares in `capabilities.supportedReactions` — when
// there's no entry for a key (a future provider, a custom reaction), we
// render the raw key as both glyph and label. Core stays provider-agnostic;
// this map is purely UI sugar.
const REACTION_GLYPH: Record<string, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  confused: "😕",
  heart: "❤️",
  rocket: "🚀",
  eyes: "👀",
};

const REACTION_LABEL: Record<string, string> = {
  "+1": "thumbs up",
  "-1": "thumbs down",
  laugh: "laugh",
  hooray: "hooray",
  confused: "confused",
  heart: "heart",
  rocket: "rocket",
  eyes: "eyes",
};

function glyphFor(kind: string): string {
  return REACTION_GLYPH[kind] ?? kind;
}

function labelFor(kind: string): string {
  return REACTION_LABEL[kind] ?? kind;
}

function asReactions(value: unknown, supported: readonly string[]): Reactions {
  if (!value || typeof value !== "object") return {};
  const out: Reactions = {};
  for (const k of supported) {
    const n = (value as Record<string, unknown>)[k];
    if (typeof n === "number" && n > 0) out[k] = n;
  }
  return out;
}

/**
 * Reaction strip rendered on the item header and on each comment when the
 * provider declares any supported reactions
 * (`capabilities.supportedReactions.length > 0`). Each chip stages a single
 * reaction_toggle proposal — the project's auto-accept default lands the
 * change inline; if the project has opted out, the confirm dialog opens.
 * Optimistic state isn't worth the complexity here: `router.refresh()`
 * after success pulls the post-write counts.
 *
 * Reactions are intentionally a UI-only mutation — the agent has no
 * `propose_reaction_toggle` tool. They're conversational signals between
 * humans, not work the LLM should be doing.
 *
 * `targetKind === "comment"` always passes the `providerCommentId` as
 * `targetId` (the provider's own id), not the cached row's surrogate.
 */
export function ReactionRow({
  projectId,
  providerItemId,
  targetKind,
  targetId,
  reactions,
  supportedReactions,
}: {
  projectId: string;
  providerItemId: string;
  targetKind: "item" | "comment";
  targetId: string;
  reactions: unknown;
  supportedReactions: readonly string[];
}) {
  const router = useRouter();
  const utils = trpc.useUtils();
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const counts = asReactions(reactions, supportedReactions);

  const propose = trpc.proposals.proposeReactionToggle.useMutation({
    onSuccess: async (res) => {
      if (res.status === "confirmed") {
        await Promise.all([utils.items.get.invalidate(), utils.proposals.list.invalidate()]);
        router.refresh();
      } else {
        setPendingProposalId(res.id);
      }
    },
  });

  // The in-flight reaction kind is whatever's on the mutation's `variables`
  // while `isPending` — TanStack Query already tracks both, so a parallel
  // `busy` state would just be a stale shadow.
  const busy = propose.isPending ? (propose.variables?.reaction ?? null) : null;
  const error = propose.error?.message;

  if (supportedReactions.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1">
      {supportedReactions.map((kind) => {
        const count = counts[kind] ?? 0;
        const active = count > 0;
        return (
          <Button
            key={kind}
            disabled={busy !== null}
            aria-label={`React with ${labelFor(kind)}`}
            title={`React with ${labelFor(kind)}`}
            onClick={() => {
              propose.mutate({
                projectId,
                providerItemId,
                targetKind,
                targetId,
                reaction: kind,
                op: active ? "remove" : "add",
              });
            }}
            className={cn(
              "inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[11px] leading-none",
              "transition-transform duration-100 hover:[transform:scale(1.25)]",
              "disabled:cursor-not-allowed disabled:opacity-60",
              active ? "bg-accent/10 text-fg" : "text-fg-muted opacity-70 hover:opacity-100",
              busy === kind && "opacity-60",
            )}
          >
            <span aria-hidden="true">{glyphFor(kind)}</span>
            {busy === kind ? (
              <Loader2 aria-hidden="true" className="size-3 animate-spin" />
            ) : count > 0 ? (
              <span className="font-mono text-[10px]">{count}</span>
            ) : null}
          </Button>
        );
      })}
      {error ? <span className="text-xs text-danger-fg">{error}</span> : null}
      <ProposalDialog
        projectId={projectId}
        proposalId={pendingProposalId}
        onClose={() => setPendingProposalId(null)}
      />
    </div>
  );
}
