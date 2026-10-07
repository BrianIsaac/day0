'use client';

import { useEffect, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import type { FunctionReturnType } from 'convex/server';
import {
  confirmAsLabel,
  confirmedByYouLine,
  confirmedEmpty,
  edgeLine,
  EMPLOYEE_RELATIONSHIP_TYPES,
  evidenceLine,
  evidenceText,
  identityLabel,
  lookupFailedLine,
  matchesSlackLine,
  moreEvidence,
  possiblySameLine,
  proposedChangeLine,
  proposedEdgeLine,
  proposedEmpty,
  proposedInMock,
  proposedLead,
  READING_PEOPLE,
  RELATIONSHIP_NOUNS,
  RELATIONSHIP_SCOPE_LIMIT,
  roleSuffix,
  sameOrDifferentHelp,
  waitingLine,
} from '@/people/words';
import type { RelationshipType } from '@/people/vocabulary';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Disclosure } from '../../../components/Disclosure';
import { Field, INPUT_CLASS } from '../../../components/Field';
import { StatusRegion } from '../../../components/StatusRegion';
import { clockTime } from '../../../components/time';
import { useChange, type Change } from '../../../components/use-change';

/*
 * The People tab's graph (wave 13, 13-P; the wave file's sections 5.2 and 7, `agent-people.html`):
 * the people waiting on the manager, each with its evidence and the card's Confirm, A different
 * person, Dismiss, Same person and Different; and the confirmed people the employee's edges reach,
 * with their identities and each edge's Change and End, and a relationship to add. Every change
 * goes through `useChange`, says itself in the card's one status region and lands focus on the card
 * when the control that made it leaves.
 */

/** What `people.forEmployee` answers. */
export type EmployeePeople = FunctionReturnType<typeof api.people.forEmployee>;

/** One person waiting on the manager. */
type Proposal = EmployeePeople['proposals'][number];

/** One confirmed person. */
type Confirmed = EmployeePeople['confirmed'][number];

/** One edge of a confirmed person. */
type Edge = Confirmed['edges'][number];

/** The classes of one row of a card's list. */
const ROW = 'grid gap-2 border-t border-[var(--color-border)] pt-5 first:border-t-0 first:pt-0';

/** What both cards are drawn for. */
interface GraphCardProps {
  readonly agentId: Id<'agents'>;
  readonly employee: string;
  readonly zone: string | undefined;
}

/** The attribute a row of a card's list carries, so focus can find the row that follows a decision. */
const PERSON_ROW = 'data-person';

/**
 * Where focus lands once a decision on a row is said: the heading of the row named, else the card,
 * since the pressed control may leave with its row. Read when the change lands, never in render.
 *
 * @param card - The card.
 * @param row - The person whose row should take focus.
 */
function headingOf(
  card: RefObject<HTMLElement | null>,
  row: string | undefined,
): HTMLElement | null {
  return (
    (row === undefined
      ? null
      : card.current?.querySelector<HTMLElement>(`[${PERSON_ROW}="${row}"] h3`)) ?? card.current
  );
}

/**
 * The Proposed card: the people waiting on the manager, in real mode; in mock mode, where no graph
 * is kept, what a deployment of the manager's own does.
 */
export function ProposedPeopleCard({
  agentId,
  employee,
  zone,
  people,
  mode,
}: GraphCardProps & {
  readonly people: EmployeePeople | undefined;
  readonly mode: 'mock' | 'real' | undefined;
}) {
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const waiting = people?.proposals ?? [];
  return (
    <Card
      title="Proposed"
      meta={waiting.length > 0 ? `${waiting.length} waiting on you` : undefined}
      tone={waiting.length > 0 ? 'warn' : undefined}
      focusRef={card}
    >
      {mode === 'mock' ? (
        <p className="text-sm text-[var(--color-fg-2)]">{proposedInMock(employee)}</p>
      ) : people === undefined || mode === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">{READING_PEOPLE}</p>
      ) : waiting.length === 0 ? (
        <p className="text-sm text-[var(--color-fg-2)]">{proposedEmpty(employee)}</p>
      ) : (
        <div className="grid gap-4">
          <p className="text-sm text-[var(--color-fg-2)]">{proposedLead(employee)}</p>
          <ul className="grid gap-5">
            {waiting.map((proposal, index) => (
              <ProposalRow
                key={proposal.personId}
                proposal={proposal}
                agentId={agentId}
                zone={zone}
                change={change}
                card={card}
                next={(waiting[index + 1] ?? waiting[index - 1])?.personId}
              />
            ))}
          </ul>
        </div>
      )}
      <div className="mt-1">
        <StatusRegion outcome={change.outcome} />
      </div>
    </Card>
  );
}

