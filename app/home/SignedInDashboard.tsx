'use client';

import { Suspense, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { useQueries, useQuery } from 'convex/react';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import { employeeStateTally } from '@/work/state-labels';
import { useNow } from '../components/time';
import { useArrival } from '../arrival';
import { CompanySupervision } from '../CompanySupervision';
import { useOwnerPerson } from './use-owner-person';
import { AcceptTransfer } from './AcceptTransfer';
import { AuthorisationUnfinished } from './AuthorisationUnfinished';
import { DeployForm } from './DeployForm';
import { HandedOver } from './HandedOver';
import { EmployeeRoster } from './EmployeeRoster';
import { MonthCard } from './MonthCard';
import { NeedsYouList } from './NeedsYouList';
import { OnItsWay } from './OnItsWay';
import { HandoverEnded } from './HandoverEnded';
import { ReportingElsewhere } from './ReportingElsewhere';
import { OfficeWorld } from './OfficeWorld';
import { RetiredNotice } from '../RetiredNotice';
import { ResetCard } from './ResetCard';
import type { Boss, NeedsYouInbox, RosterRow } from './types';

/**
 * The inbox's read, subscribed through `useQueries` so a failure comes back as a value: the
 * query reads the most of any on the page, and an overrun of Convex's read limits must lose the
 * inbox only, not the roster, the office, the month and Reset with it.
 */
const NEEDS_YOU = { inbox: { query: api.work.needsYou, args: {} } };

/**
 * The needs-you inbox, undefined while it loads and an `Error` when the backend refused the read.
 * Nothing is swallowed: the list says it could not be read, and the rest of the page reads on.
 */
function useNeedsYou(): NeedsYouInbox | undefined | Error {
  const { inbox }: Record<string, NeedsYouInbox | undefined | Error> = useQueries(NEEDS_YOU);
  return inbox;
}

/**
 * The signed-in home at `/`. With nobody deployed it is the deploy page: the
 * form, what happens after, the empty roster and the office. Once there are
 * employees it is the company home (v3 section 4.2, v2 section 7 step 7):
 * the needs-you inbox, the roster, the employees handed over, the office,
 * the month supervised from here and the company's figures, with the form one
 * click away. A handover named to the manager opens its acceptance dialog over
 * the page (the transfer plan, sections 7.3 and 7.4).
 *
 * @param boss - Whoever the page acts for.
 */
export function SignedInDashboard({ boss }: { boss: Boss }) {
  useOwnerPerson();
  const roster = useQuery(api.agents.rosterForUser);
  const inboxRead = useNeedsYou();
  const inbox = inboxRead instanceof Error ? undefined : inboxRead;
  const figures = useQuery(api.metrics.forOwner);
  const docSources = useQuery(api.docSources.listMine);
  const surfaceMode = useQuery(api.config.surfaceMode);
  const reportingElsewhere = useQuery(api.agents.employeesReportingElsewhere);
  const now = useNow();
  const [deploying, setDeploying] = useState(false);
  const deployToggle = useRef<HTMLButtonElement>(null);
  // The main column's cards arrive with the page (v4 section 1.3); the aside does not move.
  const arriving = useArrival();

  const staffed = roster !== undefined && roster.length > 0;
  const held = useMemo(() => roster?.map((employee) => employee.agentId), [roster]);
  // A paused employee's decisions stay answerable; the inbox says so above them (12-P).
  const paused = useMemo(
    () =>
      (roster ?? [])
        .filter((employee) => employee.paused)
        .map(({ agentId, name }) => ({ agentId: String(agentId), name })),
    [roster],
  );
  const showDeployForm = roster !== undefined && (!staffed || deploying);
  // A manager with nobody yet can still be named in a handover (the transfer plan, section 7.3),
  // and one who handed over their only employee still reads where it went (7.4): for them the
  // inbox and the handed-over card come before the deploy form, which is otherwise the page.
  const showInbox = staffed || (inbox !== undefined && inbox.entries.length > 0);

  return (
    <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-10 sm:px-6">
      <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="mb-2 text-3xl font-semibold tracking-tight">
            {staffed ? 'Your employees' : `Welcome${boss.firstName ? `, ${boss.firstName}` : ''}.`}
          </h1>
          <p className="text-sm text-[var(--color-muted)]">
            {staffed
              ? companyLine(roster, inbox)
              : 'Give your first employee a name. Everything else is learned from you.'}
          </p>
          <AuthorisationUnfinished />
          {reportingElsewhere ? <ReportingElsewhere employees={reportingElsewhere} /> : null}
        </div>
        {staffed ? (
          // Hidden while the form it opened is on the page, whose own Cancel closes it (walk m27);
          // kept mounted, so the caret can come back to it.
          <button
            ref={deployToggle}
            type="button"
            hidden={deploying}
            aria-expanded={deploying}
            aria-controls="deploy-form"
            onClick={() => setDeploying((open) => !open)}
            className="inline-flex min-h-11 items-center self-start whitespace-nowrap rounded-lg bg-[var(--color-accent)] px-4 text-sm font-medium text-[var(--color-bg)]"
          >
            Deploy another
          </button>
        ) : null}
      </header>
      <RetiredNotice />
      {/* The acceptance dialog reads its request from the address (`/?transfer=<id>`). */}
      <Suspense fallback={null}>
        <AcceptTransfer />
      </Suspense>
      <OnItsWay />
      <HandoverEnded />

      <div className="grid grid-cols-[minmax(0,1fr)] gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <div
          data-cards={arriving ? '' : undefined}
          className="flex min-w-0 flex-col gap-6 xl:col-start-1 xl:row-start-1"
        >
          {!staffed && showInbox ? (
            <NeedsYouList inbox={inboxRead} now={now} paused={paused} />
          ) : null}
          {staffed ? null : <HandedOver held={held} />}
          {showDeployForm ? (
            <DeployForm
              docSources={docSources}
              surfaceMode={surfaceMode?.mode}
              pickerOpen={!staffed}
              onCancel={
                staffed
                  ? () => {
                      // The form and its focus go; the caret returns to the button that opened
                      // it, shown again first.
                      flushSync(() => setDeploying(false));
                      deployToggle.current?.focus();
                    }
                  : undefined
              }
              focusOnMount={staffed}
            />
          ) : null}
          {staffed ? <NeedsYouList inbox={inboxRead} now={now} paused={paused} /> : null}
          <EmployeeRoster employees={roster} waiting={waitingByEmployee(inbox)} />
          {staffed ? <HandedOver held={held} /> : null}
          <OfficeWorld
            agents={roster}
            settled={roster !== undefined && (!staffed || inboxRead !== undefined)}
          />
          {staffed ? (
            <MonthCard roster={roster} figures={figures} waiting={inbox?.total ?? 0} now={now} />
          ) : null}
          <CompanySupervision />
        </div>
        <aside className="flex flex-col gap-6 xl:col-start-2 xl:row-span-2 xl:row-start-1">
          {showDeployForm ? <AfterDeploy /> : null}
          <DocumentationCard sources={docSources?.length} />
        </aside>
        {/* After the aside in the page's order, so on a phone, and for the keyboard and a screen
            reader at any width, what Deploy does comes before the card that wipes (walk m17); at
            xl it sits under the main column. */}
        <div
          data-cards={arriving ? '' : undefined}
          className="min-w-0 xl:col-start-1 xl:row-start-2"
        >
          <ResetCard mode={surfaceMode?.mode} />
        </div>
      </div>
    </div>
  );
}

/**
 * The company in one line: how many stand at each state, counted by the words the roster's chips
 * print, and how much waits on the manager, counted by the inbox the roster's column reads, so
 * the line and the roster below it say the same thing (the production walk's 6d).
 */
function companyLine(roster: readonly RosterRow[], inbox: NeedsYouInbox | undefined): string {
  const parts = employeeStateTally(roster).map(
    ({ text, count }) => `${count} ${text.charAt(0).toLocaleLowerCase('en-GB')}${text.slice(1)}`,
  );
  if (inbox) parts.push(`${inbox.total} ${inbox.total === 1 ? 'thing needs' : 'things need'} you`);
  return parts.join(' · ');
}

/** The inbox's count per employee, for the roster's column. */
function waitingByEmployee(inbox: NeedsYouInbox | undefined): Map<string, number> | undefined {
  return inbox
    ? new Map(inbox.waitingByEmployee.map(({ agentId, waiting }) => [agentId, waiting]))
    : undefined;
}

/** What the first week holds once the manager presses Deploy. */
function AfterDeploy() {
  const steps = [
    'Your employee asks you for a five-minute one-to-one, in chat or voice.',
    'It drafts a charter from your answers; you confirm or strike each rule.',
    'Approval fills its work queue. Every write is held for you.',
  ];
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      <h2 className="border-b border-[var(--color-border)] px-5 py-4 text-sm font-semibold">
        What happens after Deploy
      </h2>
      <ol className="flex flex-col gap-3 p-5 text-sm">
        {steps.map((step, index) => (
          <li key={step} className="grid grid-cols-[1.25rem_1fr] gap-2">
            <span className="tabular-nums text-[var(--color-muted)]">{index + 1}</span>
            {step}
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The owner's documentation: how much is linked, and where it is managed. */
function DocumentationCard({ sources }: { sources: number | undefined }) {
  return (
    <section className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)]">
      {/* The link's 44 px target (N14) takes the header's height; the padding makes up the rest. */}
      <div className="flex items-center justify-between border-b border-[var(--color-border)] py-1 pl-5 pr-2">
        <h2 className="text-sm font-semibold">Documentation</h2>
        <Link
          href="/documentation"
          className="inline-flex min-h-11 items-center px-3 text-sm text-[var(--color-accent)]"
        >
          Manage
        </Link>
      </div>
      <p className="px-5 py-4 text-sm text-[var(--color-muted)]">
        {sources === undefined
          ? 'Loading'
          : sources === 0
            ? 'No documentation linked yet. Your employees learn the team from what you link.'
            : `${sources} ${sources === 1 ? 'source' : 'sources'} linked. Every employee reads them unless you leave one out at deploy.`}
      </p>
    </section>
  );
}
