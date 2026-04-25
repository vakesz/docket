import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProposeComment } from "~/api/hooks";
import { MarkdownEditor } from "~/components/common/MarkdownEditor";
import { xsAccentButtonClass, xsBorderButtonClass } from "~/lib/formClasses";

interface Props {
  itemId: string;
  onStaged: (proposal: DTO["ProposalDTO"]) => void;
}

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
        <MarkdownEditor
          value={value}
          onChange={setValue}
          height="140px"
          placeholder="Write a comment in markdown…"
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
          className={xsBorderButtonClass}
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
          className={xsAccentButtonClass}
        >
          {propose.isPending ? "Staging…" : "Stage comment"}
        </button>
      </div>
    </div>
  );
}
