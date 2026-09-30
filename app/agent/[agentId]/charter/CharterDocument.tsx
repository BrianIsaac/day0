import type { ReactNode } from 'react';
import type { StruckClause, StruckClauseField } from '@/agent/charter-constraints';
import { managerOpenQuestions } from '@/agent/manager-questions';
import { clockTime, useAgentZone } from '../../../components/time';
import type { CharterCardBody } from './CharterCard';
import { changesTo, goalIsGap, systemsLine, type DocumentStrikes } from './charter-document';

/** A section of the document: a quiet heading over its prose or list. */
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="grid gap-1.5">
      <h3 className="text-[13px] font-semibold tracking-[0.02em] text-[var(--color-muted)]">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** A clause with the line of a strike through it, and what the strike did in words. */
function Struck({ text, note }: { text: string; note: string }) {
  return (
    <span className="text-[var(--color-muted)]">
      <s className="decoration-[var(--color-danger)] decoration-2">{text}</s> {note}
    </span>
  );
}

/**
 * One clause as the document shows it: as it stands, or, where a strike changes it, struck. On a
 * draft the struck text is what approval will change; on the record, what it changed.
 */
function Clause({
  text,
  change,
  pending,
}: {
  text: string;
  change: StruckClause | undefined;
  pending: boolean;
}) {
  if (!change) return <>{text}</>;
  if (change.rewrittenAs === undefined) {
    return (
      <Struck
        text={change.text}
        note={pending ? 'leaves the charter on approval' : 'struck by you'}
      />
    );
  }
  return pending ? (
    <>
      <Struck text={change.text} note="on approval reads:" />{' '}
      <span className="text-[var(--color-fg)]">{change.rewrittenAs}</span>
    </>
  ) : (
    <>
      {text}{' '}
      <span className="text-[var(--color-muted)]">
        (before your strike: <s className="decoration-[var(--color-danger)]">{change.text}</s>)
      </span>
    </>
  );
}

/**
 * A clause list. A draft lists its clauses as drafted, each one a strike changes drawn struck in
 * place; the record lists the clauses in force, a rewritten one beside what it was, then the
 * clauses its strikes took out, struck.
 */
function ClauseList({
  field,
  items,
  strikes,
}: {
  field: StruckClauseField;
  items: readonly string[];
  strikes: DocumentStrikes;
}) {
  const changes = changesTo(strikes, field);
  const changeOf = (text: string): StruckClause | undefined =>
    changes.find((change) =>
      strikes.pending ? change.text === text : change.rewrittenAs === text,
    );
  // A clause an amendment has since put back is in force, not struck.
  const removed = strikes.pending
    ? []
    : changes.filter((c) => c.rewrittenAs === undefined && !items.includes(c.text));
  if (items.length === 0 && removed.length === 0) {
    return <p className="text-[var(--color-muted)]">None.</p>;
  }
  return (
    <ul className="grid list-disc gap-1 pl-5">
      {items.map((item, index) => (
        <li key={`${index}:${item}`}>
          <Clause text={item} change={changeOf(item)} pending={strikes.pending} />
        </li>
      ))}
      {removed.map((change) => (
        <li key={`struck:${change.text}`}>
          <Clause text={change.text} change={change} pending={false} />
        </li>
      ))}
    </ul>
  );
}

/** One of the three goals, or the gap where the manager named none. */
function Goal({ label, text }: { label: string; text: string }) {
  const gap = goalIsGap(text);
  return (
    <div
      data-goal={gap ? 'gap' : 'goal'}
      className={`rounded-lg border bg-[var(--color-bg)] px-3.5 py-3 text-[15px] ${
        gap
          ? 'border-dashed border-[var(--color-border-2)] text-[var(--color-muted)]'
          : 'border-[var(--color-border)] text-[var(--color-fg)]'
      }`}
    >
      <p className="mb-1 text-xs tracking-[0.04em] text-[var(--color-muted)]">
        {label}
        {gap ? ' · no goal stated' : ''}
      </p>
      <p className="leading-snug">{text.trim() || 'Nothing was said for this checkpoint.'}</p>
    </div>
  );
}

