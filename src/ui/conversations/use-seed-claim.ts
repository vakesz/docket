"use client";

import { useEffect } from "react";
import { useChatPaneController } from "@/ui/conversations/chat-pane-context";

type SeedClaimArgs = {
  /** Resolved item id; effect bails until the URL → id resolve completes. */
  itemId: string | null;
  /** True while a previous turn is still streaming — defer the claim. */
  inFlight: boolean;
  /** Invoked with the seed string on the single tab that wins the claim. */
  onSeed: (seed: string) => void | Promise<void>;
};

/**
 * Consume a queued "Suggest next action" seed: the suggest-button stages
 * a one-shot prompt via `requestOpenWithSeed`; this hook claims it on the
 * next render and hands it to the caller's submit path. Two ChatPanes can
 * be momentarily mounted (e.g. desktop layout + mobile drawer during a
 * viewport transition) so the underlying `claimSeed` is ref-backed and
 * atomic — only the first effect to fire gets the string back, the
 * loser reads `null` and renders nothing.
 *
 * The hook never starts new conversations on its own; it forwards the
 * seed to the caller, which decides how to dispatch it (typically: open
 * a fresh thread + submit). Bails while `inFlight` so a still-streaming
 * prior turn isn't interrupted.
 */
export function useSeedClaim({ itemId, inFlight, onSeed }: SeedClaimArgs): void {
  const { pendingSeed, claimSeed } = useChatPaneController();

  // biome-ignore lint/correctness/useExhaustiveDependencies: pendingSeed is the trigger; the rest is captured.
  useEffect(() => {
    if (!pendingSeed) return;
    if (inFlight) return;
    if (itemId === null) return;
    const seed = claimSeed();
    if (seed === null) return;
    void onSeed(seed);
  }, [pendingSeed, inFlight, itemId]);
}
