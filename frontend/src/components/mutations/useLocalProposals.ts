import { useCallback, useState } from "react";
import type { DTO } from "~/api/client";

type Proposal = DTO["ProposalDTO"];

export interface LocalProposalsApi {
  proposals: Proposal[];
  push: (p: Proposal) => void;
  pushMany: (list: Proposal[]) => void;
  dismiss: (id: string) => void;
  reset: () => void;
}

/** Track an in-pane proposal queue with id-keyed dedup on push.
 *
 * Both ChatPane and ItemDetail surface staged proposals as cards next to the
 * source UI, so they share the same lifecycle: staged proposals append (with
 * dedup so the agent restaging the same id replaces in place), confirm/reject
 * dismisses, and switching item / starting a new thread resets. */
export function useLocalProposals(): LocalProposalsApi {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const push = useCallback((p: Proposal) => {
    setProposals((prev) => [...prev.filter((x) => x.id !== p.id), p]);
  }, []);
  const pushMany = useCallback((list: Proposal[]) => {
    setProposals((prev) => [...prev, ...list]);
  }, []);
  const dismiss = useCallback((id: string) => {
    setProposals((prev) => prev.filter((p) => p.id !== id));
  }, []);
  const reset = useCallback(() => {
    setProposals([]);
  }, []);
  return { proposals, push, pushMany, dismiss, reset };
}
