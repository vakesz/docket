import { markdown } from "@codemirror/lang-markdown";
import CodeMirror from "@uiw/react-codemirror";
import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProposeDescription } from "~/api/hooks";

interface Props {
  itemId: string;
  initial: string;
  onStaged: (proposal: DTO["ProposalDTO"]) => void;
  onClose: () => void;
}

export function DescriptionEditor({ itemId, initial, onStaged, onClose }: Props) {
  const [value, setValue] = useState(initial);
  const propose = useProposeDescription();
  const dirty = value !== initial;

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded border border-border">
        <CodeMirror
          value={value}
          height="240px"
          theme="dark"
          extensions={[markdown()]}
          onChange={setValue}
          basicSetup={{ lineNumbers: false, foldGutter: false }}
        />
      </div>
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-border px-3 py-1 text-xs text-fg hover:bg-surface-alt"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={!dirty || propose.isPending}
          onClick={() =>
            propose.mutate(
              { itemId, newDescriptionMd: value },
              {
                onSuccess: (p) => {
                  onStaged(p);
                  onClose();
                },
              },
            )
          }
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-accent-fg hover:bg-accent/90 disabled:opacity-50"
        >
          {propose.isPending ? "Staging…" : "Stage edit"}
        </button>
      </div>
    </div>
  );
}
