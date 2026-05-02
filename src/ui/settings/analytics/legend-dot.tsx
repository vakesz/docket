"use client";

export function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={`inline-block h-2 w-3 rounded ${color}`}
        style={
          dashed
            ? {
                backgroundImage:
                  "repeating-linear-gradient(90deg, currentColor 0 4px, transparent 4px 7px)",
              }
            : undefined
        }
      />
      {label}
    </span>
  );
}
