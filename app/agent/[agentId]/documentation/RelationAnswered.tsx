'use client';

import { useEffect, useRef } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { StatusRegion } from '../../../components/StatusRegion';
import { focusIsFree, useChange } from '../../../components/use-change';

/** What the manager last answered on a relation's card, kept by the tab once the card has gone. */
export interface AnsweredRelation {
  readonly relationId: Id<'docRelations'>;
  /** What the answer did, in the card's words. */
  readonly text: string;
  /**
   * Whether the answer is taken back from here (`docRelations.decisionsOffered`): every answer
   * but a conflict's "{A} is right", which the superseded page's own row takes back.
   */
  readonly undo: boolean;
}

/**
 * The manager's last answer on a relation's card, said where the card was (the wave file's
 * section 8, and the second pass's major 1): an answered card leaves the tab, so its outcome and
 * the way back are kept here. "Undo" makes the relation a proposal again, and its card returns
 * with every answer it offered.
 *
 * @param answered - The answer, as the card reported it.
 * @param cardGone - Whether the answered card has left the tab, so focus has nowhere to be.
 * @param onUndone - Told once the answer is taken back, with what to say of it.
 */
export function RelationAnswered({
  answered,
  cardGone,
  onUndone,
}: {
  answered: AnsweredRelation;
  cardGone: boolean;
  onUndone: (text: string) => void;
}) {
  const decide = useMutation(api.docRelations.decide);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  // The button the manager pressed went with its card: focus comes here, beside Undo, unless
  // the manager has already moved it elsewhere.
  useEffect((): void => {
    if (cardGone && focusIsFree(null)) card.current?.focus();
  }, [cardGone, answered.relationId]);
  return (
    <Card title="Your answer" focusRef={card}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p role="status" aria-live="polite" className="text-sm text-[var(--color-fg-2)]">
          {answered.text}
        </p>
        {answered.undo ? (
          <Button
            size="small"
            variant="quiet"
            disabled={change.busy}
            onClick={() =>
              change.run(() => decide({ relationId: answered.relationId, decision: 'undo' }), {
                done: '',
                refused: 'The answer was not taken back.',
                after: () => onUndone('Taken back. The card asks again.'),
              })
            }
          >
            Undo
          </Button>
        ) : null}
      </div>
      {change.outcome?.tone === 'refused' ? <StatusRegion outcome={change.outcome} /> : null}
    </Card>
  );
}
