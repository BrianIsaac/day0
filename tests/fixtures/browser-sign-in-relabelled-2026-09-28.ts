/**
 * The tile's sign-in page after a redesign that relabels its button, the case
 * pass 9 executed against the recorded page (P8-5): with `button "Sign in"`
 * gone, the only element named "Sign in" is the heading, and a click that
 * resolved to it returned `ok: true` and was counted as a completed sign-in.
 */
import { SIGN_IN_PAGE } from './browser-phase-split-2026-09-16';

/** The recorded sign-in page with its button relabelled `Log in` and nothing else changed. */
export const RELABELLED_SIGN_IN_PAGE = SIGN_IN_PAGE.replace(
  'button "Sign in" [ref=e15]',
  'button "Log in" [ref=e15]',
);
