import type { ReactNode } from 'react';
import Link from 'next/link';
import { avatarById } from '@/agent/avatar-pets';
import { EMPLOYEE_STATE_LABEL } from './employee-state';
import { AgentPixelAvatar, agentStateTone } from './PixelAvatar';
import type { RosterRow } from './types';

/** What "parked" means on the roster, for the hover. */
const PARKED_TITLE =
  'Parked: waiting on a connection, a permission, a skill or a free slot. The ones only you can release are in Needs you.';

/** What "stopped" means on the roster, for the hover. */
const STOPPED_TITLE =
  'Stopped: ended short of done, with Retry on the card. The ones waiting on you are in Needs you.';

/** The columns after the employee, in order, as the header and the stacked labels print them. */
const COLUMNS = [
  'State',
  'Role',
  'Autonomy',
  'Needs you',
  'In progress',
  'Landed this month',
] as const;

/** Right-aligned at desktop: the columns that hold a count. */
const NUMERIC: ReadonlySet<(typeof COLUMNS)[number]> = new Set([
  'Needs you',
  'In progress',
  'Landed this month',
]);

/**
 * The owner's employees as a table: who each is, its state, role and
 * autonomy, what waits on the manager, the work in progress and what it
 * landed this month. Below the `sm` breakpoint the table stacks, each row a
 * two-column grid with every cell carrying its own label.
 *
 * @param employees - The roster, undefined while it loads.
 * @param waiting - The needs-you inbox's count per employee, undefined while it loads.
 */
export function EmployeeRoster({
  employees,
  waiting,
}: {
  employees: readonly RosterRow[] | undefined;
  waiting: ReadonlyMap<string, number> | undefined;
}) {
  const staffed = employees !== undefined && employees.length > 0;
  return (
    <section className="overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">{staffed ? 'Roster' : 'Your employees'}</h2>
        <span className="text-xs text-[var(--color-muted)]">
          {employees === undefined
            ? 'loading'
            : staffed
              ? `${employees.length} ${employees.length === 1 ? 'employee' : 'employees'}, one manager`
              : '0 total'}
        </span>
      </div>
      {staffed ? (
        <table className="w-full text-left text-sm max-sm:block">
          <thead className="max-sm:sr-only">
            <tr className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]">
              <th scope="col" className="px-5 py-2.5 font-medium">
                Employee
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  className={`px-3 py-2.5 font-medium last:pr-5 ${NUMERIC.has(column) ? 'sm:text-right' : ''}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="max-sm:block">
            {employees.map((employee) => (
              <RosterRowView
                key={employee.agentId}
                employee={employee}
                waiting={waiting?.get(employee.agentId)}
                loaded={waiting !== undefined}
              />
            ))}
          </tbody>
        </table>
      ) : employees ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">
          No employees yet. Deploy one above.
        </p>
      ) : null}
    </section>
  );
}

/** One cell, with the label a stacked row prints above its value. */
function Cell({
  column,
  children,
  className = '',
}: {
  column: (typeof COLUMNS)[number];
  children: ReactNode;
  className?: string;
}) {
  return (
    <td
      className={`px-3 py-3 align-top last:pr-5 max-sm:p-0 ${NUMERIC.has(column) ? 'tabular-nums sm:text-right' : ''} ${className}`}
    >
      <span className="mb-1 block text-xs text-[var(--color-muted)] sm:hidden">{column}</span>
      {children}
    </td>
  );
}

function RosterRowView({
  employee,
  waiting,
  loaded,
}: {
  employee: RosterRow;
  waiting: number | undefined;
  loaded: boolean;
}) {
  const tone = agentStateTone(employee.state);
  const waitingOnManager = waiting ?? 0;
  // Parked and stopped work hold no slot, so each is named under the open count and only when there is some.
  const aside = [
    ...(employee.parkedCount > 0
      ? [{ text: `${employee.parkedCount} parked`, title: PARKED_TITLE }]
      : []),
    ...(employee.stoppedCount > 0
      ? [{ text: `${employee.stoppedCount} stopped`, title: STOPPED_TITLE }]
      : []),
  ];
  const landed = employee.landedThisMonth.days.reduce((sum, day) => sum + day.landed, 0);
  return (
    <tr className="border-b border-[var(--color-border)] last:border-b-0 max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-4 max-sm:gap-y-3 max-sm:px-5 max-sm:py-4">
      <th
        scope="row"
        className="px-5 py-3 text-left align-top font-semibold max-sm:col-span-2 max-sm:p-0"
      >
        <Link
          href={`/agent/${employee.agentId}`}
          className="inline-flex items-center gap-2.5 whitespace-nowrap hover:text-[var(--color-accent)]"
        >
          <AgentPixelAvatar
            avatar={avatarById(employee.avatarId)}
            state={employee.state}
            label={employee.name}
            size="sm"
          />
          {employee.name}
        </Link>
      </th>
      <Cell column="State">
        <span
          className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${tone.border} ${tone.bg} ${tone.text}`}
        >
          {EMPLOYEE_STATE_LABEL[employee.state]}
        </span>
      </Cell>
      <Cell column="Role" className="max-sm:col-span-2">
        <span className="text-[var(--color-fg)]/80">{employee.roleLine}</span>
      </Cell>
      <Cell column="Autonomy">
        <AutonomyBadge autonomous={employee.autonomous} />
      </Cell>
      <Cell column="Needs you">
        {loaded ? (
          <span className={waitingOnManager > 0 ? 'text-[var(--color-warn)]' : ''}>
            {waitingOnManager}
          </span>
        ) : (
          <span aria-label="loading">…</span>
        )}
      </Cell>
      <Cell column="In progress">
        <span className="block">{employee.openCount}</span>
        {aside.length > 0 ? (
          <span className="block text-xs text-[var(--color-muted)]">
            {aside.map((part, index) => (
              <span key={part.text} title={part.title} className="whitespace-nowrap">
                {index > 0 ? ' · ' : null}
                {part.text}
              </span>
            ))}
          </span>
        ) : null}
      </Cell>
      <Cell column="Landed this month">
        {landed}
        {employee.landedThisMonth.atLeast ? '+' : ''}
      </Cell>
    </tr>
  );
}

/** Whether the employee acts on connected systems on its own or asks first. */
function AutonomyBadge({ autonomous }: { autonomous: boolean }) {
  return (
    <span
      title={
        autonomous
          ? 'Autonomous actions on: acts on connected systems without asking'
          : 'Autonomous actions off: writes wait for your approval'
      }
      className={`inline-block whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        autonomous
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-fg)]/70'
      }`}
    >
      {autonomous ? 'acts on its own' : 'asks first'}
    </span>
  );
}
