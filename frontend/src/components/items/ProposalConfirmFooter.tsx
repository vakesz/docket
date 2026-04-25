import type { DTO } from "~/api/client";
import { outlineButtonClass, primaryButtonClass } from "~/lib/formClasses";

interface Props {
  proposal: DTO["ProposalDTO"] | null;
  canStage: boolean;
  canCreate: boolean;
  staging: boolean;
  creating: boolean;
  onCancel: () => void;
  onBackToEdit: () => void;
  onStage: () => void;
  onConfirm: () => void;
}

export function ProposalConfirmFooter({
  proposal,
  canStage,
  canCreate,
  staging,
  creating,
  onCancel,
  onBackToEdit,
  onStage,
  onConfirm,
}: Props) {
  if (proposal) {
    return (
      <>
        <button type="button" onClick={onBackToEdit} className={outlineButtonClass}>
          Back to edit
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!canCreate}
          className={primaryButtonClass}
        >
          {creating ? "Creating…" : "Create item"}
        </button>
      </>
    );
  }

  return (
    <>
      <button type="button" onClick={onCancel} className={outlineButtonClass}>
        Cancel
      </button>
      <button
        type="button"
        onClick={onStage}
        disabled={!canStage}
        title="Ctrl/Cmd+S"
        className={primaryButtonClass}
      >
        {staging ? "Staging…" : "Stage proposal"}
      </button>
    </>
  );
}