/** The check an answered open question carries where the list draws its bullet. */
function AnsweredMark() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="absolute -left-5 top-[0.3em] size-3.5 text-[var(--color-ok)]"
    >
      <path
        d="M3 8.5l3.2 3L13 4.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * The charter as one document (round two section 3.5): why this hire, the function, the three
 * goals (a checkpoint the manager named nothing for drawn as a gap), the boundaries open as its
 * sections, the systems on one line, the people, what to read first, and the open questions with
 * any the manager has answered written in.
 *
 * @param manager - The agent row's manager, who approves this employee's work.
 */
export function CharterDocument({
  body,
  manager,
  strikes,
}: {
  body: CharterCardBody;
  manager?: string;
  strikes: DocumentStrikes;
}) {
  const zone = useAgentZone();
  // The record's change to the function counts only while the function still reads as the strike
  // left it; an amendment that rewrote it since has its own version.
  const functionChange = changesTo(strikes, 'proposedFunction').findLast((change) =>
    strikes.pending
      ? change.text === body.proposedFunction
      : change.rewrittenAs === body.proposedFunction,
  );
  const systems = body.namedSystems ?? [];
  const adjacent = body.adjacentRoles ?? [];
  const answered = body.answeredQuestions ?? [];
  const open = managerOpenQuestions(body);
  return (
    <div className="grid gap-5 text-base leading-relaxed text-[var(--color-fg)]">
      <Section title="Why this hire">
        <p>{body.whyThisHire}</p>
      </Section>
      <Section title="Proposed function">
        <p>
          <Clause text={body.proposedFunction} change={functionChange} pending={strikes.pending} />
        </p>
      </Section>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Goal label="30 days" text={body.shortTermGoals.day30} />
        <Goal label="60 days" text={body.shortTermGoals.day60} />
        <Goal label="90 days" text={body.shortTermGoals.day90} />
      </div>
      <Section title="Will do">
        <ClauseList field="willDo" items={body.proposedBoundaries.willDo} strikes={strikes} />
      </Section>
      <Section title="Will not do">
        <ClauseList field="willNotDo" items={body.proposedBoundaries.willNotDo} strikes={strikes} />
      </Section>
      <Section title="Escalates when">
        <ClauseList
          field="escalationTriggers"
          items={body.proposedBoundaries.escalationTriggers}
          strikes={strikes}
        />
      </Section>
      {manager ? (
        <Section title="Reports to">
          <p>{manager}, the manager named in the header; change it there.</p>
        </Section>
      ) : null}
      {systems.length > 0 ? (
        <Section title="Systems named">
          <p>{systemsLine(systems)}</p>
        </Section>
      ) : null}
      {body.namedCollaborators.length > 0 ? (
        <Section title="People">
          <ul className="grid list-disc gap-1 pl-5">
            {body.namedCollaborators.map((person) => (
              <li key={person.name}>
                <b className="font-semibold">{person.name}</b>, {person.topic}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {adjacent.length > 0 ? (
        <Section title="Adjacent roles">
          <p className="text-sm text-[var(--color-muted)]">Work in their lane is out of scope.</p>
          <ul className="grid list-disc gap-1 pl-5">
            {adjacent.map((role) => (
              <li key={role.who}>
                {role.who} - {role.staysOutOfTheirLaneBy}
              </li>
            ))}
          </ul>
        </Section>
      ) : null}
      {body.priorityReading.length > 0 ? (
        <Section title="Priority reading">
          <p>{body.priorityReading.join(', ')}</p>
        </Section>
      ) : null}
      {open.length > 0 || answered.length > 0 ? (
        <Section title="Open questions">
          <p className="text-sm text-[var(--color-muted)]">
            Asked when a plan first touches them; your answer is written into the charter.
          </p>
          <ul className="grid list-disc gap-1 pl-5">
            {/* An answered question is settled, not struck: a check in the list's marker place,
                the answer under it (walk m20). The strike is a struck rule's mark alone. */}
            {answered.map((entry) => (
              <li key={`answered:${entry.question}`} className="relative list-none">
                <AnsweredMark />
                {entry.question}
                <span className="block text-[var(--color-muted)]">
                  answered by you
                  {Number.isNaN(Date.parse(entry.answeredAt))
                    ? ''
                    : ` at ${clockTime(Date.parse(entry.answeredAt), zone)}`}
                  : <span className="text-[var(--color-fg)]">{entry.answer}</span>
                </span>
              </li>
            ))}
            {open.map((question) => (
              <li key={question}>{question}</li>
            ))}
          </ul>
        </Section>
      ) : null}
    </div>
  );
}
