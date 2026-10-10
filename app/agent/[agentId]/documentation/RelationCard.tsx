'use client';

import { useRef } from 'react';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { relationWords } from '@/docs/relation-words';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime } from '../../../components/time';
import { useChange } from '../../../components/use-change';
import type { AnsweredRelation } from './RelationAnswered';

/** One relation the manager has still to answer, as `docRelations.listOpen` draws it. */
export type RelationCardRow = FunctionReturnType<typeof api.docRelations.listOpen>[number];

/** The answers a relation's card may offer. */
export type RelationAnswer = RelationCardRow['offered'][number];

/** What `docRelations.decide` answers. */
type DecideOutcome = FunctionReturnType<typeof api.docRelations.decide>;

/** A status inside a sentence: a page "stays current", "stays a draft". */
const STAYS: Readonly<Record<NonNullable<DecideOutcome>['older'], string>> = {
  active: 'current',
  draft: 'a draft',
  archived: 'archived',
  superseded: 'superseded',
};

/**
 * What to say when "{B} supersedes {A}" was recorded and the older page is not superseded by it,
 * because something the rules put above a relation decides that page: the manager's own status,
 * or its source's word. Undefined when the answer did what the button says.
 *
 * @param outcome - What became of the older page, as the backend answered.
 * @param older - The older page's title.
 */
export function supersedeWords(outcome: DecideOutcome, older: string): string | undefined {
  if (outcome === null || outcome === undefined || outcome.by === 'relation') return undefined;
  const why =
    outcome.by === 'manager'
      ? 'you set its status by hand, and that stands over a relation. Clear on its row lets this answer decide.'
      : 'its source says so, and that stands over a relation. “Mark superseded” on its row overrules the source.';
  return `Recorded, but “${older}” stays ${STAYS[outcome.older]}: ${why}`;
}

/** A page as a card names it: its title, its source and when its source last had it. */
export function pageWords(page: RelationCardRow['from'], zone: string | undefined): string {
  return `“${page.title}” (${page.source}, edited ${clockTime(page.updatedAt, zone)})`;
}

/**
 * The card for two pages that look like versions of one document (round two section 3.9,
 * `agent-documentation.html`; the wave file's section 8): what the measures found, in words, and
 * the manager's three answers. Nothing is merged or superseded until the manager answers: both
 * pages stay current, and the employee reads both.
 *
 * @param relation - The proposed relation; `from` is the page proposed as the later version.
 * @param name - The employee's name, when the card is on an employee's tab.
 * @param zone - The zone times are said in.
 * @param onAnswered - Told what the manager answered once it is recorded: the card leaves the
 *   tab with its answer, so the tab says the outcome and offers the way back.
 */
export function RelationCard({
  relation,
  name,
  zone,
  onAnswered,
}: {
  relation: RelationCardRow;
  name?: string;
  zone?: string;
  onAnswered?: (answered: AnsweredRelation) => void;
}) {
  const decide = useMutation(api.docRelations.decide);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const { from, to } = relation;
  const answer = (decision: RelationAnswer, done: string): void =>
    change.run(() => decide({ relationId: relation._id, decision }), {
      done: (outcome) => supersedeWords(outcome, to.title) ?? done,
      refused: 'The answer was not recorded.',
      after: (outcome) =>
        onAnswered?.({
          relationId: relation._id,
          text: supersedeWords(outcome, to.title) ?? done,
          undo: true,
        }),
    });
  return (
    <Card
      title={
        <>
          These two look like versions of the same runbook
          {/* Said, not shown: two such cards are two regions, each named by its older page. */}
          <span className="sr-only">: “{to.title}”</span>
        </>
      }
      tone="warn"
      focusRef={card}
    >
      <div className="grid gap-3">
        <p className="text-sm text-[var(--color-fg-2)]">
          {pageWords(to, zone)} and {pageWords(from, zone)} {relationWords(relation.evidence)}.{' '}
          {name ?? 'Each employee'} reads both until you say otherwise.
        </p>
        <div className="flex flex-wrap gap-2">
          {relation.offered.includes('supersedes') ? (
            <Button
              size="small"
              className="!whitespace-normal text-left [overflow-wrap:anywhere]"
              disabled={change.busy}
              onClick={() => answer('supersedes', `“${from.title}” now supersedes “${to.title}”.`)}
            >
              “{from.title}” ({from.source}) supersedes “{to.title}” ({to.source})
            </Button>
          ) : null}
          {relation.offered.includes('keep-both') ? (
            <Button
              size="small"
              disabled={change.busy}
              onClick={() => answer('keep-both', 'Both pages are kept as current.')}
            >
              Keep both
            </Button>
          ) : null}
          {relation.offered.includes('not-the-same') ? (
            <Button
              size="small"
              variant="quiet"
              disabled={change.busy}
              onClick={() => answer('not-the-same', 'Noted: these are not the same page.')}
            >
              Not the same
            </Button>
          ) : null}
        </div>
        <StatusRegion outcome={change.outcome} />
      </div>
    </Card>
  );
}
