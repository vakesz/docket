import type { ReactNode } from "react";

import { HelpText } from "./FormInputs";
import { Label } from "./Label";

export function FormField({
  label,
  help,
  required,
  children,
}: {
  label: string;
  help?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label required={required}>{label}</Label>
      {children}
      {help && <HelpText>{help}</HelpText>}
    </div>
  );
}

export function FieldError({ children }: { children: ReactNode }) {
  return <span className="text-xs text-danger-fg">{children}</span>;
}
