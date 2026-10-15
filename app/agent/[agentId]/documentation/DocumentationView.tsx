'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQueries, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { MOCK_OFFICE_DOCUMENTATION } from '@/surfaces/mock-office';
import { relationsNotShownWords } from '@/docs/relation-words';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { LinkSourceForm } from '../../../documentation/LinkSourceForm';
import { SourceTable, TRUST_HELP } from '../../../documentation/SourceTable';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';
import { useAgentZone } from '../../../components/time';
import { ConflictCard } from './ConflictCard';
import { PageTable } from './PageTable';
import { RelationAnswered, type AnsweredRelation } from './RelationAnswered';
import { RelationCard, type RelationCardRow, type RelationCardsRead } from './RelationCard';

/** The most cards of a kind one read draws (`docRelations.RELATION_CARDS_READ`). */
const RELATION_CARDS_READ = 20;

/** The most confirmed conflicts the tab draws: as many as one read of them gives. */
const CONFLICT_CARDS_DRAWN = RELATION_CARDS_READ;

/**
 * The most later reads the tab makes of the confirmed conflicts. Each passes over about three
 * hundred settled ones within a transaction's limits, so this reaches a conflict that stands
 * behind thousands, and an owner with more still draws every card the first reads found.
 */
const CONFLICT_READS_MOST = 16;

/** The later reads of the confirmed conflicts the tab has asked for, from where the first read stopped. */
interface ConflictReads {
  /** The first read's `next` these reads go on from. */
  readonly from: number | null;
  /** Each later read's `conflictsBefore`, in order. */
  readonly cursors: readonly number[];
}

/**
 * The cards the relations' first read drew, and the confirmed conflicts' later reads, each going on
 * from where the last stopped (W15-R19, F12): a read stops within a transaction's limits, so a
 * conflict standing behind many settled ones is drawn by a later read, which the tab makes for as
 * long as it draws fewer conflicts than one read gives and the reads say more is behind.
 *
 * @param first - The first read, or undefined while it loads or in the hosted office.
 * @returns Every card drawn so far, the first read's first.
 */
function useRelationCards(first: RelationCardsRead | undefined): RelationCardRow[] {
  const from = first?.next ?? null;
  const [reads, setReads] = useState<ConflictReads>({ from: null, cursors: [] });
  // Kept from the previous render in state, as React's docs set out: a first read that now stops
  // elsewhere starts the later reads again from there.
  const current = reads.from === from ? reads : { from, cursors: [] };
  if (current !== reads) setReads(current);
  const queries = useMemo(
    () =>
      Object.fromEntries(
        current.cursors.map((before) => [
          String(before),
          { query: api.docRelations.listOpen, args: { conflictsBefore: before } },
        ]),
      ),
    [current.cursors],
  );
  const later: Record<string, RelationCardsRead | undefined | Error> = useQueries(queries);
  const cards = [...(first?.cards ?? [])];
  let next = from;
  for (const [index, before] of current.cursors.entries()) {
    const read = later[String(before)];
    // A read still loading, or one that failed, ends the chain here; the cards before it stand.
    if (read === undefined || read instanceof Error) return cards;
    cards.push(...read.cards);
    next = read.next;
    // A read whose cards changed now stops elsewhere (its `next` is its last card drawn, 18-C's
    // C-H): the reads after it went on from where it used to stop, and would repeat or drop a
    // card, so they go, and the chain goes on from its new `next` (18-C's F3).
    const after = current.cursors[index + 1];
    if (after !== undefined && after !== next) {
      setReads({ ...current, cursors: current.cursors.slice(0, index + 1) });
      return cards;
    }
  }
  const conflicts = cards.filter((card) => card.status === 'confirmed').length;
  if (
    next !== null &&
    conflicts < CONFLICT_CARDS_DRAWN &&
    current.cursors.length < CONFLICT_READS_MOST &&
    !current.cursors.includes(next)
  ) {
    setReads({ ...current, cursors: [...current.cursors, next] });
  }
  return cards;
}

