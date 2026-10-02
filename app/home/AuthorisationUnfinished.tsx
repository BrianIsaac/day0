'use client';

import { useSearchParams } from 'next/navigation';

/** The parameter the MCP redirect's landing names its outcome by (`mcpAuthorisationLanding`). */
const AUTHORISATION_PARAMETER = 'authorisation';

/**
 * What the home says when an MCP authorisation sends the browser back to it unfinished: someone
 * other than the card's manager consented, a link was stale, or the deployment could not be asked
 * (the wave 11 review's M2). It never repeats the address's own words, which anyone can write.
 */
export const AUTHORISATION_UNFINISHED =
  "That authorisation was not finished, so nothing was connected. Only the employee's manager, signed in to Day0, finishes it, from the employee's card.";

/**
 * The home's line for an authorisation that came back unfinished, or nothing when the home was
 * opened any other way.
 */
export function AuthorisationUnfinished() {
  const outcome = useSearchParams().get(AUTHORISATION_PARAMETER);
  if (outcome !== 'failed' && outcome !== 'invalid') return null;
  return (
    <p role="status" className="mt-3 max-w-2xl text-sm text-[var(--color-warn)]">
      {AUTHORISATION_UNFINISHED}
    </p>
  );
}
