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
 * How long the room waits on the post before saying drafting is taking longer than usual. Two
 * model calls usually take under a minute; the draft carries on past this on the server.
 */
export const SYNTHESIS_DEADLINE_MS = 90_000;

/**
 * What became of the post: accepted (the charter is written, or being written by a finisher that
 * got there first), or not, with why. `late` marks a post the room stopped waiting for, whose
 * draft may still land.
 */
export type CharterSynthesisOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly late: boolean };

/** The sentence the route answered a refusal with, else one naming the status. */
async function refusalOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === 'string' && body.error.trim()) return body.error.trim();
  } catch {
    // Not JSON: the status is all there is to say.
  }
  return `the drafting service answered ${response.status}`;
}

/** A post the deadline stopped, said in whole seconds. */
function lateBy(deadlineMs: number): CharterSynthesisOutcome {
  return {
    ok: false,
    late: true,
    reason: `drafting has taken longer than ${Math.round(deadlineMs / 1000)} seconds`,
  };
}

/**
 * Post a finished 1:1 for charter synthesis and say what became of it. Each room latches its own
 * call, so the post goes once per 1:1 unless the manager asks for it again.
 *
 * It never rejects. A refusal, a transport failure and the deadline each come back as a failure
 * the room shows beside the transcript; the session keeps what it was given either way, and a
 * claim the server released is re-driven by the deployment (`voice.releaseFinalisation`), so the
 * draft can still land while the room says it did not.
 *
 * @param deadlineMs - How long to wait for the route; the room's default is `SYNTHESIS_DEADLINE_MS`.
 */
export async function postCharterSynthesis(
  request: CharterSynthesisRequest,
  deadlineMs: number = SYNTHESIS_DEADLINE_MS,
): Promise<CharterSynthesisOutcome> {
  // The deadline runs on the page's own clock (a timer, not `AbortSignal.timeout`), so it is the
  // one clock the room and its tests both read.
  const deadline = new AbortController();
  let late = false;
  const timer = setTimeout((): void => {
    late = true;
    deadline.abort();
  }, deadlineMs);
  try {
    const response = await fetch('/api/onboarding/synthesise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal: deadline.signal,
    });
    if (response.ok) return { ok: true };
    // The refusal's body is read under the same deadline: a body that stalls is a late post.
    const reason = await refusalOf(response);
    return late ? lateBy(deadlineMs) : { ok: false, late: false, reason };
  } catch {
    // Either the deadline aborted the post or the page could not reach Day0; `late` says which.
    return late
      ? lateBy(deadlineMs)
      : { ok: false, late: false, reason: 'the page could not reach Day0' };
  } finally {
    clearTimeout(timer);
  }
}
