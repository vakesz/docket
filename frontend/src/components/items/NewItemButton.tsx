import { Plus } from "lucide-react";

import { cn } from "~/lib/cn";

interface Props {
  disabled?: boolean;
  disabledReason?: string;
  onClick: () => void;
  className?: string;
}

export function NewItemButton({ disabled, disabledReason, onClick, className }: Props) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={disabled ? (disabledReason ?? "Disabled") : "Create a new work item"}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-xl bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg hover:bg-accent/90 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      <Plus className="h-3.5 w-3.5" />
      New item
    </button>
  );
}
