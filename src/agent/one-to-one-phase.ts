import type { Doc } from '../../convex/_generated/dataModel';

/**
 * How many times the deployment re-drives one session's finalisation on its own before it stops
 * and says so. Each attempt costs two model calls, so a model failing for a reason time will not
 * fix must stop costing them.
 */
export const MAX_FINALISATION_RECOVERIES = 3;

/** What of a session the one-to-one's phase is read from. */
export type OneToOneSession = Pick<
  Doc<'voiceSessions'>,
  'state' | 'pendingTranscript' | 'finalisationError' | 'recoveryAttempts'
>;

/**
 * Where the Day-1 one-to-one stands, as its rooms show it.
 *
 * - `talking`: the conversation is open, or has not begun.
 * - `drafting`: a transcript was accepted and the charter is being written from it; `retrying`
 *   names why the last attempt did not finish when the deployment is trying again.
 * - `failed`: every attempt the deployment makes on its own is spent; `reason` is the last one.
 * - `drafted`: the session produced a charter.
 */
export type OneToOnePhase =
  | { readonly kind: 'talking' }
  | { readonly kind: 'drafting'; readonly retrying?: string }
  | { readonly kind: 'failed'; readonly reason: string }
  | { readonly kind: 'drafted' };

/**
 * Read the one-to-one's phase off its session row.
 *
 * A session holds a transcript to draft from (`pendingTranscript`) from the moment a finisher
 * claims it: the room's own post, the call's webhook, the deployment's re-drive, or a draft sent
 * back with a note. Until a finisher commits, the one-to-one is drafting whichever state the row
 * is in, because a released claim puts the row back to `active` while a retry is already
 * scheduled. Only a session with attempts spent and nothing scheduled has failed.
 *
 * @param session - The employee's newest session, or null before the one-to-one opens.
 */
export function oneToOnePhase(session: OneToOneSession | null | undefined): OneToOnePhase {
  if (!session) return { kind: 'talking' };
  switch (session.state) {
    case 'done':
      return { kind: 'drafted' };
    case 'synthesising':
      return { kind: 'drafting' };
    case 'pending':
    case 'active':
      if (!session.pendingTranscript) return { kind: 'talking' };
      if (!session.finalisationError) return { kind: 'drafting' };
      return (session.recoveryAttempts ?? 0) < MAX_FINALISATION_RECOVERIES
        ? { kind: 'drafting', retrying: session.finalisationError }
        : { kind: 'failed', reason: session.finalisationError };
    case 'failed':
      return { kind: 'failed', reason: session.finalisationError ?? 'the session failed' };
  }
}