/** The proposals the tab draws, read on by the manager's press, and what to offer after them. */
interface ProposalCards {
  /** Every card drawn so far, the first read's first, each once. */
  readonly cards: RelationCardRow[];
  /** The line under the proposals, said of the last read: how many are not shown. */
  readonly notShown: string | undefined;
  /** How many the next press draws at most (0: more stand, how many is not known); none to offer. */
  readonly more: number | undefined;
  /** Whether the read a press asked for is still loading. */
  readonly loading: boolean;
  /** Whether the read a press asked for failed: the press reads it again. */
  readonly failed: boolean;
  /** Read the next proposals, from where the last read stopped. */
  readonly showMore: () => void;
}

/**
 * The proposals past the first read's twenty, read on only when the manager presses "Show {n}
 * more" (D-10's read-more, under 17-PT's line): each press reads the next proposals from where the
 * last read stopped (`proposalsBefore`). The reads are kept as the cards are answered, so a card a
 * later read drew stays drawn; a card two reads both draw (the first read moves on as its cards
 * are answered) is drawn once.
 *
 * @param first - The first read, or undefined while it loads or in the hosted office.
 * @param cards - The cards drawn so far, the first read's and the confirmed conflicts' later reads.
 */
function useProposalCards(
  first: RelationCardsRead | undefined,
  cards: readonly RelationCardRow[],
): ProposalCards {
  const [cursors, setCursors] = useState<readonly number[]>([]);
  // Each try again subscribes afresh: a failed read keeps its error under its old key.
  const [attempt, setAttempt] = useState(0);
  const keyOf = (before: number): string => `proposals-${before}-${attempt}`;
  const queries = useMemo(
    () =>
      Object.fromEntries(
        cursors.map((before) => [
          `proposals-${before}-${attempt}`,
          { query: api.docRelations.listOpen, args: { proposalsBefore: before } },
        ]),
      ),
    [cursors, attempt],
  );
  const later: Record<string, RelationCardsRead | undefined | Error> = useQueries(queries);
  const drawn = [...cards];
  const ids = new Set(drawn.map((card) => card._id));
  let last = first;
  let loading = false;
  let failed = false;
  for (const before of cursors) {
    const read = later[keyOf(before)];
    // A read still loading, or one that failed, ends the chain here; the cards before it stand.
    if (read === undefined || read instanceof Error) {
      loading = read === undefined;
      failed = read instanceof Error;
      break;
    }
    for (const card of read.cards) {
      if (!ids.has(card._id)) {
        ids.add(card._id);
        drawn.push(card);
      }
    }
    last = read;
  }
  const proposals = drawn.filter((card) => card.status === 'proposed').length;
  const next = last?.proposalsNext ?? null;
  return {
    cards: drawn,
    notShown: last === undefined ? undefined : relationsNotShownWords(proposals, last.notShown),
    more:
      last === undefined || next === null
        ? undefined
        : Math.min(last.notShown.proposals, RELATION_CARDS_READ),
    loading,
    failed,
    showMore: () => {
      if (failed) setAttempt(attempt + 1);
      else if (next !== null && !cursors.includes(next)) setCursors([...cursors, next]);
    },
  };
}

/**
 * The Documentation tab (round two section 3.9, `agent-documentation.html`), as far as the
 * backend records documentation: the owner's linked sources as the table the Documentation page
 * draws, with whether this employee reads each and every control the page offers; the stored
 * pages of the source picked, with whether its newest sync read them; and the link form in the
 * real kinds. Since wave 15 (A5) it also draws how far each source is trusted, each page's
 * status with who or what decided it, and a card for every relation the manager has still to
 * answer: two pages that read as versions of one runbook, or two that disagree. An answered
 * card leaves the tab, so the tab keeps the last answer where the cards are, with "Undo". The
 * hosted office links nothing: its Sources card says so in the one sentence the home, the
 * Documentation page and the take-on dialog say it in (`MOCK_OFFICE_DOCUMENTATION`; W16-R35), and
 * the aside says where this employee's pages are.
 */
