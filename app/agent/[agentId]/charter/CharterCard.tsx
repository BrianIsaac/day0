'use client';

import Link from 'next/link';
import {
  type CharterConstraint,
  type StruckClause,
  listedRules,
  rulePlacement,
  strikePreview,
} from '@/agent/charter-constraints';
import { synthesisNotes } from '@/agent/manager-questions';
import { useRef } from 'react';
import type { Doc } from '@convex/_generated/dataModel';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useChange } from '../../../components/use-change';
import { StatusRegion } from '../../../components/StatusRegion';
import { type CharterChange, nextCharterVersion } from '@/agent/charter-amendment';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { clockTime, useAgentZone } from '../../../components/time';
import { AmendCharterPanel, defaultRuleClause } from './AmendCharterPanel';
import { CharterDocument, INLINE_LINK } from './CharterDocument';
import { CHANGES_REQUEST_ID } from './ChangesRequest';
import { ConstraintList } from './RuleRow';
import { documentStrikes } from './charter-document';
import { READER_ACTED, type CharterActors } from './charter-actors';
import { employeeTabHref } from '../employee-tabs';

/** The charter body as the card reads it; `constraints` is absent on charters drafted before the list existed. */
export interface CharterCardBody {
  whyThisHire: string;
  proposedFunction: string;
  shortTermGoals: { day30: string; day60: string; day90: string };
  proposedBoundaries: { willDo: string[]; willNotDo: string[]; escalationTriggers: string[] };
  namedCollaborators: Array<{ name: string; topic: string }>;
  /** Whose lane the employee stays out of; the scope check reads these. */
  adjacentRoles?: Array<{ who: string; staysOutOfTheirLaneBy: string }>;
  namedSystems?: Array<{ name: string; class: string; whereMentioned: string }>;
  priorityReading: string[];
  openQuestions: string[];
  constraints?: CharterConstraint[];
  answeredQuestions?: Array<{ question: string; answer: string; answeredAt: string }>;
  synthesisNotes?: string[];
  /** What the strikes changed at approval, kept for the record; absent on a draft. */
  struckClauses?: StruckClause[];
}

/**
 * The charter as drafted or approved (round two section 3.5, `agent-charter.html`): the document,
 * the rules with their standing, the notes from drafting, and, on a draft, Approve with what it
 * does and the way to ask for changes; once approved, Amend behind its disclosure.
 *
 * The manager it names is the agent row's, whom a handover on People changes
 * (U9 D3 (b), D14): the charter has no approval chain of its own to edit here.
 *
 * @param name - The employee's name.
 * @param autonomous - Whether the employee's writes go ahead without asking.
 * @param approvedBy - Who approved it: "you", or the earlier manager a handover took it from.
 * @param pageDrivesWork - The Work tab drives each step, as in the hosted demo (mock mode): once
 *   approved, the card says to open it (decision D-5 (a), a product call).
 * @param actors - Who struck, answered and added what the record shows; the reader, by default.
 */
