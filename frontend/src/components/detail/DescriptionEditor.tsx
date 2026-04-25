import { useState } from "react";
import type { DTO } from "~/api/client";
import { useProposeDescription } from "~/api/hooks";
import { MarkdownEditor } from "~/components/common/MarkdownEditor";
import { xsAccentButtonClass, xsBorderButtonClass } from "~/lib/formClasses";

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
        <MarkdownEditor value={value} onChange={setValue} height="240px" />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onClose} className={xsBorderButtonClass}>
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
          className={xsAccentButtonClass}
        >
          {propose.isPending ? "Staging…" : "Stage edit"}
        </button>
      </div>
    </div>
  );
}
