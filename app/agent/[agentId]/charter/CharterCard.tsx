'use client';

import {
  type CharterConstraint,
  type StrikePreview,
  strikePreview,
} from '@/agent/charter-constraints';
import { synthesisNotes, managerOpenQuestions } from '@/agent/manager-questions';
import { useState, useRef } from 'react';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useChange, LiveStatus } from '../live-status';
import { type CharterChange, nextCharterVersion } from '@/agent/charter-amendment';
import { Card } from '../../../components/Card';
import { SUMMARY } from '../../../components/Disclosure';
import { AmendCharterPanel } from './AmendCharterPanel';

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
}

const CONSTRAINT_KIND_LABEL: Record<CharterConstraint['kind'], string> = {
  'candidate-property': 'what work qualifies',
  'system-boundary': 'where I may act',
  'reporting-line': 'who I report to',
};

/** The clauses a strike removes, quoted for the card. */
function quotedClauses(clauses: readonly string[]): string {
  return clauses.map((clause: string): string => `\u201c${clause}\u201d`).join('; ');
}

/**
 * The confirm-or-strike list: every rule the draft will enforce, in the
 * manager's own words, beside the clause phrases that encode it.
 *
 * Before approval each row can be struck or restored; the clauses on the card
 * stay as drafted until Approve, which is when struck wording leaves them.
 * After approval the list is the record of what was confirmed and what was
 * struck. With `previewStrike` each row says what its strike would remove,
 * and a strike the effective charter refuses is disabled with the reason, so
 * nothing the card offers can fail at approval.
 */
