'use client';

import { useRef, useState, type FormEvent } from 'react';
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
  identityLabel,
  matchesSlackLine,
  possiblySameLine,
  proposedEmpty,
  proposedInMock,
  proposedLead,
  READING_PEOPLE,
  RELATIONSHIP_NOUNS,
  RELATIONSHIP_SCOPE_LIMIT,
  roleSuffix,
  waitingLine,
} from '@/people/words';
import type { RelationshipType } from '@/people/vocabulary';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
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
            {waiting.map((proposal) => (
              <ProposalRow
                key={proposal.personId}
                proposal={proposal}
                agentId={agentId}
                zone={zone}
                change={change}
                landed={() => card.current}
              />
            ))}
          </ul>
        </div>
      )}
      <StatusRegion outcome={change.outcome} />
    </Card>
  );
}

/** One person waiting on the manager, with the card's buttons for their state. */
function ProposalRow({
  proposal,
  agentId,
  zone,
  change,
  landed,
}: {
  readonly proposal: Proposal;
  readonly agentId: Id<'agents'>;
  readonly zone: string | undefined;
  readonly change: Change;
  readonly landed: () => HTMLElement | null;
}) {
  const confirm = useMutation(api.people.confirm);
  const dismiss = useMutation(api.people.dismiss);
  const samePerson = useMutation(api.people.samePerson);
  const notTheSame = useMutation(api.people.notTheSame);
  const notThisMatch = useMutation(api.people.notThisMatch);
  const { personId, name } = proposal;
  const args = { personId, agentId };
  const role = roleSuffix(proposal.role);
  return (
    <li className={ROW}>
      <p className="text-[15px] text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
        <span className="font-semibold text-[var(--color-fg)]">{name}</span>
        {role}
      </p>
      {proposal.evidence.map((item) => (
        <p
          key={`${item.where}-${item.at}-${item.quote}`}
          className="text-[13px] leading-relaxed text-[var(--color-fg-2)] [overflow-wrap:anywhere]"
        >
          {evidenceLine(item.quote, item.where, clockTime(item.at, zone))}
        </p>
      ))}
      {proposal.status === 'active'
        ? proposal.waiting.map((edge) => (
            <p
              key={`${edge.type}-${edge.scope ?? ''}`}
              className="text-[13px] text-[var(--color-muted)]"
            >
              {waitingLine(RELATIONSHIP_NOUNS[edge.type], edge.scope)}
            </p>
          ))
        : null}
      {proposal.match !== undefined ? (
        <p className="text-[13px] text-[var(--color-fg-2)]">
          {matchesSlackLine(proposal.match.handle)}
        </p>
      ) : null}
      {proposal.possiblySameAs !== undefined ? (
        <p className="text-[13px] text-[var(--color-fg-2)]">
          {possiblySameLine(proposal.possiblySameAs.name)}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {proposal.possiblySameAs !== undefined ? (
          <>
            <Button
              size="small"
              variant="approve"
              disabled={change.busy}
              aria-label={`Same person: ${name} is ${proposal.possiblySameAs.name}`}
              onClick={() =>
                change.run(() => samePerson(args), {
                  done: `${name} is now the same person as ${proposal.possiblySameAs?.name ?? 'the one you know'}.`,
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
              aria-label={`Different: ${name} is not ${proposal.possiblySameAs.name}`}
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
                  done: `Confirmed ${name}.`,
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
                  const identityId = proposal.match?.identityId;
                  if (identityId === undefined) return;
                  change.run(() => notThisMatch({ ...args, identityId }), {
                    done: `Dropped the Slack match for ${name}, and the address it was found by.`,
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
              landed={() => card.current}
            />
          ))}
        </ul>
      )}
      <StatusRegion outcome={change.outcome} />
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
  landed,
}: {
  readonly person: Confirmed;
  readonly agentId: Id<'agents'>;
  readonly zone: string | undefined;
  readonly change: Change;
  readonly landed: () => HTMLElement | null;
}) {
  const retire = useMutation(api.people.retireRelationship);
  const [form, setForm] = useState<RowForm>({ kind: 'none' });
  const { name } = person;
  const role = roleSuffix(person.role);
  return (
    <li className={ROW}>
      <p className="text-[15px] text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
        <span className="font-semibold text-[var(--color-fg)]">{name}</span>
        {role}
      </p>
      {person.evidence !== undefined ? (
        <p className="text-[13px] leading-relaxed text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
          {evidenceLine(
            person.evidence.quote,
            person.evidence.where,
            clockTime(person.evidence.at, zone),
          )}
        </p>
      ) : null}
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
      <ul className="grid gap-2">
        {person.edges.map((edge) => (
          <li
            key={edge.relationshipId}
            className="flex flex-wrap items-center justify-between gap-2"
          >
            <span className="min-w-0 text-[13px] text-[var(--color-fg-2)] [overflow-wrap:anywhere]">
              {edgeLine(
                RELATIONSHIP_NOUNS[edge.type],
                edge.scope,
                clockTime(edge.since, zone),
                !edge.fromEmployee,
              )}
            </span>
            <span className="flex flex-wrap gap-2">
              <Button
                size="small"
                disabled={change.busy}
                aria-label={`Change ${RELATIONSHIP_NOUNS[edge.type]} ${name}`}
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
                aria-label={`End ${RELATIONSHIP_NOUNS[edge.type]} ${name}`}
                onClick={() =>
                  change.run(() => retire({ relationshipId: edge.relationshipId, agentId }), {
                    done: `Ended ${RELATIONSHIP_NOUNS[edge.type]} ${name}.`,
                    refused: `The ${RELATIONSHIP_NOUNS[edge.type]} ${name} was not ended.`,
                    focus: landed,
                  })
                }
              >
                End
              </Button>
            </span>
          </li>
        ))}
      </ul>
      {form.kind === 'none' ? (
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
      ) : (
        <EdgeForm
          person={person}
          agentId={agentId}
          editing={form.kind === 'edit' ? form.edge : undefined}
          change={change}
          onDone={() => setForm({ kind: 'none' })}
          landed={landed}
        />
      )}
    </li>
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
  landed,
}: {
  readonly person: Confirmed;
  readonly agentId: Id<'agents'>;
  readonly editing: Edge | undefined;
  readonly change: Change;
  readonly onDone: () => void;
  readonly landed: () => HTMLElement | null;
}) {
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
          done: `Changed the ${noun} ${person.name}.`,
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
        <Button size="small" variant="quiet" disabled={change.busy} onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
