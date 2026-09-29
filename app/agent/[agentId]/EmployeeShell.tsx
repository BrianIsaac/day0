'use client';

import Link from 'next/link';
import { useRouter, useSelectedLayoutSegment } from 'next/navigation';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { agentZone } from '@/lib/zone';
import { toSurfaceRecord } from '@/surfaces/records';
import { isManagerLookupFailure } from '@/surfaces/manager-lookup';
import type { SurfaceRecord } from '@/surfaces/types';
import { shownEmployeeState } from '@/work/state-labels';
import { useArrival } from '../../arrival';
import { FirstWeekRail } from '../../components/FirstWeekRail';
import { usePreviousValue } from '../../components/previous-value';
import { StatusRegion } from '../../components/StatusRegion';
import { TabPanel, Tabs, type TabItem } from '../../components/Tabs';
import type { ChangeOutcome } from '../../components/use-change';
import { DayZero } from './DayZero';
import { EmployeeContext, type Employee } from './employee-context';
import { addressesEnvironment } from './environment-hash';
import {
  EMPLOYEE_TAB_LABELS,
  EMPLOYEE_TAB_PANEL_ID,
  EMPLOYEE_TABS,
  employeeTabHref,
  tabOfSegment,
  type EmployeeTab,
} from './employee-tabs';
import { EmployeeHeader } from './EmployeeHeader';
import { currentStep, firstWeekSteps } from './first-week';
import { AgentZoneContext } from './time';

/** Said, with focus on the one-to-one, when a charter sent back returns the page to it. */
export const ONBOARDING_REOPENED =
  'The 1:1 is open again, so the employee can redraft the charter from what you tell it.';

/** How long the first-week rail's advance plays: its 150 ms pause and 280 ms slide. */
export const RAIL_ADVANCE_MS = 430;

/** The work states that are finished with: the Work tab counts every other. */
const FINISHED_STATES: ReadonlySet<Doc<'workItems'>['state']> = new Set([
  'completed',
  'skipped',
  'cancelled',
  'failed',
]);

/**
 * The strip's tabs with their counts: what waits on the manager (in warn), the work under way,
 * the skills proposed. A tab with nothing to count draws no badge.
 *
 * @param agentId - The employee.
 * @param counts - The counts, each undefined while its query loads.
 */
export function employeeTabItems(
  agentId: string,
  counts: { readonly needsYou?: number; readonly work?: number; readonly skills?: number },
): TabItem[] {
  const count: Partial<Record<EmployeeTab, number>> = {
    'needs-you': counts.needsYou,
    work: counts.work,
    skills: counts.skills,
  };
  return EMPLOYEE_TABS.map((tab) => ({
    key: tab,
    label: EMPLOYEE_TAB_LABELS[tab],
    href: employeeTabHref(agentId, tab),
    count: count[tab],
    hot: tab === 'needs-you',
  }));
}

/**
 * Whether the employee is on day zero: no charter yet and the one-to-one not held or under way.
 *
 * @param agent - The employee.
 * @param charter - Its newest charter, or null.
 */
export function onDayZero(agent: Pick<Doc<'agents'>, 'state'>, charter: unknown): boolean {
  return charter === null && (agent.state === 'deployed' || agent.state === 'day-one-in-progress');
}

/**
 * The employee page (round two section 3.3 and 3.9): the employee's name, state and zone, the
 * first-week rail, and either the day-zero state or the tab strip over the selected tab's page.
 * Every tab reads the employee through `useEmployee`, so the page loads it once.
 *
 * A hash addressed to the work environment (`#surfaces`, which the Slack OAuth redirect and the
 * cards' links carry) is sent on to the Surfaces tab, where the environment selects the tab it
 * names and scrolls to itself.
 *
 * @param agentId - The employee, from the route.
 */
