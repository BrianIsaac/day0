'use client';

import { useRef } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { SOURCE_AUTHORITIES, type SourceAuthority } from '@/docs/authority';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { StatusRegion } from '../../../components/StatusRegion';
import { useChange } from '../../../components/use-change';
import type { AnsweredRelation } from './RelationAnswered';
import type { RelationAnswer, RelationCardRow } from './RelationCard';

/** A source's trust inside a sentence: "an official" source, "a team" one. */
const TRUST_SOURCE: Readonly<Record<SourceAuthority, string>> = {
  official: 'an official',
  team: 'a team',
  personal: 'a personal',
};

/**
 * The card for two pages that disagree (the wave file's section 8). A conflict the measures
 * proposed says the two "may disagree" and holds nothing; the manager confirms it ("They
 * disagree") or settles it at once. A confirmed conflict is the one the employee holds steps for:
 * a plan that follows the disputed passage waits until the manager says which page is right or
 * that both hold. Between two pages that are not trusted alike no conflict stands and nothing is
 * ever held, so the card says how the two are weighed and offers only the answers that settle it.
 *
 * @param relation - The conflict, with the heading and the figures each page gives.
 * @param name - The employee's name, when the card is on an employee's tab.
 * @param onAnswered - Told an answer that takes the card off the tab, once it is recorded, so
 *   the tab says the outcome and the way back; "They disagree" keeps the card, which says it.
 */
export function ConflictCard({
  relation,
  name,
  onAnswered,
}: {
  relation: RelationCardRow;
  name?: string;
  onAnswered?: (answered: AnsweredRelation) => void;
}) {
  const decide = useMutation(api.docRelations.decide);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const { from, to, disagreement } = relation;
  const confirmed = relation.status === 'confirmed';
  const answer = (decision: RelationAnswer, done: string): void =>
    change.run(() => decide({ relationId: relation._id, decision }), {
      done,
      refused: 'The answer was not recorded.',
      after: () => {
        if (decision === 'disagree') return;
        // "Both hold" is taken back from the tab; "{A} is right" on the superseded page's row.
        const undo = decision === 'both-hold';
        onAnswered?.({
          relationId: relation._id,
          text: undo ? done : `${done} “This is current” on its row takes that back.`,
          undo,
        });
      },
    });
  // Named most trusted first: the selection weighs that page above the other.
  const [more, less] =
    SOURCE_AUTHORITIES.indexOf(from.authority) <= SOURCE_AUTHORITIES.indexOf(to.authority)
      ? [from, to]
      : [to, from];
  const reader = name ?? 'each employee';
  const held = confirmed
    ? `${name ?? 'Each employee'} holds any step that relies on it and asks you.`
    : from.authority === to.authority
      ? 'Nothing is held until you say they disagree.'
      : `Nothing is held for it: “${more.title}” is in ${TRUST_SOURCE[more.authority]} source and “${less.title}” in ${TRUST_SOURCE[less.authority]} one, so ${reader} weighs the first above the second. Say which is right to take the other out of what ${reader} reads.`;
  const under = disagreement ? ` under “${disagreement.heading}”` : '';
  const figures = disagreement
    ? `: ${disagreement.figures.from} against ${disagreement.figures.to}`
    : '';
  return (
    <Card
      title={confirmed ? 'Two pages disagree' : 'These two pages may disagree'}
      tone={confirmed ? 'danger' : 'warn'}
      focusRef={card}
    >
      <div className="grid gap-3">
        <p className="text-sm text-[var(--color-fg-2)]">
          “{from.title}” ({from.source}) and “{to.title}” ({to.source}){' '}
          {confirmed ? 'disagree' : 'may disagree'}
          {under}
          {figures}. {held}
        </p>
        <div className="flex flex-wrap gap-2">
          {relation.offered.includes('disagree') ? (
            <Button
              size="small"
              disabled={change.busy}
              onClick={() =>
                answer('disagree', 'Confirmed: any step that relies on it is held for you.')
              }
            >
              They disagree
            </Button>
          ) : null}
          {relation.offered.includes('from-is-right') ? (
            <Button
              size="small"
              className="!whitespace-normal text-left [overflow-wrap:anywhere]"
              disabled={change.busy}
              onClick={() =>
                answer('from-is-right', `“${from.title}” stands; “${to.title}” is superseded.`)
              }
            >
              “{from.title}” ({from.source}) is right
            </Button>
          ) : null}
          {relation.offered.includes('to-is-right') ? (
            <Button
              size="small"
              className="!whitespace-normal text-left [overflow-wrap:anywhere]"
              disabled={change.busy}
              onClick={() =>
                answer('to-is-right', `“${to.title}” stands; “${from.title}” is superseded.`)
              }
            >
              “{to.title}” ({to.source}) is right
            </Button>
          ) : null}
          {relation.offered.includes('both-hold') ? (
            <Button
              size="small"
              variant="quiet"
              disabled={change.busy}
              onClick={() => answer('both-hold', 'Both pages hold; nothing is held for it.')}
            >
              Both hold
            </Button>
          ) : null}
        </div>
        <StatusRegion outcome={change.outcome} />
      </div>
    </Card>
  );
}
