'use client';

import { Card } from '../../../components/Card';
import { Chip } from '../../../components/Chip';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';

/** A person the charter names, as the People tab reads the charter's body. */
export interface NamedPerson {
  readonly name: string;
  readonly topic: string;
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
    const { name, topic } = entry as { name?: unknown; topic?: unknown };
    return typeof name === 'string' && name.trim() !== ''
      ? [{ name, topic: typeof topic === 'string' ? topic : '' }]
      : [];
  });
}

/**
 * The People tab, as far as the product records people today: the manager, and the people the
 * charter names from the one-to-one. Proposing, confirming and matching people to their accounts
 * wait on the people records (A1); the tab says so rather than drawing controls that do nothing.
 */
export function PeopleView() {
  const { agent, charter, arriving } = useEmployee();
  const named = namedPeople(charter?.body);
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <Card title="Manager">
        <p className="flex flex-wrap items-center gap-2 text-[15px]">
          <span className="font-mono break-all">{agent.bossEmail}</span>
          <Chip tone="you">manager</Chip>
        </p>
        <p className="mt-2 text-sm text-[var(--color-fg-2)]">
          Every held write and every plan comes to you. One manager per employee: change it from the
          line under {agent.name}&apos;s name.
        </p>
      </Card>
      <Card title="Named in the charter" meta={named.length > 0 ? `${named.length}` : undefined}>
        {named.length === 0 ? (
          <p className="text-sm text-[var(--color-muted)]">
            The charter names nobody yet. The Day-1 one-to-one asks who {agent.name} works with.
          </p>
        ) : (
          <ul className="grid gap-2 text-sm">
            {named.map((person) => (
              <li key={person.name} className="text-[var(--color-fg-2)]">
                <span className="font-medium text-[var(--color-fg)]">{person.name}</span>
                {person.topic ? ` · ${person.topic}` : null}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-[13px] text-[var(--color-muted)]">
          {agent.name} does not propose people for you to confirm yet; these are the names your
          one-to-one gave the charter.
        </p>
      </Card>
    </Columns>
  );
}
