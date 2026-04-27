/**
 * Inline Docket mark — same shape as `src/app/icon.svg` so the favicon and
 * the welcome splash render identically. Two semantic tones (`fg`/`bg`)
 * pick up the active theme so it works on every palette.
 */
export function DocketLogo({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      fill="none"
      role="img"
      aria-label="Docket"
      className={className}
    >
      <rect width="64" height="64" rx="14" className="fill-fg" />
      <rect x="14" y="14" width="36" height="42" rx="4" className="fill-bg" />
      <rect x="26" y="8" width="12" height="8" rx="2" className="fill-fg" />
      <rect x="20" y="26" width="24" height="3" rx="1.5" className="fill-fg" />
      <rect x="20" y="34" width="24" height="3" rx="1.5" className="fill-fg" />
      <rect x="20" y="42" width="16" height="3" rx="1.5" className="fill-fg" />
    </svg>
  );
}
