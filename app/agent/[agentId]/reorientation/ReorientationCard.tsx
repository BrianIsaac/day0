'use client';

import { useRef } from 'react';
import { useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { nextCharterVersion } from '@/agent/charter-amendment';
import { CLAUSE_WORDS } from '@/agent/reorientation-proposal';
import {
  approvedResultWords,
  cardTitle,
  closedAsNoLongerNeeded,
  decidedElsewhereOf,
  decidedElsewhereWords,
  decisionWords,
  deferredWords,
  failedProposalWords,
  heldWords,
  notClosedOf,
  notClosedWords,
  pendingWords,
  proposalFingerprint,
  sentenceOf,
  unproposedWords,
  revisitDay,
} from '@/agent/reorientation-words';
import { Button, ButtonLink } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime } from '../../../components/time';
import { recordWords } from '../record/record-words';
import { useChange } from '../../../components/use-change';

/** One card as the reorientation page draws it (`reorientationDecisions.listForAgent`). */
export type CardView = FunctionReturnType<typeof api.reorientationDecisions.listForAgent>[number];

/** A card's proposal, once there is one. */
type Proposed = CardView['card']['proposed'];

/**
 * The most charter clauses a card names in full. Past it the card only counts them: a card opened
 * by hand reaches the whole charter, which the Charter tab already draws.
 */
const CLAUSES_NAMED = 5;

/** A week, as Defer sets it by default (A21). */
const WEEK_MS = 7 * 86_400_000;

