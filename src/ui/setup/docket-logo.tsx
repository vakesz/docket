/**
 * Inline Docket mark — same shape as `src/app/icon.svg` so the favicon and
 * the welcome splash render identically. Outline-style circular badge: the
 * ring is the unified container, five nodes around it stand for any
 * provider (filled = active, outlined = available), and three hairline
 * spokes show which providers are currently feeding the docket. Single
 * semantic tone (`fg`) so it works on every palette.
 *
 * `size` sets explicit `width`/`height` attributes on the svg in pixels —
 * bypasses Tailwind entirely so the rendered size never depends on JIT
 * compilation timing. `className` is still accepted for callers that want
 * scale classes (`h-20 w-20` etc.); CSS overrides the attributes when both
 * are present.
 */
export function DocketLogo({ size, className }: { size?: number; className?: string }) {
  const dim = size ?? 64;
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 64 64"
      width={dim}
      height={dim}
      fill="none"
      role="img"
      aria-label="Docket"
      className={className}
    >
      <circle cx="32" cy="32" r="26" className="stroke-foreground" strokeWidth="3.5" />

      <line x1="32" y1="10.5" x2="32" y2="16" className="stroke-foreground" strokeWidth="1.25" />
      <line
        x1="44.64"
        y1="49.39"
        x2="41.4"
        y2="44.94"
        className="stroke-foreground"
        strokeWidth="1.25"
      />
      <line
        x1="19.36"
        y1="49.39"
        x2="22.6"
        y2="44.94"
        className="stroke-foreground"
        strokeWidth="1.25"
      />

      <circle cx="32" cy="6" r="4.5" className="fill-foreground" />
      <circle cx="56.73" cy="23.97" r="4" className="stroke-foreground" strokeWidth="1.75" />
      <circle cx="47.28" cy="53.03" r="4.5" className="fill-foreground" />
      <circle cx="16.72" cy="53.03" r="4" className="stroke-foreground" strokeWidth="1.75" />
      <circle cx="7.27" cy="23.97" r="4.5" className="fill-foreground" />

      <rect x="21" y="25.75" width="22" height="2.5" rx="1.25" className="fill-foreground" />
      <rect x="21" y="31.5" width="22" height="2.5" rx="1.25" className="fill-foreground" />
      <rect x="21" y="37.25" width="14" height="2.5" rx="1.25" className="fill-foreground" />
    </svg>
  );
}
