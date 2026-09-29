import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';

/** Whoever the home is acting for: a Clerk user, or the local dev boss. */
export interface Boss {
  readonly email: string | undefined;
  readonly firstName: string | undefined;
}

/** One employee as `agents.rosterForUser` returns it. */
export type RosterRow = FunctionReturnType<typeof api.agents.rosterForUser>[number];

/** The needs-you inbox as `work.needsYou` returns it. */
export type NeedsYouInbox = FunctionReturnType<typeof api.work.needsYou>;

/** One entry of the needs-you inbox. */
export type NeedsYouEntry = NeedsYouInbox['entries'][number];
