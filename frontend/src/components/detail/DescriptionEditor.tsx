import CodeMirror from "@uiw/react-codemirror";
import { markdown } from "@codemirror/lang-markdown";
import { useState } from "react";

import { useProposeDescription } from "~/api/hooks";
import type { DTO } from "~/api/client";

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
      <div className="overflow-hidden rounded border border-zinc-200 dark:border-zinc-800">
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
          className="rounded border border-zinc-200 px-3 py-1 text-xs hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900"
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
          className="rounded bg-accent px-3 py-1 text-xs font-semibold text-white hover:bg-accent/90 disabled:opacity-50"
        >
          {propose.isPending ? "Staging…" : "Stage edit"}
        </button>
      </div>
    </div>
  );
}
