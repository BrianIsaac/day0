'use client';

import { useRef, useState } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import type { SentBackOutcome } from '../employee-context';

/** The most characters a note may carry; the server holds the same bound. */
export const CHANGES_NOTE_MAX_CHARS = 2000;

/** The id the card's "Ask for changes" link goes to. */
export const CHANGES_REQUEST_ID = 'charter-changes';

/** What the card says once the manager sends its draft back with nothing to redraft from. */
export const SENT_BACK = 'Charter sent back: this draft is withdrawn.';

/**
 * "Ask for changes" (round two section 3.5): a note in the manager's words, and the draft sent back
 * with it. Where the one-to-one's transcript was kept, the employee redrafts from it and the note;
 * where none was, the draft is withdrawn and the one-to-one opens again.
 *
 * @param hasTranscript - Whether the draft's transcript is kept; undefined while it loads.
 * @param onSentBack - Told which draft went, so the page can say what follows it.
 */
export function ChangesRequest({
  charter,
  name,
  hasTranscript,
  onSentBack,
}: {
  charter: Doc<'charters'>;
  name: string;
  hasTranscript: boolean | undefined;
  onSentBack?: (charterId: Id<'charters'>, outcome: SentBackOutcome) => void;
}) {
  const requestChanges = useMutation(api.charters.requestChanges);
  const form = useRef<HTMLFormElement>(null);
  const change = useChange(form);
  const [note, setNote] = useState('');
  const redraft = hasTranscript !== false;
  const reason = note.trim();

  function send(): void {
    change.run(() => requestChanges({ charterId: charter._id, reason }), {
      done: (result) =>
        result.redrafting
          ? `Sent back: ${name} is redrafting from your one-to-one and your note.`
          : SENT_BACK,
      refused: 'The charter was not sent back.',
      after: (result) => onSentBack?.(charter._id, { redrafting: result.redrafting }),
    });
  }

  return (
    <form
      ref={form}
      id={CHANGES_REQUEST_ID}
      tabIndex={-1}
      aria-labelledby={`${CHANGES_REQUEST_ID}-title`}
      className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]"
      onSubmit={(e) => {
        e.preventDefault();
        send();
      }}
    >
      <div className="border-b border-[var(--color-border)] px-4 py-3.5 sm:px-5">
        <h2 id={`${CHANGES_REQUEST_ID}-title`} className="text-[15px] font-semibold">
          Ask {name} for changes
        </h2>
      </div>
      <div className="grid gap-3 p-4 sm:p-5">
        <Field
          label="What should change"
          hint={
            redraft
              ? `${name} redrafts from your transcript and this note. Nothing you said is thrown away.`
              : 'No transcript was kept for this draft, so the one-to-one opens again; the note goes on the record.'
          }
        >
          {(control) => (
            <textarea
              {...control}
              rows={4}
              value={note}
              maxLength={CHANGES_NOTE_MAX_CHARS}
              disabled={change.busy}
              placeholder="For example: the 30-day goal should name the committee deck."
              onChange={(e) => setNote(e.target.value)}
              className={`${INPUT_CLASS} w-full resize-y py-2`}
            />
          )}
        </Field>
        <div>
          <Button
            type="submit"
            variant={redraft ? 'retry' : 'secondary'}
            disabled={change.busy || (redraft && reason === '')}
          >
            {redraft ? 'Send and redraft' : 'Send back'}
          </Button>
        </div>
        <StatusRegion outcome={change.outcome} />
      </div>
    </form>
  );
}