export function EmployeeShell({
  agentId,
  children,
}: {
  agentId: Id<'agents'>;
  children: ReactNode;
}) {
  const agent = useQuery(api.agents.get, { agentId });
  const latest = useQuery(api.charters.latest, { agentId });
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const surfaceMode = surfaceConfig?.mode;
  const surfaceRows = useQuery(
    api.surfaces.listForAgent,
    surfaceMode === 'real' ? { agentId } : 'skip',
  );
  const inbox = useQuery(api.work.needsYouForAgent, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const proposedSkills = useQuery(api.skills.proposed, { agentId });
  const metrics = useQuery(api.metrics.forAgent, { agentId });
  const segment = useSelectedLayoutSegment();
  const router = useRouter();
  const selected = tabOfSegment(segment);
  const charter = latest ?? null;

  // What a change said once the control that made it left the page with its
  // card (a charter sent back), and where focus goes after it.
  const [pageOutcome, setPageOutcome] = useState<ChangeOutcome | null>(null);
  // The draft the manager sent back, until the page shows what follows it.
  const [sentBack, setSentBack] = useState<Id<'charters'> | null>(null);
  const onboarding = useRef<HTMLDivElement>(null);
  const arriving = useArrival(agent !== undefined && agent !== null);

  const surfaces = useMemo(
    (): SurfaceRecord[] => (surfaceRows ?? []).map((row) => toSurfaceRecord(row)),
    [surfaceRows],
  );
  const dayZero = agent ? onDayZero(agent, charter) : false;
  const steps = agent
    ? firstWeekSteps({
        deployedAt: agent.createdAt,
        state: shownEmployeeState(agent.state, charter),
        charter,
        writeLanded:
          metrics !== undefined && metrics.actions.approved + metrics.actions.automatic.writes > 0,
        writeHeld: (workItems ?? []).some((item) => item.state === 'actions-pending'),
        zone: agentZone(agent),
      })
    : [];
  const step = currentStep(steps);
  const stepBefore = usePreviousValue(step, RAIL_ADVANCE_MS);

  // What follows a draft sent back is the 1:1 again, or, when an approved
  // charter stands beneath the draft, that charter: only the first reopens
  // anything, so only then does the page say so and take focus. A charter
  // drafted later retires the sentence.
  const charterId = charter?._id;
  useEffect(() => {
    if (sentBack !== null && dayZero) {
      onboarding.current?.focus();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- said once, when the 1:1 is back on the page after a draft was sent back
      setPageOutcome({ tone: 'done', text: ONBOARDING_REOPENED });
      setSentBack(null);
    } else if (sentBack !== null && charterId !== undefined && charterId !== sentBack) {
      setSentBack(null);
    } else if (sentBack === null && charterId !== undefined) {
      setPageOutcome(null);
    }
  }, [sentBack, dayZero, charterId]);

  // The environment lives on the Surfaces tab; a hash addressed to it anywhere else goes there.
  useEffect(() => {
    const follow = (): void => {
      if (segment === 'surfaces' || !addressesEnvironment(window.location.hash)) return;
      router.replace(`${employeeTabHref(agentId, 'surfaces')}${window.location.hash}`);
    };
    follow();
    window.addEventListener('hashchange', follow);
    return (): void => window.removeEventListener('hashchange', follow);
  }, [agentId, router, segment]);

  const employee = useMemo(
    (): Employee | null =>
      agent
        ? {
            agent,
            charter,
            surfaceMode,
            surfaces,
            arriving,
            reportSentBack: setSentBack,
          }
        : null,
    [agent, charter, surfaceMode, surfaces, arriving],
  );

  if (!agent || !employee) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }

  const items = employeeTabItems(agentId, {
    needsYou: inbox?.total,
    work: workItems?.filter((item) => !FINISHED_STATES.has(item.state)).length,
    skills: proposedSkills?.length,
  });

  return (
    <AgentZoneContext value={agentZone(agent)}>
      <EmployeeContext value={employee}>
        <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 sm:py-8">
          <nav aria-label="Breadcrumb" className="mb-3 flex items-center gap-2 text-[13px]">
            <Link
              href="/"
              className="inline-flex min-h-11 items-center text-[var(--color-muted)] no-underline hover:text-[var(--color-fg)]"
            >
              Your employees
            </Link>
            <span aria-hidden="true" className="text-[var(--color-border-2)]">
              /
            </span>
            <span aria-current="page" className="truncate font-medium text-[var(--color-fg)]">
              {agent.name}
            </span>
          </nav>
          <EmployeeHeader
            agent={agent}
            charter={charter}
            managerLookupFailure={
              (surfaceRows ?? []).find(
                (row) => row.class === 'chat' && isManagerLookupFailure(row.reason),
              )?.reason
            }
          />
          <StatusRegion outcome={pageOutcome} />
          <FirstWeekRail steps={steps} advanced={stepBefore !== undefined && stepBefore < step} />
          {dayZero ? (
            <div className="mt-6">
              <DayZero onboarding={onboarding} arriving={arriving} />
            </div>
          ) : (
            <>
              <div className="mt-6">
                <Tabs
                  label="Employee page"
                  items={items}
                  selected={selected}
                  panelId={EMPLOYEE_TAB_PANEL_ID}
                />
              </div>
              <div className="mt-5">
                <TabPanel id={EMPLOYEE_TAB_PANEL_ID} selected={selected}>
                  {children}
                </TabPanel>
              </div>
            </>
          )}
        </div>
      </EmployeeContext>
    </AgentZoneContext>
  );
}
