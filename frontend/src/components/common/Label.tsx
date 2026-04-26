import type { ReactNode } from "react";

import { cn } from "~/lib/cn";
import { metaLabelClass } from "~/lib/formClasses";

export function Label({ children, required }: { children: ReactNode; required?: boolean }) {
  return (
    <span className={cn(metaLabelClass)}>
      {children}
      {required && <span className="ml-1 text-danger">*</span>}
    </span>
  );
}
