'use client';

import { useRef, useState } from 'react';
import { useQuery } from 'convex/react';
import Link from 'next/link';
import { api } from '@convex/_generated/api';
import { useNow } from '../agent/[agentId]/time';
import { useArrival } from '../arrival';
import { CompanySupervision } from '../CompanySupervision';
import { DeployForm } from './DeployForm';
import { EmployeeRoster } from './EmployeeRoster';
import { MonthCard } from './MonthCard';
import { NeedsYouList } from './NeedsYouList';
import { OfficeWorld } from './OfficeWorld';
import { ResetCard } from './ResetCard';
import type { Boss, NeedsYouInbox, RosterRow } from './types';

/**
 * The signed-in home at `/`. With nobody deployed it is the deploy page: the
 * form, what happens after, the empty roster and the office. Once there are
 * employees it is the company home (v3 section 4.2, v2 section 7 step 7):
 * the needs-you inbox, the roster, the office, the month supervised from
 * here and the company's figures, with the form one click away.
 *
 * @param boss - Whoever the page acts for.
 */
export function SignedInDashboard({ boss }: { boss: Boss }) {
  // The roster is the company the page shows; the raw list still decides
  // whether Reset has anything to wipe, evaluation agents included.
  const agents = useQuery(api.agents.listForUser);
  const roster = useQuery(api.agents.rosterForUser);
  const inbox = useQuery(api.work.needsYou);
  const figures = useQuery(api.metrics.forOwner);
  const docSources = useQuery(api.docSources.listMine);
  const surfaceMode = useQuery(api.config.surfaceMode);
  const now = useNow();
  const [deploying, setDeploying] = useState(false);
  const deployToggle = useRef<HTMLButtonElement>(null);
  // The main column's cards arrive with the page (v4 section 1.3); the aside does not move.
  const arriving = useArrival();

  const staffed = roster !== undefined && roster.length > 0;
  const showDeployForm = roster !== undefined && (!staffed || deploying);

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
        </div>
        {staffed ? (
          <button
            ref={deployToggle}
            type="button"
            aria-expanded={deploying}
            aria-controls="deploy-form"
            onClick={() => setDeploying((open) => !open)}
            className="self-start whitespace-nowrap rounded-lg bg-[var(--color-accent)] px-4 py-2.5 text-sm font-medium text-[var(--color-bg)]"
          >
            Deploy another
          </button>
        ) : null}
      </header>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_20rem] xl:items-start">
        <div data-cards={arriving ? '' : undefined} className="flex min-w-0 flex-col gap-6">
          {showDeployForm ? (
            <DeployForm
              boss={boss}
              docSources={docSources}
              surfaceMode={surfaceMode?.mode}
              pickerOpen={!staffed}
              onCancel={
                staffed
                  ? () => {
                      setDeploying(false);
                      // The form and its focus go; the caret returns to the button that opened it.
                      deployToggle.current?.focus();
                    }
                  : undefined
              }
              focusOnMount={staffed}
            />
          ) : null}
          {staffed ? <NeedsYouList inbox={inbox} now={now} /> : null}
          <EmployeeRoster employees={roster} waiting={waitingByEmployee(inbox)} />
          <OfficeWorld
            agents={roster}
            settled={roster !== undefined && (!staffed || inbox !== undefined)}
          />
          {staffed ? (
            <MonthCard roster={roster} figures={figures} waiting={inbox?.total ?? 0} now={now} />
          ) : null}
          <CompanySupervision />
          <ResetCard
            hasEmployees={(agents?.length ?? 0) > 0}
            hasDocumentation={(docSources?.length ?? 0) > 0}
          />
        </div>
        <aside className="flex flex-col gap-6">
          {showDeployForm ? <AfterDeploy /> : null}
          <DocumentationCard sources={docSources?.length} />
        </aside>
      </div>
    </div>
  );
}

/** The company in one line: who is active and how much waits on the manager. */
function companyLine(roster: readonly RosterRow[], inbox: NeedsYouInbox | undefined): string {
  const active = roster.filter((employee) => employee.state === 'active').length;
  const parts = [`${active} active`];
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
      <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
        <h2 className="text-sm font-semibold">Documentation</h2>
        <Link href="/documentation" className="text-sm text-[var(--color-accent)]">
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
