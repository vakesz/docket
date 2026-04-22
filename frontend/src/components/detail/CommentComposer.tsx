import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProposeComment } from "~/api/hooks";
import { docketCodeMirrorTheme } from "~/lib/cmTheme";

interface Props {
  itemId: string;
  onStaged: (proposal: DTO["ProposalDTO"]) => void;
}

/**
 * Manual comment composer. Stages a `comment_add` proposal that the user
 * confirms via the existing `ProposalCard` flow — keeps the proposal-first
 * invariant intact (no direct provider write from a surface).
 */
export function CommentComposer({ itemId, onStaged }: Props) {
  const [value, setValue] = useState("");
  const [open, setOpen] = useState(false);
  const propose = useProposeComment();
  const trimmed = value.trim();
  const canStage = trimmed.length > 0 && !propose.isPending;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="self-start rounded border border-border px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-fg-muted hover:bg-surface-alt"
      >
        Add comment
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded border border-border">
        <CodeMirror
          value={value}
          height="140px"
          theme="none"
          extensions={[markdown(), ...docketCodeMirrorTheme()]}
          onChange={setValue}
          placeholder="Write a comment in markdown…"
          basicSetup={{ lineNumbers: false, foldGutter: false }}
        />
      </div>
      {propose.error && <p className="text-xs text-danger">{(propose.error as Error).message}</p>}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setValue("");
            setOpen(false);
            propose.reset();
          }}
          className="rounded border border-border px-3 py-1 text-xs text-fg hover:bg-surface-alt"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!canStage}
          onClick={() =>
            propose.mutate(
              { itemId, bodyMd: trimmed },
              {
                onSuccess: (p) => {
                  onStaged(p);
                  setValue("");
                  setOpen(false);
                },
              },
            )
          }
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-accent-fg hover:bg-accent/90 disabled:opacity-50"
        >
          {propose.isPending ? "Staging…" : "Stage comment"}
        </button>
      </div>
    </div>
  );
}
