import type { OneToOnePhase } from '@/agent/one-to-one-phase';
import type { Ref } from 'react';
import { Button } from '../../../components/Button';
import type { CharterSynthesisOutcome } from '../charter-synthesis';

/** Where the room's own post of the transcript stands. */
export type SynthesisPost =
  | { readonly kind: 'idle' }
  | { readonly kind: 'posting' }
  | { readonly kind: 'settled'; readonly outcome: CharterSynthesisOutcome };

/** What the drafting line says, and whether it is news that needs the manager. */
export interface DraftingWords {
  readonly failed: boolean;
  readonly lead: string;
  readonly detail: string;
}

/**
 * What to say while the charter drafts, from the session's phase and the room's post.
 *
 * The session outranks the post: a post that failed after its claim was released is retried by
 * the deployment, and the session says so. The draft has failed only once the session's retries
 * are spent, or when the post never reached a session to retry (a transport failure, a refusal
 * before the claim).
 *
 * @param name - The employee's name.
 */
export function draftingWords(
  name: string,
  phase: OneToOnePhase,
  post: SynthesisPost,
): DraftingWords {
  // The session's own reason is the provider's text, kept on the row and in the record for
  // whoever reads the logs; the page says what happened in words of its own (C-34).
  if (phase.kind === 'failed') {
    return {
      failed: true,
      lead: 'The charter could not be drafted: every attempt ended without a usable draft.',
      detail: 'Draft it again from what you said, or hold the one-to-one again.',
    };
  }
  const outcome = post.kind === 'settled' ? post.outcome : undefined;
  const serverDrafting = phase.kind === 'drafting' || phase.kind === 'drafted';
  if (outcome && !outcome.ok && !outcome.late && !serverDrafting) {
    return {
      failed: true,
      lead: `The charter could not be drafted: ${outcome.reason}.`,
      detail: 'Nothing you said is lost. Draft it again when you are ready.',
    };
  }
  const retrying = phase.kind === 'drafting' ? phase.retrying : undefined;
  return {
    failed: false,
    lead: 'Drafting your charter, usually under a minute.',
    detail: retrying
      ? `The last attempt did not finish, so ${name} is trying again.`
      : outcome && !outcome.ok && outcome.late
        ? 'It has taken longer than usual. It carries on, and the charter opens here when it is ready.'
        : 'Your answers are kept beside it, so you can re-read what you said while you review.',
  };
}

/**
 * The line that names what happens after the one-to-one and how long it usually takes, or, when
 * the draft failed, why, with the ways on. Its words are its own live region, mounted (empty and
 * visually hidden) while the one-to-one is still open, so a screen reader says the line as it
 * appears and the page carries it once (the v0.19.0 walk's finding 8: a second, hidden region
 * repeated it). It takes focus when the control that led to it has left the page.
 *
 * @param open - Whether the one-to-one is over, so the line is drawn; closed, the region waits empty.
 * @param onHoldAgain - Offered only once the session has failed for good.
 */
export function DraftingNotice({
  name,
  phase,
  post,
  open = true,
  onDraftAgain,
  onHoldAgain,
  focusRef,
}: {
  name: string;
  phase: OneToOnePhase;
  post: SynthesisPost;
  open?: boolean;
  onDraftAgain: () => void;
  onHoldAgain: () => void;
  focusRef?: Ref<HTMLDivElement>;
}) {
  const words = open ? draftingWords(name, phase, post) : null;
  const failed = words?.failed === true;
  const box =
    words === null
      ? undefined
      : failed
        ? 'grid gap-3 rounded-lg border border-[var(--color-warn-line)] outline-none bg-[var(--color-warn-soft)] px-3.5 py-3 text-[15px]'
        : 'rounded-lg border border-[var(--color-accent-line)] outline-none bg-[var(--color-accent-soft)] px-3.5 py-3 text-[15px] text-[var(--color-accent)]';
  return (
    <div
      ref={focusRef}
      tabIndex={words === null ? undefined : -1}
      data-drafting={words === null ? undefined : failed ? 'failed' : 'drafting'}
      className={box}
    >
      <p role="status" aria-live="polite" aria-atomic="true" className="empty:sr-only">
        {words === null ? null : failed ? (
          <>
            <span className="text-[var(--color-warn)]">{words.lead}</span>{' '}
            <span className="text-[var(--color-fg-2)]">{words.detail}</span>
          </>
        ) : (
          <>
            <span className="text-[var(--color-fg)]">{words.lead}</span> {words.detail}
          </>
        )}
      </p>
      {failed ? (
        <div className="flex flex-wrap gap-2">
          <Button variant="retry" onClick={onDraftAgain} disabled={post.kind === 'posting'}>
            Draft again
          </Button>
          {phase.kind === 'failed' ? (
            <Button onClick={onHoldAgain}>Hold the one-to-one again</Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