export function CharterCard({
  charter,
  manager,
  name = 'Your employee',
  autonomous = false,
  approvedBy = 'you',
  pageDrivesWork = false,
  actors = READER_ACTED,
}: {
  charter: Doc<'charters'>;
  /** The agent row's manager, who approves this employee's work. */
  manager?: string;
  name?: string;
  autonomous?: boolean;
  approvedBy?: string;
  pageDrivesWork?: boolean;
  actors?: CharterActors;
}) {
  const approve = useMutation(api.charters.approve);
  const setConstraintStruck = useMutation(api.charters.setConstraintStruck);
  const amend = useMutation(api.charters.amend);
  const zone = useAgentZone();
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const body = charter.body as CharterCardBody;
  const constraints = body.constraints ?? [];
  // Counted over the rules the card lists: a copy of a rule with no words of its own is not one.
  const struckCount = listedRules(constraints).filter(({ constraint }) => constraint.struck).length;
  const struck =
    struckCount === 0 ? '' : `${struckCount} ${struckCount === 1 ? 'rule' : 'rules'} struck`;
  const unplacedCount = listedRules(constraints).filter(
    ({ constraint }) =>
      !constraint.struck && rulePlacement(body, constraint).kind === 'in-no-clause',
  ).length;

  function toggleStrike(index: number, strike: boolean): void {
    const quote = constraints[index]?.quote ?? 'the rule';
    change.run(
      async (): Promise<void> => {
        const result = await setConstraintStruck({ charterId: charter._id, index, struck: strike });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: strike
          ? `Struck “${quote}”: approval leaves its clauses out.`
          : `Restored “${quote}”.`,
        refused: 'The rule was not changed.',
      },
    );
  }

  function sendAmendment(
    amendment: CharterChange,
    after?: () => void,
    focus?: () => HTMLElement | null,
  ): void {
    change.run(() => amend({ agentId: charter.agentId, changes: [amendment] }), {
      done: `Charter amended: version ${nextCharterVersion(charter.version)} is the one in force.`,
      refused: 'The amendment was refused.',
      after,
      focus,
    });
  }

  /** Keep a rule no clause carries by adding it as a clause, under the list a new rule defaults to. */
  function keepAsClause(index: number): void {
    const rule = constraints[index];
    if (rule === undefined) return;
    sendAmendment({
      kind: 'add-constraint',
      constraint: { kind: rule.kind, quote: rule.quote, clause: defaultRuleClause(rule.quote) },
    });
  }

  // The approval schedules the work the charter implies on the server, so
  // nothing here waits on or retries it.
  function onApprove(): void {
    change.run(
      async (): Promise<void> => {
        const result = await approve({ charterId: charter._id });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: `Charter approved: ${name} starts on the work it implies.`,
        refused: 'The approval was not recorded.',
      },
    );
  }

  /** Take the manager to the note that asks for changes, beside the transcript. */
  function askForChanges(): void {
    const form = document.getElementById(CHANGES_REQUEST_ID);
    form?.scrollIntoView({ block: 'start' });
    (form?.querySelector('textarea') ?? form)?.focus();
  }

  return (
    <Card
      title={`${name}'s charter · version ${charter.version}`}
      meta={
        charter.approved
          ? `approved by ${approvedBy}${
              charter.approvedAt !== undefined ? ` ${clockTime(charter.approvedAt, zone)}` : ''
            }${struck ? ` · ${struck}` : ''}`
          : struck || 'nothing struck yet'
      }
      tone={charter.approved ? 'ok' : 'warn'}
      focusRef={card}
    >
      <div className="grid gap-6">
        <CharterDocument
          body={body}
          manager={manager}
          peopleHref={employeeTabHref(charter.agentId, 'people')}
          strikes={documentStrikes(body, charter.approved)}
          actors={actors}
        />
        <div className="grid gap-4 border-t border-[var(--color-border)] pt-5">
          <ConstraintList
            constraints={constraints}
            approved={charter.approved}
            name={name}
            actors={actors}
            busy={change.busy}
            onStrike={charter.approved ? undefined : (index) => toggleStrike(index, true)}
            onRestore={charter.approved ? undefined : (index) => toggleStrike(index, false)}
            onKeep={charter.approved ? keepAsClause : askForChanges}
            previewStrike={(index) => strikePreview(body, index)}
            placementOf={(constraint) => rulePlacement(body, constraint)}
          />
          <SynthesisNotes notes={synthesisNotes(body)} />
        </div>
        {charter.approved && pageDrivesWork ? (
          <p className="text-sm text-[var(--color-fg-2)]">
            <Link href={employeeTabHref(charter.agentId, 'work')} className={INLINE_LINK}>
              Open Work
            </Link>{' '}
            to start {name} on the queue; items move on while that page is open.
          </p>
        ) : null}
        {charter.approved ? (
          <div className="border-t border-[var(--color-border)] pt-2">
            <AmendCharterPanel
              charter={charter}
              body={body}
              busy={change.busy}
              onAmend={sendAmendment}
            />
          </div>
        ) : (
          <div className="grid gap-3 border-t border-[var(--color-border)] pt-5">
            <div className="flex flex-wrap gap-2">
              <Button variant="approve" size="large" onClick={onApprove} disabled={change.busy}>
                {struck ? `Approve charter, ${struck}` : 'Approve charter'}
              </Button>
              <Button size="large" onClick={askForChanges} disabled={change.busy}>
                Ask {name} for changes
              </Button>
            </div>
            <p className="text-[13px] text-[var(--color-muted)]">
              {approvalConsequence({ name, struckCount, unplacedCount, autonomous })}
            </p>
          </div>
        )}
        <StatusRegion outcome={change.outcome} />
      </div>
    </Card>
  );
}

/**
 * What approving does, said beside Approve: what the strikes take out, the rules no clause keeps,
 * that the employee starts on the work the charter implies, where its writes go, and that the
 * charter stays amendable.
 *
 * @param unplacedCount - Rules the manager gave that no clause carries, so approving keeps none of
 *   them (13-R, a product call); none when not given.
 */
export function approvalConsequence({
  name,
  struckCount,
  unplacedCount = 0,
  autonomous,
}: {
  name: string;
  struckCount: number;
  unplacedCount?: number;
  autonomous: boolean;
}): string {
  const strikes =
    struckCount === 0
      ? ''
      : struckCount === 1
        ? 'The struck rule takes its clauses out of the charter. '
        : `The ${struckCount} struck rules take their clauses out of the charter. `;
  const unplaced =
    unplacedCount === 0
      ? ''
      : unplacedCount === 1
        ? '1 rule is in no clause, so approving does not keep it. '
        : `${unplacedCount} rules are in no clause, so approving does not keep them. `;
  const writes = autonomous
    ? 'Autonomous actions are on, so its writes go ahead without asking.'
    : 'Every write still waits for you.';
  return `${strikes}${unplaced}Approving lets ${name} read the office and start on the work the charter implies. ${writes} The charter can be amended later, by version.`;
}

/**
 * What the synthesis said about its own drafting, under the rules. Read-only:
 * a note is not a question for the manager and offers no answer box.
 */
function SynthesisNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="grid gap-1.5">
      <h3 className="text-[13px] font-semibold tracking-[0.02em] text-[var(--color-muted)]">
        Notes from drafting
      </h3>
      <ul className="grid list-disc gap-1 pl-5 text-sm text-[var(--color-fg-2)]">
        {notes.map((note) => (
          <li key={note}>{note}</li>
        ))}
      </ul>
    </div>
  );
}
