import type { ReactNode } from 'react';
import Link from 'next/link';
import { avatarById } from '@/agent/avatar-pets';
import { autonomyLabel } from '@/work/autonomy';
import { workItemGlossary } from '@/work/state-display';
import { employeeStateWords, workItemStateLabel, type WorkItemState } from '@/work/state-labels';
import { AgentPixelAvatar, toneClasses } from './PixelAvatar';
import type { RosterRow } from './types';

/** What the parked work waits on, in the order the roster names it, with the count it reads. */
const PARKED_PARTS: ReadonlyArray<
  readonly [state: WorkItemState, count: keyof RosterRow['parkedStates']]
> = [
  ['needs-skill', 'needsSkill'],
  ['deferred', 'deferred'],
  ['discovered', 'discovered'],
];

/**
 * One kind of parked work in the Work tab's words ("2 waiting on a skill", "1 parked"), with what
 * the glossary says it means for the hover (the hosted walk's m10: the roster said "2 parked" for
 * items the page calls "Waiting on a skill"). Only work the manager can release is pointed at
 * Needs you: a discovered row waits on a free slot, which no one releases (the second review's
 * x10).
 *
 * @param state - The state the rows are in.
 */
function parkedPart(state: WorkItemState, count: number): { text: string; title: string } {
  const label = workItemStateLabel({ state }).text;
  const means = workItemGlossary().find((line) => line.states.includes(state))?.means;
  const releasedByYou = state !== 'discovered';
  return {
    text: `${count} ${label.toLocaleLowerCase('en-GB')}`,
    title: `${label}: ${means ?? label}.${
      releasedByYou ? ' The ones only you can release are in Needs you.' : ''
    }`,
  };
}

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

/** What the roster of employees is drawn from. */
export interface EmployeeRosterProps {
  readonly employees: readonly RosterRow[] | undefined;
  readonly waiting: ReadonlyMap<string, number> | undefined;
}

/**
 * The owner's employees as a table: who each is, its state, role and
 * autonomy, what waits on the manager, the work in progress and what it
 * landed this month. Below the `sm` breakpoint the table stacks, each row a
 * two-column grid with every cell carrying its own label.
 *
 * @param employees - The roster, undefined while it loads.
 * @param waiting - The needs-you inbox's count per employee, undefined while it loads.
 */