/** A person's name as a row's heading, which focus lands on after a decision. */
function PersonHeading({
  name,
  role,
}: {
  readonly name: string;
  readonly role: string | undefined;
}) {
  return (
    <h3
      tabIndex={-1}
      className="text-[15px] font-normal text-[var(--color-fg-2)] [overflow-wrap:anywhere] focus:outline-none focus-visible:outline-2"
    >
      <span className="font-semibold text-[var(--color-fg)]">{name}</span>
      {roleSuffix(role)}
    </h3>
  );
}

/** A person's evidence: the first piece, and the rest behind a disclosure. */
function EvidenceList({
  evidence,
  zone,
}: {
  readonly evidence: readonly { quote: string; where: string; at: number }[];
  readonly zone: string | undefined;
}) {
  const [first, ...rest] = evidence;
  if (first === undefined) return null;
  const line = (item: { quote: string; where: string; at: number }): string =>
    evidenceLine(evidenceText(item.quote), item.where, clockTime(item.at, zone));
  return (
    <div className="grid gap-1">
      <p className="text-[13px] leading-relaxed text-[var(--color-muted)] [overflow-wrap:anywhere]">
        {line(first)}
      </p>
      {rest.length === 0 ? null : (
        <Disclosure summary={moreEvidence(rest.length)}>
          <ul className="grid gap-1">
            {rest.map((item, index) => (
              <li
                key={`${index}-${item.at}`}
                className="text-[13px] leading-relaxed text-[var(--color-muted)] [overflow-wrap:anywhere]"
              >
                {line(item)}
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}

/** One person waiting on the manager, with the card's buttons for their state. */
function ProposalRow({
  proposal,
  agentId,
  zone,
  change,
  card,
  next,
}: {
  readonly proposal: Proposal;
  readonly agentId: Id<'agents'>;
  readonly zone: string | undefined;
  readonly change: Change;
  readonly card: RefObject<HTMLElement | null>;
  /** The row that takes focus once this one is decided and leaves. */
  readonly next: string | undefined;
}) {
  const landed = (): HTMLElement | null => headingOf(card, next);
  const confirm = useMutation(api.people.confirm);
  const dismiss = useMutation(api.people.dismiss);
  const samePerson = useMutation(api.people.samePerson);
  const notTheSame = useMutation(api.people.notTheSame);
  const notThisMatch = useMutation(api.people.notThisMatch);
  const { personId, name } = proposal;
  const args = { personId, agentId };
  const offered = proposal.possiblySameAs;
  const offeredStanding =
    offered === undefined
      ? ''
      : offered.standing === 'confirmed'
        ? 'already confirmed'
        : 'also proposed';
  return (
    <li className={ROW} {...{ [PERSON_ROW]: personId }}>
      <PersonHeading name={name} role={proposal.role} />
      {proposal.waiting.map((edge, index) => (
        <p
          key={`${index}-${edge.type}`}
          className="text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]"
        >
          {proposal.status === 'active'
            ? waitingLine(RELATIONSHIP_NOUNS[edge.type], edge.scope)
            : proposedEdgeLine(RELATIONSHIP_NOUNS[edge.type], edge.scope)}
        </p>
      ))}
      {proposal.match !== undefined ? (
        <p className="text-sm text-[var(--color-fg-2)]">
          {matchesSlackLine(proposal.match.handle)}
        </p>
      ) : null}
      {offered !== undefined ? (
        <p className="text-sm text-[var(--color-fg-2)]">
          {possiblySameLine(offered.name, offered.standing, offered.role)}
        </p>
      ) : null}
      <EvidenceList evidence={proposal.evidence} zone={zone} />
      {offered !== undefined ? (
        <p className="text-[13px] text-[var(--color-muted)]">{sameOrDifferentHelp(offered.name)}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {offered !== undefined ? (
          <>
            <Button
              size="small"
              variant="approve"
              disabled={change.busy}
              aria-label={`Same person: ${name} is the ${offered.name} ${offeredStanding}`}
              onClick={() =>
                change.run(() => samePerson(args), {
                  done: `${name} is now the same person as ${offered.name}.`,
                  refused: `${name} was not merged.`,
                  focus: landed,
                })
              }
            >
              Same person
            </Button>
            <Button
              size="small"
              disabled={change.busy}
              aria-label={`Different: ${name} is not the ${offered.name} ${offeredStanding}`}
              onClick={() =>
                change.run(() => notTheSame(args), {
                  done: `${name} stays a proposal of its own.`,
                  refused: `${name} was not kept apart.`,
                })
              }
            >
              Different
            </Button>
          </>
        ) : (
          <>
            <Button
              size="small"
              variant="approve"
              disabled={change.busy}
              aria-label={
                proposal.match === undefined
                  ? `Confirm ${name}`
                  : `${confirmAsLabel(proposal.match.handle)}: ${name}`
              }
              onClick={() =>
                change.run(() => confirm(args), {
                  done: `Confirmed ${name}: now under Confirmed.`,
                  refused: `${name} was not confirmed.`,
                  focus: landed,
                })
              }
            >
              {proposal.match === undefined ? 'Confirm' : confirmAsLabel(proposal.match.handle)}
            </Button>
            {proposal.match !== undefined ? (
              <Button
                size="small"
                disabled={change.busy}
                aria-label={`A different person: ${name} is not @${proposal.match.handle}`}
                onClick={() => {
                  const match = proposal.match;
                  if (match === undefined) return;
                  change.run(() => notThisMatch({ ...args, identityId: match.identityId }), {
                    done: `${name} is no longer matched to @${match.handle}.`,
                    refused: `The match for ${name} was not dropped.`,
                  });
                }}
              >
                A different person
              </Button>
            ) : null}
            <Button
              size="small"
              variant="quiet"
              disabled={change.busy}
              aria-label={`Dismiss ${name}`}
              onClick={() =>
                change.run(() => dismiss(args), {
                  done: `Dismissed ${name}.`,
                  refused: `${name} was not dismissed.`,
                  focus: landed,
                })
              }
            >
              Dismiss
            </Button>
          </>
        )}
      </div>
    </li>
  );
}

/** The Confirmed card: the confirmed people the employee's edges in force reach. */
export function ConfirmedPeopleCard({
  agentId,
  employee,
  zone,
  people,
}: GraphCardProps & { readonly people: EmployeePeople }) {
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const confirmed = people.confirmed;
  return (
    <Card
      title="Confirmed"
      meta={confirmed.length > 0 ? `${confirmed.length}` : undefined}
      focusRef={card}
    >
      {confirmed.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">{confirmedEmpty(employee)}</p>
      ) : (
        <ul className="grid gap-5">
          {confirmed.map((person) => (
            <ConfirmedRow
              key={person.personId}
              person={person}
              agentId={agentId}
              zone={zone}
              change={change}
              card={card}
            />
          ))}
        </ul>
      )}
      <div className="mt-1">
        <StatusRegion outcome={change.outcome} />
      </div>
    </Card>
  );
}

/** Which of a confirmed person's forms is open: none, a new edge, or a change to one edge. */
type RowForm =
  | { readonly kind: 'none' }
  | { readonly kind: 'add' }
  | { readonly kind: 'edit'; readonly edge: Edge };

/** One confirmed person: who they are, how they were confirmed, their identities and edges. */
function ConfirmedRow({
  person,
  agentId,
  zone,
  change,
  card,
}: {
  readonly person: Confirmed;
  readonly agentId: Id<'agents'>;
  readonly zone: string | undefined;
  readonly change: Change;
  readonly card: RefObject<HTMLElement | null>;
}) {
  const landed = (): HTMLElement | null => headingOf(card, person.personId);
  const retire = useMutation(api.people.retireRelationship);
  const [form, setForm] = useState<RowForm>({ kind: 'none' });
  const row = useRef<HTMLLIElement>(null);
  const { name } = person;
  // A form closed by Cancel hands focus back to the row it was opened on.
  const close = (): void => {
    setForm({ kind: 'none' });
    requestAnimationFrame(() => row.current?.querySelector<HTMLElement>('h3')?.focus());
  };
  const edgeForm = (editing: Edge | undefined): ReactNode => (
    <EdgeForm
      person={person}
      agentId={agentId}
      editing={editing}
      change={change}
      onDone={() => setForm({ kind: 'none' })}
      onCancel={close}
      landed={landed}
    />
  );
  return (
    <li className={ROW} ref={row} {...{ [PERSON_ROW]: person.personId }}>
      <PersonHeading name={name} role={person.role} />
      <p className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
        {[
          ...(person.confirmedAt === undefined
            ? []
            : [confirmedByYouLine(clockTime(person.confirmedAt, zone))]),
          ...(person.identities.length === 0
            ? []
            : [`Identities: ${person.identities.map(identityLabel).join(', ')}.`]),
        ].join(' ')}
      </p>
      <ul className="grid gap-3">
        {person.edges.map((edge) => {
          const noun = RELATIONSHIP_NOUNS[edge.type];
          return (
            <li key={edge.relationshipId} className="grid gap-2">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
                <span className="min-w-0 text-sm text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
                  {edgeLine(noun, edge.scope, clockTime(edge.since, zone), !edge.fromEmployee)}
                </span>
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="small"
                    disabled={change.busy}
                    aria-label={`Change ${noun} ${name}`}
                    onClick={() => {
                      change.clear();
                      setForm({ kind: 'edit', edge });
                    }}
                  >
                    Change
                  </Button>
                  <Button
                    size="small"
                    variant="quiet"
                    disabled={change.busy}
                    aria-label={`End ${noun} ${name}`}
                    onClick={() =>
                      change.run(() => retire({ relationshipId: edge.relationshipId, agentId }), {
                        done: edge.fromEmployee
                          ? `Ended ${noun} ${name}.`
                          : `Ended ${noun} ${name}, for everyone you manage.`,
                        refused: `The ${noun} ${name} was not ended.`,
                        focus: landed,
                      })
                    }
                  >
                    End
                  </Button>
                </span>
              </div>
              {form.kind === 'edit' && form.edge.relationshipId === edge.relationshipId
                ? edgeForm(edge)
                : null}
            </li>
          );
        })}
      </ul>
      {person.evidence !== undefined ? (
        <EvidenceList evidence={[person.evidence]} zone={zone} />
      ) : null}
      {person.lookupFailedAt !== undefined ? (
        <p className="text-[13px] text-[var(--color-muted)] [overflow-wrap:anywhere]">
          {lookupFailedLine(name, clockTime(person.lookupFailedAt, zone))}
        </p>
      ) : null}
      {person.proposedChange !== undefined ? (
        <ProposedChange
          name={name}
          proposed={person.proposedChange}
          args={{ personId: person.personId, agentId }}
          zone={zone}
          change={change}
          landed={landed}
        />
      ) : null}
      {form.kind === 'add' ? (
        edgeForm(undefined)
      ) : (
        <div>
          <Button
            size="small"
            variant="text"
            disabled={change.busy}
            aria-label={`Add a relationship with ${name}`}
            onClick={() => {
              change.clear();
              setForm({ kind: 'add' });
            }}
          >
            Add a relationship
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * A source's proposed change to a confirmed person (W13-R3): what it proposes, the words it came
 * from, and Take or Dismiss.
 */
function ProposedChange({
  name,
  proposed,
  args,
  zone,
  change,
  landed,
}: {
  readonly name: string;
  readonly proposed: NonNullable<Confirmed['proposedChange']>;
  readonly args: { readonly personId: Id<'people'>; readonly agentId: Id<'agents'> };
  readonly zone: string | undefined;
  readonly change: Change;
  readonly landed: () => HTMLElement | null;
}) {
  const take = useMutation(api.personChanges.take);
  const dismiss = useMutation(api.personChanges.dismiss);
  return (
    <div className="grid gap-2">
      <p className="text-sm text-[var(--color-fg)] [overflow-wrap:anywhere]">
        {proposedChangeLine(proposed.where, proposed)}
      </p>
      <EvidenceList
        evidence={[{ quote: proposed.quote, where: proposed.where, at: proposed.at }]}
        zone={zone}
      />
      <div className="flex flex-wrap gap-2">
        <Button
          size="small"
          variant="approve"
          disabled={change.busy}
          aria-label={`Take the proposed change for ${name}`}
          onClick={() =>
            change.run(() => take(args), {
              done: `Took the proposed change for ${name}.`,
              refused: `The proposed change for ${name} was not taken.`,
              focus: landed,
            })
          }
        >
          Take
        </Button>
        <Button
          size="small"
          variant="quiet"
          disabled={change.busy}
          aria-label={`Dismiss the proposed change for ${name}`}
          onClick={() =>
            change.run(() => dismiss(args), {
              done: `Dismissed the proposed change for ${name}.`,
              refused: `The proposed change for ${name} was not dismissed.`,
              focus: landed,
            })
          }
        >
          Dismiss
        </Button>
      </div>
    </div>
  );
}

/** The types an edge form offers: an employee's own, or the edge's own type for an owner-wide one. */
function typesFor(editing: Edge | undefined): readonly RelationshipType[] {
  return editing !== undefined && !editing.fromEmployee
    ? [editing.type]
    : EMPLOYEE_RELATIONSHIP_TYPES;
}

/** The form that adds an edge to a confirmed person, or changes one (an edit supersedes it). */
function EdgeForm({
  person,
  agentId,
  editing,
  change,
  onDone,
  onCancel,
  landed,
}: {
  readonly person: Confirmed;
  readonly agentId: Id<'agents'>;
  readonly editing: Edge | undefined;
  readonly change: Change;
  /** Closes the form once its change is said; focus then lands where `landed` says. */
  readonly onDone: () => void;
  /** Closes the form unchanged and hands focus back to its row. */
  readonly onCancel: () => void;
  readonly landed: () => HTMLElement | null;
}) {
  const first = useRef<HTMLSelectElement>(null);
  // The form takes focus when it opens: the control that opened it has gone.
  useEffect(() => first.current?.focus(), []);
  const add = useMutation(api.people.addRelationship);
  const edit = useMutation(api.people.editRelationship);
  const types = typesFor(editing);
  const [type, setType] = useState<RelationshipType>(editing?.type ?? types[0] ?? 'collaborator');
  const [scope, setScope] = useState(editing?.scope ?? '');
  const tooLong = scope.trim().length > RELATIONSHIP_SCOPE_LIMIT;
  const noun = RELATIONSHIP_NOUNS[type];
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (tooLong) return;
    const covered = scope.trim() === '' ? {} : { scope: scope.trim() };
    if (editing !== undefined) {
      change.run(
        () => edit({ relationshipId: editing.relationshipId, agentId, type, ...covered }),
        {
          done: `Changed ${person.name} to ${noun}.`,
          refused: `The relationship with ${person.name} was not changed.`,
          after: onDone,
          focus: landed,
        },
      );
      return;
    }
    const employeeType = EMPLOYEE_RELATIONSHIP_TYPES.find((candidate) => candidate === type);
    if (employeeType === undefined) return;
    change.run(() => add({ personId: person.personId, agentId, type: employeeType, ...covered }), {
      done: `Added ${person.name} as ${noun}.`,
      refused: `The relationship with ${person.name} was not added.`,
      after: onDone,
      focus: landed,
    });
  };
  return (
    <form
      className="grid gap-3 rounded-lg border border-[var(--color-border)] p-3"
      onSubmit={submit}
    >
      <Field label="Relationship">
        {(control) => (
          <select
            {...control}
            ref={first}
            className={`${INPUT_CLASS} w-full`}
            disabled={change.busy || types.length === 1}
            value={type}
            onChange={(event) => {
              const chosen = types.find((candidate) => candidate === event.target.value);
              if (chosen !== undefined) setType(chosen);
            }}
          >
            {types.map((candidate) => (
              <option key={candidate} value={candidate}>
                {RELATIONSHIP_NOUNS[candidate]}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field
        label="What it covers"
        hint="Optional, in your words."
        error={tooLong ? `Keep it to ${RELATIONSHIP_SCOPE_LIMIT} characters.` : undefined}
      >
        {(control) => (
          <input
            {...control}
            className={`${INPUT_CLASS} w-full`}
            disabled={change.busy}
            value={scope}
            onChange={(event) => setScope(event.target.value)}
          />
        )}
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="small" variant="primary" disabled={change.busy || tooLong}>
          {editing === undefined ? 'Add' : 'Save'}
        </Button>
        <Button size="small" variant="quiet" disabled={change.busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
