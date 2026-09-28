import { Fragment } from 'react';
import Link from 'next/link';
import { avatarById } from '@/agent/avatar-pets';
import { AgentPixelAvatar } from './PixelAvatar';
import type { RosterRow } from './types';

/** Every employee the owner has, with the queue and what waits on the manager. */
export function EmployeeList({ employees }: { employees: RosterRow[] | undefined }) {
  return (
    <section className="mb-6 overflow-hidden rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Your employees</h2>
        <span className="text-[10px] text-[var(--color-muted)]">
          {employees ? `${employees.length} total` : 'loading'}
        </span>
      </div>
      {employees && employees.length > 0 ? (
        <ul className="divide-y divide-[var(--color-border)]">
          {employees.map((employee) => (
            <EmployeeListRow key={employee.agentId} employee={employee} />
          ))}
        </ul>
      ) : employees ? (
        <p className="px-5 py-4 text-sm text-[var(--color-muted)]">
          No employees yet. Deploy one above.
        </p>
      ) : null}
    </section>
  );
}

/** What "parked" means on the list, for the hover. */
const PARKED_TITLE =
  'Parked: waiting on a connection, a permission, a skill or a free slot. The ones only you can release count under need you.';

/** What "stopped" means on the list, for the hover. */
const STOPPED_TITLE =
  'Stopped: ended short of done, with Retry on the card. The ones waiting on you count under need you.';

function EmployeeListRow({ employee }: { employee: RosterRow }) {
  // Parked and stopped work hold no slot, so each is named beside the open count and only when there is some.
  const queue = [
    `${employee.openCount} open`,
    ...(employee.parkedCount > 0 ? [`${employee.parkedCount} parked`] : []),
    ...(employee.stoppedCount > 0 ? [`${employee.stoppedCount} stopped`] : []),
    `${employee.needsYou} ${employee.needsYou === 1 ? 'needs' : 'need'} you`,
  ];
  const title = [
    ...(employee.parkedCount > 0 ? [PARKED_TITLE] : []),
    ...(employee.stoppedCount > 0 ? [STOPPED_TITLE] : []),
  ].join(' ');
  return (
    <li>
      <Link
        href={`/agent/${employee.agentId}`}
        className="grid grid-cols-[auto_1fr] items-center gap-x-4 gap-y-2 px-5 py-3 transition hover:bg-[var(--color-bg)]/60 sm:grid-cols-[auto_1fr_auto]"
      >
        <AgentPixelAvatar
          avatar={avatarById(employee.avatarId)}
          state={employee.state}
          label={employee.name}
        />
        <div className="min-w-0">
          <p className="text-sm font-semibold">{employee.name}</p>
          <p className="mt-0.5 text-sm leading-snug text-[var(--color-fg)]/70">
            {employee.roleLine}
          </p>
        </div>
        <div className="col-start-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 sm:col-start-auto sm:flex-col sm:items-end">
          <span
            title={title || undefined}
            className={`text-sm tabular-nums ${
              employee.needsYou > 0 ? 'text-[var(--color-warn)]' : 'text-[var(--color-fg)]/70'
            }`}
          >
            {/* Each part stays whole, so a narrow row breaks the line between parts and never inside one. */}
            {queue.map((part, index) => (
              <Fragment key={part}>
                {index > 0 ? ' ' : null}
                <span className="whitespace-nowrap">
                  {index < queue.length - 1 ? `${part} \u00b7` : part}
                </span>
              </Fragment>
            ))}
          </span>
          <AutonomyBadge autonomous={employee.autonomous} />
        </div>
      </Link>
    </li>
  );
}

function AutonomyBadge({ autonomous }: { autonomous: boolean }) {
  return (
    <span
      title={
        autonomous
          ? 'Autonomous actions on: acts on connected systems without asking'
          : 'Autonomous actions off: writes wait for your approval'
      }
      className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${
        autonomous
          ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 text-[var(--color-accent)]'
          : 'border-[var(--color-border)] text-[var(--color-fg)]/70'
      }`}
    >
      {autonomous ? 'acts on its own' : 'asks first'}
    </span>
  );
}
