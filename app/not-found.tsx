import type { Metadata } from 'next';
import { ButtonLink } from './components/Button';

/** The tab's title for an address Day0 does not have. */
export const metadata: Metadata = { title: 'Not found · Day0' };

/**
 * The page for an address Day0 does not have, drawn in the app's own frame inside the layout's
 * `<main>` rather than as Next's unstyled default: what happened, and the one way back.
 */
export default function NotFound() {
  return (
    <div className="mx-auto grid w-full max-w-7xl justify-items-start gap-3 px-4 py-10 sm:px-6">
      <h1 className="text-2xl font-semibold tracking-[-0.02em]">This page is not here</h1>
      <p className="text-[var(--color-fg-2)]">
        The address may be mistyped, or the page has moved.
      </p>
      <ButtonLink href="/" variant="text">
        Back to Day0
      </ButtonLink>
    </div>
  );
}
