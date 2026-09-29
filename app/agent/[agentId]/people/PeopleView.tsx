'use client';

import type { Doc } from '@convex/_generated/dataModel';
import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { connectedManagerChannel } from '../manager-channel';
import { clockTime, useAgentZone, useNow } from '../../../components/time';
import { ChangeManager } from './ChangeManager';

/** How the employee reaches a person the charter names, as the one-to-one settled it. */
export type IntroPath = 'manager' | 'self' | 'tbd';

/** A person the charter names, as the People tab reads the charter's body. */
export interface NamedPerson {
  readonly name: string;
  readonly topic: string;
  /** Absent on a charter drafted before the one-to-one asked how to reach each person. */
  readonly introPath?: IntroPath;
}

/** How the employee reaches each person, in the manager's words. */
const INTRO_WORDS: Readonly<Record<IntroPath, string>> = {
  manager: 'you introduce them',
  self: 'reaches out directly',
  tbd: 'how to reach them is not settled',
};

/**
 * Whether a stored value is one of the introduction paths.
 *
 * @param value - What the charter row holds.
 */
function isIntroPath(value: unknown): value is IntroPath {
  return value === 'manager' || value === 'self' || value === 'tbd';
}

/**
 * The people a charter names, read defensively: a charter drafted before the list existed, or a
 * row missing a field, names nobody rather than breaking the tab.
 *
 * @param body - The charter's stored body.
 */
export function namedPeople(body: unknown): NamedPerson[] {
  if (typeof body !== 'object' || body === null) return [];
  const listed: unknown = (body as { namedCollaborators?: unknown }).namedCollaborators;
  if (!Array.isArray(listed)) return [];
  return listed.flatMap((entry: unknown): NamedPerson[] => {
    if (typeof entry !== 'object' || entry === null) return [];
    const { name, topic, introPath } = entry as {
      name?: unknown;
      topic?: unknown;
      introPath?: unknown;
    };
    if (typeof name !== 'string' || name.trim() === '') return [];
    return [
      {
        name,
        topic: typeof topic === 'string' ? topic : '',
        ...(isIntroPath(introPath) ? { introPath } : {}),
      },
    ];
  });
}

/**
 * Where the charter's people stand, for the line under each: the charter version that names them
 * and whether the manager approved it. The one-to-one names them first and an amendment can add
 * one; the row does not say which, so the line does not either.
 *
 * @param charter - The charter the tab reads.
 * @param zone - The employee's zone, for the approval's date.
 */
export function provenanceLine(charter: Doc<'charters'>, zone: string | undefined): string {
  const version = `charter version ${charter.version}`;
  if (!charter.approved) return `Named in ${version}, not approved yet.`;
  return charter.approvedAt === undefined
    ? `Named in ${version}, approved by you.`
    : `Named in ${version}, approved by you ${clockTime(charter.approvedAt, zone)}.`;
}

/**
 * The People tab (round two section 3.9, `agent-people.html`), as far as the product records
 * people: the manager with Change manager and what the change moves (U9, Q6), and the people the
 * charter names from the one-to-one with where each came from and how the employee reaches them.
 * The proposals the drawing confirms from a card (from the team pages and the one-to-one, matched
 * to a chat account) wait on the people records (A1); the tab says so rather than drawing
 * controls that do nothing.
 */
export function PeopleView() {
  const { agent, charter, surfaceMode, surfaces, arriving } = useEmployee();
  const zone = useAgentZone();
  const now = useNow();
  const named = namedPeople(charter?.body);
  const channel = surfaceMode === 'real' && connectedManagerChannel(surfaces, now) !== undefined;
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <Card title={`What ${agent.name} reads from this`}>
            <p className="text-sm text-[var(--color-fg-2)]">
              Each name, what they are the person for and how to reach them, under Key relationships
              in the identity file {agent.name} works from, rewritten whenever the charter changes.
              No account or credential of theirs.
            </p>
          </Card>
          <EmployeeRail />
        </>
      }
    >
      <Card title="Manager">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <p className="flex flex-wrap items-center gap-2 text-[15px]">
              <span className="font-mono break-all">{agent.bossEmail}</span>
              <Chip tone="you">manager</Chip>
            </p>
            <p className="text-sm text-[var(--color-fg-2)]">
              Every held write and every plan comes to you. One manager per employee.
            </p>
          </div>
          {surfaceMode === undefined ? null : (
            <ChangeManager agent={agent} mode={surfaceMode} channel={channel} />
          )}
        </div>
      </Card>
      <Card title="Named in the charter" meta={named.length > 0 ? `${named.length}` : undefined}>
        {named.length === 0 || charter === null ? (
          <p className="text-sm text-[var(--color-muted)]">
            The charter names nobody yet. The Day-1 one-to-one asks who {agent.name} works with.
          </p>
        ) : (
          <ul className="grid gap-4">
            {named.map((person, index) => (
              // Two people can share a name; their place in the charter tells them apart.
              <li key={`${index}-${person.name}`} className="grid gap-0.5">
                <p className="text-[15px] text-[var(--color-fg-2)]">
                  <span className="font-semibold text-[var(--color-fg)]">{person.name}</span>
                  {person.topic ? ` · ${person.topic}` : null}
                  {person.introPath ? ` · ${INTRO_WORDS[person.introPath]}` : null}
                </p>
                <p className="text-[13px] text-[var(--color-muted)]">
                  {provenanceLine(charter, zone)}
                </p>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Proposed">
        <p className="text-sm text-[var(--color-fg-2)]">
          {agent.name} does not propose people for you to confirm yet. The names above are the ones
          your one-to-one gave the charter; to add or remove one, amend the charter.
        </p>
      </Card>
    </Columns>
  );
}
