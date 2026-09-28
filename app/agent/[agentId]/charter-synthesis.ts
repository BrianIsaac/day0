import type { Id } from '@convex/_generated/dataModel';

/** What the synthesis route takes: the 1:1's transcript, who the manager is, and the session it ends. */
export interface CharterSynthesisRequest {
  readonly agentId: Id<'agents'>;
  readonly bossLabel: string;
  readonly transcript: string;
  /** Naming the session is what ends it, through the same claim-once finalisation as a call. */
  readonly voiceSessionId: Id<'voiceSessions'> | null;
}

/**
 * Post a finished 1:1 for charter synthesis without waiting on it. Each room
 * latches its own call, so the post goes once per 1:1.
 *
 * A failed post shows as the charter card staying at its draft, where the
 * manager retries (P10-3 names the retry as its own step). That holds for a
 * refusal status, which resolves, and for a transport failure, which rejects:
 * the rejection is dropped here for that reason, so it never surfaces as an
 * unhandled one while the page is being torn down around it.
 */
export function postCharterSynthesis(request: CharterSynthesisRequest): void {
  void fetch('/api/onboarding/synthesise', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
  }).catch((): void => undefined);
}
