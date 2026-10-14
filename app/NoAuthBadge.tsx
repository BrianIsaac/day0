/**
 * The header's badge on a no-auth install, in the account controls' place. It stays on one line:
 * at 390 px, beside the mark and the Documentation link, its letter-spaced capitals broke over two
 * (17-J's W5, 18-D's F5), so below the small breakpoint its letter spacing and padding tighten
 * and the line never breaks; from it up the badge is as it was.
 */
export function NoAuthBadge(): React.ReactElement {
  return (
    <span
      className="whitespace-nowrap rounded-md border border-[var(--color-warn)]/40 bg-[var(--color-warn)]/10 px-2 py-1 text-xs uppercase tracking-[0.06em] text-[var(--color-warn)] sm:px-2.5 sm:tracking-[0.18em]"
      title="NEXT_PUBLIC_DEV_NO_AUTH is on: Clerk is skipped and every request runs as one local boss. Development only."
    >
      No-auth dev mode
    </span>
  );
}
