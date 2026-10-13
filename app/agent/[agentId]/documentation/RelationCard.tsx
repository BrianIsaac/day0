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

/**
 * A page as a card names it: its title, its source and when its source last had it.
 *
 * @param byDates - Whether the card's relation was proposed by its pages' dates: such a card says
 *   which date it has, "dated by its source", of a page whose row says so (D-8 (a), X-3: a
 *   folder's file time counts as its source's).
 */
export function pageWords(
  page: RelationCardRow['from'],
  zone: string | undefined,
  byDates = false,
): string {
  // A reader that gives no edit time stamps a page with when it read it (W15-R45).
  const when = page.edited === false ? 'last read' : 'edited';
  const dated = byDates && page.dated === true ? ', dated by its source' : '';
  return `“${page.title}” (${page.source}, ${when} ${clockTime(page.updatedAt, zone)}${dated})`;
}

/**
 * Why two copies are proposed as versions of one page and not as one's successor by date (D-8
 * (a)): the page Day0 holds no edit date for, of which it has only the time it read it. Said on a
 * duplicate's card alone; undefined where both pages are dated by their sources.
 *
 * @param relation - The card's relation.
 */
export function undatedWords(
  relation: Pick<RelationCardRow, 'kind' | 'from' | 'to'>,
): string | undefined {
  if (relation.kind !== 'possible_duplicate') return undefined;
  const undated = [relation.to, relation.from].filter((page) => page.edited === false);
  if (undated.length === 0) return undefined;
  if (undated.length === 1) {
    return `Day0 has no edit date from ${undated[0].source} for “${undated[0].title}”.`;
  }
  const sources = [...new Set(undated.map((page) => page.source))];
  return `Day0 has no edit date from ${sources.join(' or ')} for either page.`;
}

/**
 * The card for two pages that look like versions of one document (round two section 3.9,
 * `agent-documentation.html`; the wave file's section 8): what the measures found, in words, and
 * the manager's three answers. Nothing is merged or superseded until the manager answers: both
 * pages stay current, and the employee reads both.
 *
 * @param relation - The proposed relation; `from` is the page proposed as the later version.
 * @param zone - The zone times are said in.
 * @param onAnswered - Told what the manager answered once it is recorded: the card leaves the
 *   tab with its answer, so the tab says the outcome and offers the way back.
 */
export function RelationCard({
  relation,
  zone,
  onAnswered,
}: {
  relation: RelationCardRow;
  zone?: string;
  onAnswered?: (answered: AnsweredRelation) => void;
}) {
  const decide = useMutation(api.docRelations.decide);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const { from, to } = relation;
  const byDates = relation.evidence.some((entry) => entry.measure === 'edit-dates');
  const undated = undatedWords(relation);
  // `older` is the page the answer supersedes: the proposed older one, or, answered the other
  // way round (W15-R45's reverse button), the one the measures took for the later version.
  const answer = (decision: RelationAnswer, done: string, reversed = false): void => {
    const older = reversed ? from.title : to.title;
    change.run(
      () => decide({ relationId: relation._id, decision, ...(reversed ? { reversed } : {}) }),
      {
        done: (outcome) => supersedeWords(outcome, older) ?? done,
        refused: 'The answer was not recorded.',
        after: (outcome) =>
          onAnswered?.({
            relationId: relation._id,
            text: supersedeWords(outcome, older) ?? done,
            undo: true,
          }),
      },
    );
  };
  return (
    <Card
      title={
        <>
          These two look like versions of the same runbook
          {/* Said, not shown: two such cards are two regions, each named by its pages and their
              sources, since titles repeat across sources (W15-R51). */}
          <span className="sr-only">
            : “{to.title}” ({to.source}) and “{from.title}” ({from.source})
          </span>
        </>
      }
      tone="warn"
      focusRef={card}
    >
      <div className="grid gap-3">
        <p className="text-sm text-[var(--color-fg-2)]">
          {pageWords(to, zone, byDates)} and {pageWords(from, zone, byDates)}{' '}
          {relationWords(relation.evidence)}. {undated !== undefined ? `${undated} ` : null}
          {/* The cards are the owner's, whoever's tab draws them (W15-R45). */}
          Every employee that reads both sources reads both pages until you say otherwise.
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
          {/* The measures name the later version by a date or a version word, which a reader that
              gives no edit time gets wrong: the other direction is the manager's to say. */}
          {relation.offered.includes('supersedes') ? (
            <Button
              size="small"
              className="!whitespace-normal text-left [overflow-wrap:anywhere]"
              disabled={change.busy}
              onClick={() =>
                answer('supersedes', `“${to.title}” now supersedes “${from.title}”.`, true)
              }
            >
              “{to.title}” ({to.source}) supersedes “{from.title}” ({from.source})
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
