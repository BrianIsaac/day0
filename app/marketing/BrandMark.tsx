/**
 * Day0's mark, drawn inline beside the wordmark: the geometry of `app/icon.svg` (a 16-unit grid,
 * the antenna, the head and the two eyes), with the head in the accent and the eyes cut in the
 * page colour so it reads on the header in either theme the tokens define.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true" focusable="false" className={className}>
      <g className="fill-[var(--color-accent)]">
        <rect x="7" y="0" width="2" height="5" rx="1" />
        <rect x="1" y="4" width="14" height="11" rx="3.5" />
      </g>
      <g className="fill-[var(--color-bg)]">
        <rect x="3" y="8" width="4" height="3" rx="0.75" />
        <rect x="9" y="8" width="4" height="3" rx="0.75" />
      </g>
    </svg>
  );
}
