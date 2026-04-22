import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProposeComment } from "~/api/hooks";

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
        className="self-start rounded border border-zinc-200 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-zinc-600 hover:bg-zinc-50 dark:border-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-900"
      >
        Add comment
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
        <CodeMirror
          value={value}
          height="140px"
          theme="dark"
          extensions={[markdown()]}
          onChange={setValue}
          placeholder="Write a comment in markdown…"
          basicSetup={{ lineNumbers: false, foldGutter: false }}
        />
      </div>
      {propose.error && (
        <p className="text-xs text-rose-600 dark:text-rose-400">
          {(propose.error as Error).message}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => {
            setValue("");
            setOpen(false);
            propose.reset();
          }}
          className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
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
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {propose.isPending ? "Staging…" : "Stage comment"}
        </button>
      </div>
    </div>
  );
}