export function ConstraintList({
  constraints,
  approved,
  onStrike,
  onRestore,
  previewStrike,
  busy = false,
}: {
  constraints: CharterConstraint[];
  approved: boolean;
  /** A change to the charter is in flight; the controls wait for it. */
  busy?: boolean;
  /** Strike a confirmed rule; before approval a draft flag, after it an amendment. */
  onStrike?: (index: number) => void;
  /** Restore a struck rule; only a draft can, because a strike after approval has already left the clauses. */
  onRestore?: (index: number) => void;
  /** What striking a rule would do, computed as approval computes it. */
  previewStrike?: (index: number) => StrikePreview;
}) {
  // A rule struck since the list first rendered is this visit's decision, and its line draws.
  const [struckOnArrival] = useState(
    (): ReadonlySet<number> =>
      new Set(constraints.flatMap((constraint, index) => (constraint.struck ? [index] : []))),
  );
  if (constraints.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {approved
          ? 'Rules this charter enforces'
          : 'These words will limit the work. Confirm or strike each one.'}
      </div>
      <ul className="space-y-1.5">
        {constraints.map((constraint, index) => {
          const preview =
            !constraint.struck && onStrike && previewStrike ? previewStrike(index) : undefined;
          return (
            <li
              key={index}
              data-just={constraint.struck && !struckOnArrival.has(index) ? '' : undefined}
              className={`flex items-start gap-2 p-2 rounded-md border ${
                constraint.struck
                  ? 'border-[var(--color-border)] text-[var(--color-muted)]'
                  : 'border-[var(--color-warn)]/40'
              }`}
            >
              <div className="flex-1 min-w-0">
                <p
                  data-strike=""
                  className={constraint.struck ? 'line-through' : 'text-[var(--color-fg)]'}
                >
                  {/* A derived rule's quote is the clause itself, not a sentence
                    the manager said, so it is not printed as a quotation. */}
                  {constraint.origin === 'derived' ? (
                    constraint.quote
                  ) : (
                    <>&ldquo;{constraint.quote}&rdquo;</>
                  )}
                </p>
                <p className="text-[10px] text-[var(--color-muted)] mt-0.5">
                  {CONSTRAINT_KIND_LABEL[constraint.kind]}
                  {constraint.wording.length > 0 ? (
                    <>
                      {' · in the charter as '}
                      {constraint.wording.map((phrase, i) => (
                        <span key={i}>
                          {i > 0 ? ', ' : ''}
                          <span className="font-mono text-[var(--color-fg)]">{phrase}</span>
                        </span>
                      ))}
                    </>
                  ) : (
                    ' · not verified: no clause carries these words, so striking it changes nothing'
                  )}
                  {constraint.origin === 'derived'
                    ? " · found by checking the clauses (the charter's wording, not a sentence of yours)"
                    : ''}
                  {constraint.origin === 'manager' ? ' · added by you' : ''}
                  {constraint.struck ? (
                    <>
                      {' '}
                      <span data-struck-mark="">· struck</span>
                    </>
                  ) : null}
                </p>
                {preview?.refusal ? (
                  <p className="text-[10px] text-[var(--color-warn)] mt-0.5">
                    cannot be struck: {preview.refusal}
                  </p>
                ) : preview && preview.removedClauses.length > 0 ? (
                  <p className="text-[10px] text-[var(--color-muted)] mt-0.5">
                    {preview.removedClauses.length === 1
                      ? 'strikes the clause: '
                      : 'strikes the clauses: '}
                    {quotedClauses(preview.removedClauses)}
                  </p>
                ) : null}
                {preview && !preview.refusal
                  ? preview.rewrittenClauses.map((pair, i) => (
                      <p key={i} className="text-[10px] text-[var(--color-muted)] mt-0.5">
                        {'rewrites the clause: '}
                        {quotedClauses([pair.from])}
                        {' to '}
                        {quotedClauses([pair.to])}
                      </p>
                    ))
                  : null}
              </div>
              {!constraint.struck && onStrike ? (
                <button
                  type="button"
                  onClick={() => onStrike(index)}
                  disabled={busy || preview?.refusal !== undefined}
                  title={preview?.refusal}
                  aria-label={`Strike: ${constraint.quote}`}
                  className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-warn)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--color-border)]"
                >
                  Strike
                </button>
              ) : constraint.struck && onRestore ? (
                <button
                  type="button"
                  onClick={() => onRestore(index)}
                  disabled={busy}
                  aria-label={`Restore: ${constraint.quote}`}
                  className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-ok)] disabled:opacity-50"
                >
                  Restore
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * The charter as drafted or approved, with its rules, its notes and, once
 * approved, the amendment panel.
 *
 * The manager it names is the agent row's, the one the header changes
 * (U9 D3 (b)): the charter has no approval chain of its own to edit here.
 */
export function CharterCard({
  charter,
  manager,
  onSentBack,
}: {
  charter: Doc<'charters'>;
  /** The agent row's manager, who approves this employee's work. */
  manager?: string;
  /** Told which draft was sent back, so the page can say what follows it. */
  onSentBack?: (charterId: Id<'charters'>) => void;
}) {
  const approve = useMutation(api.charters.approve);
  const requestChanges = useMutation(api.charters.requestChanges);
  const setConstraintStruck = useMutation(api.charters.setConstraintStruck);
  const amend = useMutation(api.charters.amend);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const body = charter.body as CharterCardBody;
  const constraints = body.constraints ?? [];
  const struckCount = constraints.filter((constraint) => constraint.struck).length;

  function toggleStrike(index: number, struck: boolean): void {
    const quote = constraints[index]?.quote ?? 'the rule';
    change.run(
      async (): Promise<void> => {
        const result = await setConstraintStruck({ charterId: charter._id, index, struck });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: struck
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

  // The approval seeds the work the charter implies on the server, in the
  // same transaction, so nothing here waits on or retries it.
  function onApprove(): void {
    change.run(
      async (): Promise<void> => {
        const result = await approve({ charterId: charter._id });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: 'Charter approved: the employee starts on the work it implies.',
        refused: 'The approval was not recorded.',
      },
    );
  }

  // Sending the draft back deletes it, and this card with it when no approved
  // charter stands beneath it; the page says what follows and takes focus.
  function onRequestChanges(): void {
    change.run(() => requestChanges({ charterId: charter._id }), {
      done: SENT_BACK,
      refused: 'The charter was not sent back.',
      after: () => onSentBack?.(charter._id),
    });
  }

  return (
    <Card
      title={`Charter v${charter.version}${charter.approved ? ' · approved' : ' · awaiting approval'}`}
      tone={charter.approved ? 'ok' : 'warn'}
      focusRef={card}
    >
      <div className="space-y-3 text-sm">
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
            Why this hire
          </span>
          <p className="text-[var(--color-fg)]">{body.whyThisHire}</p>
        </div>
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
            Proposed function
          </span>
          <p className="text-[var(--color-fg)]">{body.proposedFunction}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <Goal label="30-day" text={body.shortTermGoals.day30} />
          <Goal label="60-day" text={body.shortTermGoals.day60} />
          <Goal label="90-day" text={body.shortTermGoals.day90} />
        </div>
        <details className="text-xs">
          <summary className={SUMMARY}>Boundaries · collaborators · open questions</summary>
          <div className="mt-2 space-y-2 pl-3 border-l border-[var(--color-border)]">
            <BoundaryList
              label="Reports to"
              items={
                manager ? [`${manager}, the manager named in the header; change it there`] : []
              }
            />
            <BoundaryList label="Will do" items={body.proposedBoundaries.willDo} />
            <BoundaryList label="Will NOT do" items={body.proposedBoundaries.willNotDo} />
            <BoundaryList
              label="Escalation triggers"
              items={body.proposedBoundaries.escalationTriggers}
            />
            <BoundaryList
              label="Systems named in the 1:1"
              items={(body.namedSystems ?? []).map(
                (system) => `${system.name} (${system.class}) - ${system.whereMentioned}`,
              )}
            />
            <BoundaryList
              label="Collaborators"
              items={body.namedCollaborators.map((c) => `${c.name} - ${c.topic}`)}
            />
            <BoundaryList
              label="Adjacent roles (work in their lane is out of scope)"
              items={(body.adjacentRoles ?? []).map(
                (role) => `${role.who} - ${role.staysOutOfTheirLaneBy}`,
              )}
            />
            <BoundaryList label="Priority reading" items={body.priorityReading} />
            <BoundaryList label="Open questions" items={managerOpenQuestions(body)} />
          </div>
        </details>
        <ConstraintList
          constraints={constraints}
          approved={charter.approved}
          busy={change.busy}
          onStrike={(index) =>
            charter.approved
              ? sendAmendment({ kind: 'strike-constraint', index })
              : toggleStrike(index, true)
          }
          onRestore={charter.approved ? undefined : (index) => toggleStrike(index, false)}
          previewStrike={(index) => strikePreview(body, index)}
        />
        <SynthesisNotes notes={synthesisNotes(body)} />
        {charter.approved ? (
          <AmendCharterPanel
            charter={charter}
            body={body}
            busy={change.busy}
            onAmend={sendAmendment}
          />
        ) : null}
        {!charter.approved ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onApprove}
              disabled={change.busy}
              className="min-h-11 px-4 rounded-lg bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-sm font-medium disabled:opacity-50"
            >
              {struckCount > 0
                ? `Approve, ${struckCount} ${struckCount === 1 ? 'rule' : 'rules'} struck`
                : 'Approve'}
            </button>
            <button
              type="button"
              onClick={onRequestChanges}
              disabled={change.busy}
              className="min-h-11 px-4 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-warn)] text-sm disabled:opacity-50"
            >
              Request changes
            </button>
          </div>
        ) : null}
        <LiveStatus outcome={change.outcome} />
      </div>
    </Card>
  );
}

/** What the card says once the manager sends its draft back. */
const SENT_BACK = 'Charter sent back: this draft is withdrawn.';

function Goal({ label, text }: { label: string; text: string }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-2">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-[var(--color-fg)] leading-snug">{text}</div>
    </div>
  );
}

/**
 * What the synthesis said about its own drafting, under the rules. Read-only:
 * a note is not a question for the manager and offers no answer box.
 */
function SynthesisNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        Notes from drafting
      </div>
      <ul className="space-y-0.5">
        {notes.map((note) => (
          <li key={note} className="text-[var(--color-muted)]">
            – {note}
          </li>
        ))}
      </ul>
    </div>
  );
}

function BoundaryList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="text-[var(--color-fg)]">
            – {it}
          </li>
        ))}
      </ul>
    </div>
  );
}