export function DocumentationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const zone = useAgentZone();
  const sources = useQuery(api.docSources.listMine, surfaceMode === 'real' ? {} : 'skip');
  const firstRead = useQuery(api.docRelations.listOpen, surfaceMode === 'real' ? {} : 'skip');
  // The proposals the reads left out, said under the ones drawn (W17-R9, D-10 (a)), with the
  // press that reads on (D-10's read-more).
  const {
    cards: relations,
    notShown,
    more,
    loading,
    failed,
    showMore,
  } = useProposalCards(firstRead, useRelationCards(firstRead));
  const [picked, setPicked] = useState<Id<'docSources'> | undefined>(undefined);
  const [answered, setAnswered] = useState<AnsweredRelation | null>(null);
  const excluded = useMemo(
    (): ReadonlySet<string> => new Set(agent.excludedDocSourceIds ?? []),
    [agent.excludedDocSourceIds],
  );
  const surfaces = employeeTabHref(agent._id, 'surfaces');
  // The picked source while it is still linked, else the first: an unlinked source's table goes.
  const shown = sources?.find((source) => source._id === picked) ?? sources?.[0];

  const aside = (
    <>
      <Card title={`What ${agent.name} reads`}>
        <p className="text-sm text-[var(--color-fg-2)]">
          {surfaceMode === 'mock' ? (
            <>
              In the hosted office {agent.name} reads the office’s wiki and how-to guides, on the{' '}
              <Link href={surfaces}>Surfaces tab</Link> under Docs.
            </>
          ) : (
            <>
              Every source you link, for all your employees, apart from any you left out when you
              deployed {agent.name}; that choice is fixed at deploy. The same table is on the{' '}
              <Link href="/documentation" prefetch={false}>
                Documentation page
              </Link>
              , and the pages {agent.name}&apos;s connections cite are on the{' '}
              <Link href={surfaces}>Surfaces tab</Link> under Docs.
            </>
          )}
        </p>
      </Card>
      <EmployeeRail />
    </>
  );

  if (surfaceMode !== 'real') {
    return (
      <Columns arriving={arriving} aside={aside}>
        <Card title="Sources">
          <p className="text-sm text-[var(--color-muted)]">
            {surfaceMode === undefined ? 'Loading' : MOCK_OFFICE_DOCUMENTATION}
          </p>
        </Card>
      </Columns>
    );
  }

  return (
    <Columns arriving={arriving} aside={aside}>
      {/* The Trust select's own words: trust is a weight on the ranking, never a strict order. */}
      <Card title="Sources" meta={TRUST_HELP}>
        {sources === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the linked locations</p>
        ) : (
          <SourceTable
            sources={sources}
            zone={zone}
            reader={{ name: agent.name, excluded }}
            pages={{ selected: shown?._id, onSelect: setPicked }}
          />
        )}
      </Card>
      {answered !== null ? (
        <RelationAnswered
          // One answer, one card: a refused Undo's line never rides under the next answer (W15-R47).
          key={answered.relationId}
          answered={answered}
          cardGone={!relations.some((relation) => relation._id === answered.relationId)}
          onUndone={() => setAnswered({ ...answered, undo: false, undone: true })}
        />
      ) : null}
      {relations.map((relation) =>
        relation.kind === 'possible_conflict' ? (
          <ConflictCard key={relation._id} relation={relation} onAnswered={setAnswered} />
        ) : (
          <RelationCard
            key={relation._id}
            relation={relation}
            zone={zone}
            onAnswered={setAnswered}
          />
        ),
      )}
      {notShown !== undefined ? (
        <p className="text-sm text-[var(--color-muted)]">{notShown}</p>
      ) : null}
      {failed ? (
        <p className="text-sm text-[var(--color-muted)]">The next relations could not be read.</p>
      ) : null}
      {more !== undefined || failed ? (
        <Button size="small" className="justify-self-start" disabled={loading} onClick={showMore}>
          {loading
            ? 'Loading…'
            : failed
              ? 'Try again'
              : more === 0
                ? 'Show more'
                : `Show ${more} more`}
        </Button>
      ) : null}
      {shown ? <PageTable key={shown._id} source={shown} zone={zone} /> : null}
      <Card title="Link a location">
        <LinkSourceForm />
      </Card>
    </Columns>
  );
}