export function EmployeeRoster({ employees, waiting }: EmployeeRosterProps) {
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
        <table role="table" className="w-full text-left text-sm max-sm:block">
          <thead role="rowgroup" className="max-sm:sr-only">
            <tr
              role="row"
              className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]"
            >
              <th scope="col" role="columnheader" className="px-5 py-2.5 font-medium">
                Employee
              </th>
              {COLUMNS.map((column) => (
                <th
                  key={column}
                  scope="col"
                  role="columnheader"
                  className={`px-3 py-2.5 font-medium last:pr-5 ${NUMERIC.has(column) ? 'sm:text-right' : ''}`}
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          <tbody role="rowgroup" className="max-sm:block">
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

/** One cell of a roster row. */
interface CellProps {
  readonly column: (typeof COLUMNS)[number];
  readonly children: ReactNode;
  readonly className?: string;
}

/** One cell, with the label a stacked row prints above its value. */
function Cell({ column, children, className = '' }: CellProps) {
  return (
    <td
      role="cell"
      className={`px-3 py-3 align-top last:pr-5 max-sm:p-0 ${NUMERIC.has(column) ? 'tabular-nums sm:text-right' : ''} ${className}`}
    >
      {/* The header carries the same word for assistive technology; this copy is visual only. */}
      <span aria-hidden="true" className="mb-1 block text-xs text-[var(--color-muted)] sm:hidden">
        {column}
      </span>
      {children}
    </td>
  );
}

/** What one row of the roster is drawn from. */
interface RosterRowViewProps {
  readonly employee: RosterRow;
  readonly waiting: number | undefined;
  readonly loaded: boolean;
}

function RosterRowView({ employee, waiting, loaded }: RosterRowViewProps) {
  const words = employeeStateWords(employee.state, employee.phase, employee.paused);
  const tone = toneClasses(words.tone);
  const waitingOnManager = waiting ?? 0;
  // Parked and stopped work hold no slot, so each is named under the open count and only when there is some.
  // Functions pushed before this page have no split: their total reads as the parked it mostly is.
  const states = employee.parkedStates as RosterRow['parkedStates'] | undefined;
  const aside = [
    ...(states === undefined
      ? employee.parkedCount > 0
        ? [parkedPart('deferred', employee.parkedCount)]
        : []
      : PARKED_PARTS.flatMap(([state, count]) =>
          states[count] > 0 ? [parkedPart(state, states[count])] : [],
        )),
    ...(employee.stoppedCount > 0
      ? [{ text: `${employee.stoppedCount} stopped`, title: STOPPED_TITLE }]
      : []),
  ];
  const landed = employee.landedThisMonth.days.reduce((sum, day) => sum + day.landed, 0);
  return (
    <tr
      role="row"
      className="border-b border-[var(--color-border)] last:border-b-0 max-sm:grid max-sm:grid-cols-2 max-sm:gap-x-4 max-sm:gap-y-3 max-sm:px-5 max-sm:py-4"
    >
      <th
        scope="row"
        role="rowheader"
        className="px-5 py-3 text-left align-top font-semibold max-sm:col-span-2 max-sm:p-0"
      >
        <Link
          href={`/agent/${employee.agentId}`}
          className="inline-flex min-h-11 items-center gap-2.5 whitespace-nowrap hover:text-[var(--color-accent)]"
        >
          <AgentPixelAvatar
            avatar={avatarById(employee.avatarId)}
            state={employee.state}
            phase={employee.phase}
            paused={employee.paused}
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
          {words.text}
        </span>
      </Cell>
      <Cell column="Role" className="max-sm:col-span-2">
        <span className="text-[var(--color-fg)]/80">{employee.roleLine}</span>
      </Cell>
      <Cell column="Autonomy">
        <AutonomyBadge autonomous={employee.autonomous} />
        <DecisionsReach reach={employee.decisionsReach} />
      </Cell>
      <Cell column="Needs you">
        {loaded ? (
          <span className={waitingOnManager > 0 ? 'text-[var(--color-warn)]' : ''}>
            {waitingOnManager}
          </span>
        ) : (
          <span className="text-[var(--color-muted)]">loading</span>
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

/** Whether an employee acts on its own, for the roster's autonomy column. */
interface AutonomyBadgeProps {
  readonly autonomous: boolean;
}

/** Whether the employee acts on connected systems on its own or asks first. */
function AutonomyBadge({ autonomous }: AutonomyBadgeProps) {
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
      {/* The page's, the pill's and the deploy form's word (walk m10). */}
      {autonomyLabel(autonomous)}
    </span>
  );
}

/** Where one employee's decision requests reach the manager, under its autonomy on the roster. */
interface DecisionsReachProps {
  /** Absent on a row from functions pushed before the line (12-M). */
  readonly reach: RosterRow['decisionsReach'] | undefined;
}

/**
 * The words of a decision DM: its buttons, its typed code, both, or neither (W12V-7: an app that
 * takes no messages takes no typed code, so the manager decides here). A row from functions pushed
 * before the typed code was read carries none and reads as before.
 */
function dmWords(reach: Extract<RosterRow['decisionsReach'], { kind: 'dm' }>): {
  readonly parts: readonly string[];
  readonly title: string;
} {
  const typed = reach.typedCode !== false;
  if (reach.buttons) {
    return {
      parts: ['Requests:', `${reach.channel} DM,`, 'buttons'],
      title: typed
        ? `Each decision request also arrives as a ${reach.channel} DM with Approve and Reject buttons and its typed code`
        : `Each decision request also arrives as a ${reach.channel} DM with Approve and Reject buttons; no typed code reaches the app until it takes messages`,
    };
  }
  return typed
    ? {
        parts: ['Requests:', `${reach.channel} DM,`, 'typed codes'],
        title: `Each decision request also arrives as a ${reach.channel} DM; reply with its typed code`,
      }
    : {
        parts: ['Requests:', `${reach.channel} DM,`, 'decide here'],
        title: `Each decision request also arrives as a ${reach.channel} DM, but neither buttons nor a typed reply work there yet: decide it here`,
      };
}

/**
 * Where the employee's decision requests reach the manager (wave 12, 12-M; H D6): this dashboard
 * only, or also as a DM on its chat channel, with Approve and Reject buttons or with the typed code
 * alone. A line under the autonomy pill, since a column of its own would push the roster past its
 * card and its header would read as the page's other decision figures.
 */
function DecisionsReach({ reach }: DecisionsReachProps) {
  if (reach === undefined) return null;
  // Each part stays whole, so a narrow cell breaks only between the parts.
  const words =
    reach.kind === 'dashboard'
      ? {
          parts: ['Requests:', 'dashboard only'],
          title:
            'Decision requests wait for you in this dashboard; no chat surface carries them yet',
        }
      : dmWords(reach);
  return (
    <span title={words.title} className="mt-1.5 block text-xs text-[var(--color-muted)]">
      {words.parts.map((part, index) => (
        <span key={part} className="whitespace-nowrap">
          {index > 0 ? ' ' : null}
          {part}
        </span>
      ))}
    </span>
  );
}