/** A count of things, singular or plural. */
function counted(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The skill a proposal names, by name, or a plain stand-in. */
function skillName(view: CardView, skillId: string): string {
  return view.skills.find((skill) => skill._id === skillId)?.name ?? 'the skill';
}

/** The page a proposal names, by title, or its ref. */
function pageTitle(view: CardView, page: { sourceId: string; ref: string }): string {
  return (
    view.pages.find((row) => row.sourceId === page.sourceId && row.ref === page.ref)?.title ??
    page.ref
  );
}

/**
 * What Approve does, as the first sentence of the card's foot: "Approve writes charter version
 * 0.2." for a charter change, and the target's own words otherwise.
 *
 * @param view - The card with the names its ids stand for.
 * @param proposed - Its proposal, never pending.
 */
export function approveWords(
  view: CardView,
  proposed: Exclude<Proposed, { kind: 'pending' }>,
): string {
  switch (proposed.kind) {
    case 'none':
      return 'Approve confirms the card and changes nothing.';
    case 'charter-change':
      return view.charterVersion !== undefined
        ? `Approve writes charter version ${nextCharterVersion(view.charterVersion)}.`
        : 'Approve amends the charter.';
    case 'agreement':
      return {
        keep: 'Approve keeps the working agreement as it is.',
        edit: 'Approve changes the working agreement once its check passes.',
        recheck: 'Approve checks the working agreement again.',
        retire: 'Approve retires the working agreement.',
        dismiss: 'Approve sets the proposed working agreement aside.',
      }[proposed.action];
    case 'relationship':
      return proposed.action === 'edit'
        ? 'Approve changes the relationship.'
        : 'Approve retires the relationship.';
    case 'page-status':
      return proposed.status === 'clear'
        ? `Approve hands “${pageTitle(view, proposed.page)}” back to its source’s own status.`
        : `Approve marks “${pageTitle(view, proposed.page)}” ${proposed.status === 'active' ? 'current' : proposed.status}.`;
    case 'scope':
      return `Approve ${proposed.action === 'grant' ? 'grants' : 'revokes'} access “${proposed.scope}”.`;
    case 'skill-action':
      return `Approve ${
        { recheck: 're-checks', retire: 'retires', withdraw: 'withdraws' }[proposed.action]
      } “${skillName(view, proposed.skillId)}”.`;
    default: {
      const unknown: never = proposed;
      throw new Error(`unhandled proposal ${String(unknown)}`);
    }
  }
}

/** What a proposal changes, drawn under "What {name} proposes". */
function ProposalBody({
  view,
  proposed,
}: {
  view: CardView;
  proposed: Exclude<Proposed, { kind: 'pending' }>;
}) {
  switch (proposed.kind) {
    case 'none':
      return <p>Nothing needs to change; confirm or dismiss.</p>;
    case 'charter-change':
      return (
        <>
          {proposed.before !== undefined ? (
            <p>
              <s className="text-[var(--color-muted)]">{proposed.before}</s>
            </p>
          ) : null}
          {proposed.after !== undefined ? <p>{proposed.after}</p> : null}
        </>
      );
    case 'agreement': {
      const agreement = view.agreements.find((row) => row._id === proposed.agreementId);
      return (
        <>
          <p>
            {agreement === undefined ? (
              'A working agreement.'
            ) : proposed.action === 'keep' || proposed.action === 'recheck' ? (
              // Kept or checked again, the agreement stands as written: nothing is struck.
              agreement.statement
            ) : (
              <s className="text-[var(--color-muted)]">{agreement.statement}</s>
            )}
          </p>
          {proposed.statement !== undefined ? <p>{proposed.statement}</p> : null}
        </>
      );
    }
    case 'relationship': {
      const edge = view.people.find((row) => row._id === proposed.relationshipId);
      return (
        <p>
          {sentenceOf(
            `${proposed.action === 'retire' ? 'Retire: ' : 'Change: '}${edge?.words ?? 'a relationship'}${
              proposed.action === 'edit' && proposed.scope !== undefined
                ? `, now for ${proposed.scope}`
                : ''
            }`,
          )}
        </p>
      );
    }
    case 'page-status':
      return (
        <p>
          {proposed.status === 'clear'
            ? `Hand “${pageTitle(view, proposed.page)}” back to its source’s own status.`
            : `Mark “${pageTitle(view, proposed.page)}” ${proposed.status === 'active' ? 'current' : proposed.status}.`}
        </p>
      );
    case 'scope':
      return (
        <p>
          {proposed.action === 'grant' ? 'Grant' : 'Revoke'} access “{proposed.scope}”.
        </p>
      );
    case 'skill-action':
      return (
        <p>
          {{ recheck: 'Re-check', retire: 'Retire', withdraw: 'Withdraw' }[proposed.action]} the
          skill “{skillName(view, proposed.skillId)}”.
        </p>
      );
    default: {
      const unknown: never = proposed;
      throw new Error(`unhandled proposal ${String(unknown)}`);
    }
  }
}

/** Why a card closed at the handover closed, as its line says after "Closed at the handover: ". */
const handedOverReason = 'it was the previous manager’s to decide';

/** Whether a card was closed by its employee's handover rather than by a manager (W16-R1). */
function closedAtHandover(card: CardView['card']): boolean {
  return card.status === 'dismissed' && card.outcome?.summary === approvedResultWords.handedOver;
}

/** How a decided card was decided, as its muted line says it. */
function decidedWords(card: CardView['card']): string {
  if (card.status === 'applied') return 'approved';
  if (decidedElsewhereOf(card.outcome?.summary) !== undefined) return 'decided on another card';
  if (closedAsNoLongerNeeded(card.outcome?.summary)) return 'closed';
  return closedAtHandover(card) ? 'closed at the handover' : 'dismissed';
}

/** A decided card's outcome line: what its decision did, or where it was decided. */
function outcomeWords(card: CardView['card'], zone: string | undefined): string {
  if (closedAtHandover(card)) return `Closed at the handover: ${handedOverReason}.`;
  if (closedAsNoLongerNeeded(card.outcome?.summary)) return `Closed as ${card.outcome?.summary}.`;
  const elsewhere = decidedElsewhereOf(card.outcome?.summary);
  if (elsewhere !== undefined) {
    return decidedElsewhereWords(elsewhere, revisitDay(card.decidedAt ?? card.createdAt, zone));
  }
  return `${card.status === 'applied' ? 'Approved' : 'Dismissed'}: ${card.outcome?.summary ?? ''}.`;
}

/** The card's muted line: when it opened, how much it can hold up, and what it holds now. */
function metaWords(view: CardView, zone: string | undefined): string {
  const { card } = view;
  if (card.status === 'applied' || card.status === 'dismissed') {
    return `${decidedWords(card)} ${clockTime(card.decidedAt ?? card.createdAt, zone)}`;
  }
  const opened =
    card.trigger === 'role-changed'
      ? `opened by you ${clockTime(card.createdAt, zone)}`
      : `opened automatically ${clockTime(card.createdAt, zone)}`;
  const deferred =
    card.status === 'deferred' && card.revisitAt !== undefined
      ? ` · deferred until ${revisitDay(card.revisitAt, zone)}`
      : '';
  return `${opened} · ${card.risk} risk · ${heldWords(view.held)}${deferred}`;
}

/**
 * One reorientation card (round two's `agent-reorientation.html`; the wave file's sections 5.2 and
 * 7): what changed, what it reaches and rests on, what the employee proposes, and the decisions.
 * Only Approve changes anything; Defer sets the card aside a week and changes nothing; Dismiss
 * closes it. A decided card keeps what its decision did. Discuss (16-D) joins the foot.
 *
 * @param view - The card, with the names its ids stand for.
 * @param name - The employee's name.
 * @param zone - The employee's zone, which every date on the card is in.
 * @param now - The clock Defer's date is counted from.
 */
export function ReorientationCard({
  view,
  name,
  zone,
  now,
}: {
  view: CardView;
  name: string;
  zone?: string;
  now: number;
}) {
  const approve = useMutation(api.reorientationDecisions.approve);
  const defer = useMutation(api.reorientationDecisions.defer);
  const dismiss = useMutation(api.reorientationDecisions.dismiss);
  const cardRef = useRef<HTMLElement>(null);
  const change = useChange(cardRef);
  const { card } = view;
  const reorientationId = card._id;
  const decided = card.status === 'applied' || card.status === 'dismissed';
  const proposed = card.proposed;
  const held = view.held;
  const affected = [
    card.affected.charterClauses.length > 0
      ? counted(card.affected.charterClauses.length, 'charter clause')
      : undefined,
    card.affected.agreements.length > 0
      ? counted(card.affected.agreements.length, 'working agreement')
      : undefined,
    card.affected.skills.length > 0 ? counted(card.affected.skills.length, 'skill') : undefined,
    card.affected.surfaces.length > 0
      ? counted(card.affected.surfaces.length, 'connected system')
      : undefined,
    // A decided card holds nothing, and a standing one says what its hold stops (M3).
    decided ? undefined : held.plans + held.runs > 0 ? heldWords(held) : '0 plans held',
  ].filter((words): words is string => words !== undefined);
  // The clauses it reaches, each under its list's name and in the words it had when the card
  // opened (the v0.20.0 hosted walk's finding 5: a handover's card counted two and named none).
  const clauses =
    card.affected.charterClauses.length <= CLAUSES_NAMED
      ? card.affected.charterClauses
          .filter((clause) => clause.text.trim() !== '')
          .map((clause) => `${CLAUSE_WORDS[clause.field]}: “${clause.text}”`)
      : [];
  const evidence = [
    ...view.pages.map((page) => `“${page.title}”`),
    ...view.people.map((edge) => edge.words),
    // The organisation's ledger lines an organisation's change rests on, in the record's words.
    ...view.ledger.map((line) => recordWords(line, { name }).replace(/\.$/u, '')),
    // A rule drafted before rules were bound carries no clause, so its own words say it (W16-R21).
    ...(view.carriedRules ?? []).map((quote) => `Its reporting-line rule: “${quote}”`),
  ];
  return (
    <Card
      id={`card-${reorientationId}`}
      title={
        <>
          {cardTitle(name)}
          {/* Said, not shown: two cards are two regions, each named by what changed (W15-R51). */}
          <span className="sr-only">: {card.triggerSummary}</span>
        </>
      }
      meta={metaWords(view, zone)}
      tone={decided ? undefined : 'warn'}
      focusRef={cardRef}
      data-reorientation-status={card.status}
    >
      <div className="grid gap-4 text-sm">
        <p className="text-[var(--color-fg-2)]">{sentenceOf(card.triggerSummary)}</p>
        <dl className="grid gap-1 sm:grid-cols-[8rem_1fr]">
          {affected.length > 0 ? (
            <>
              <dt className="text-[var(--color-muted)]">Affected</dt>
              <dd className="[overflow-wrap:anywhere]">{affected.join(' · ')}</dd>
            </>
          ) : null}
          {clauses.length > 0 ? (
            <>
              <dt className="text-[var(--color-muted)]">Clauses</dt>
              <dd className="[overflow-wrap:anywhere]">{clauses.join(' · ')}</dd>
            </>
          ) : null}
          {evidence.length > 0 ? (
            <>
              <dt className="text-[var(--color-muted)]">Evidence</dt>
              <dd className="[overflow-wrap:anywhere]">{evidence.join(' · ')}</dd>
            </>
          ) : null}
          {view.workItems.length > 0 ? (
            <>
              <dt className="text-[var(--color-muted)]">Work</dt>
              <dd className="[overflow-wrap:anywhere]">
                {view.workItems.map((item) => `“${item.title}”`).join(' · ')}
              </dd>
            </>
          ) : null}
        </dl>
        <div>
          <h3 className="text-sm text-[var(--color-muted)]">What {name} proposes</h3>
          <div className="mt-2 grid gap-2 rounded-lg border border-[var(--color-border)] p-3 [overflow-wrap:anywhere]">
            {proposed.kind === 'pending' ? (
              <p>
                {decided
                  ? unproposedWords(name, proposed)
                  : proposed.failedAt !== undefined
                    ? failedProposalWords(name, proposed.failure)
                    : pendingWords(name, held)}
              </p>
            ) : (
              <ProposalBody view={view} proposed={proposed} />
            )}
          </div>
          {proposed.kind !== 'pending' ? (
            <p className="mt-2 text-[13px] text-[var(--color-muted)]">{proposed.rationale}</p>
          ) : null}
        </div>
        {decided ? (
          card.outcome !== undefined ? (
            <p className="text-[var(--color-fg-2)]">{outcomeWords(card, zone)}</p>
          ) : null
        ) : (
          <div className="grid gap-3 border-t border-[var(--color-border)] pt-4">
            {notClosedOf(card.outcome?.summary) !== undefined ? (
              <p className="text-[var(--color-fg-2)]">
                {notClosedWords(notClosedOf(card.outcome?.summary) ?? '')}
              </p>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="approve"
                size="large"
                disabled={change.busy || proposed.kind === 'pending'}
                onClick={() =>
                  change.run(
                    () => approve({ reorientationId, shown: proposalFingerprint(proposed) }),
                    {
                      done: (outcome) => `Approved: ${outcome.result}.`,
                      refused: 'The card was not approved.',
                    },
                  )
                }
              >
                Approve
              </Button>
              {card.status !== 'deferred' ? (
                <Button
                  disabled={change.busy}
                  onClick={() =>
                    change.run(() => defer({ reorientationId }), {
                      done: (outcome) => deferredWords(revisitDay(outcome.revisitAt, zone), held),
                      refused: 'The card was not deferred.',
                    })
                  }
                >
                  Defer a week
                </Button>
              ) : null}
              <Button
                variant="quiet"
                disabled={change.busy}
                onClick={() =>
                  change.run(() => dismiss({ reorientationId }), {
                    done: 'Dismissed: nothing changed.',
                    refused: 'The card was not dismissed.',
                  })
                }
              >
                Dismiss
              </Button>
              {/* Discuss (16-D): a talk of its own about this card, ending in a new proposal on it. */}
              <ButtonLink href={`/agent/${card.agentId}/reorientation/talk/${reorientationId}`}>
                {card.status === 'discussing'
                  ? `Carry on the talk with ${name}`
                  : `Discuss with ${name}`}
              </ButtonLink>
            </div>
            <p className="text-[13px] text-[var(--color-muted)]">
              {decisionWords({
                name,
                approves:
                  proposed.kind === 'pending'
                    ? 'Approve waits for the proposal.'
                    : approveWords(view, proposed),
                ...(card.status !== 'deferred' ? { revisit: revisitDay(now + WEEK_MS, zone) } : {}),
                holds: held.plans + held.runs > 0,
                ...(view.charterVersion !== undefined
                  ? { charterVersion: view.charterVersion }
                  : {}),
              })}
            </p>
          </div>
        )}
        {/*
          After the decisions, in one place whatever the card's state: a decision that moves the
          card under Decided keeps this region, so what it did is announced there. Decided, the
          card's own outcome line says it to the eye, and the region says it only to a reader.
        */}
        <div className={decided ? 'sr-only' : undefined}>
          <StatusRegion outcome={change.outcome} />
        </div>
      </div>
    </Card>
  );
}
