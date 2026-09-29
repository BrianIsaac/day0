'use client';

import Link from 'next/link';
import { useRouter, useSelectedLayoutSegment } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { oneToOnePhase } from '@/agent/one-to-one-phase';
import { agentZone } from '@/lib/zone';
import { toSurfaceRecord } from '@/surfaces/records';
import { isManagerLookupFailure } from '@/surfaces/manager-lookup';
import type { SurfaceRecord } from '@/surfaces/types';
import { needsYouItemIds, openWorkCount } from '@/work/state-display';
import { shownEmployeeState } from '@/work/state-labels';
import { useArrival } from '../../arrival';
import { FirstWeekCard } from '../../components/FirstWeekCard';
import { FirstWeekRail } from '../../components/FirstWeekRail';
import { usePreviousValue } from '../../components/previous-value';
import { StatusRegion } from '../../components/StatusRegion';
import { TabPanel, Tabs, type TabItem } from '../../components/Tabs';
import type { ChangeOutcome } from '../../components/use-change';
import { DayZero } from './DayZero';
import { EmployeeContext, type Employee, type SentBackOutcome } from './employee-context';
import { addressesEnvironment } from './environment-hash';
import type { AuthoringAttempt } from './skills/authoring';
import {
  EMPLOYEE_TAB_LABELS,
  EMPLOYEE_TAB_PANEL_ID,
  EMPLOYEE_TABS,
  employeeTabHref,
  tabOfSegment,
  type EmployeeTab,
} from './employee-tabs';
import { EmployeeHeader } from './EmployeeHeader';
import { EmployeeRetired, NoSuchEmployee } from './NoSuchEmployee';
import { currentStep, firstWeekSteps } from './first-week';
import { AgentZoneContext } from '../../components/time';

/** Said, with focus on the one-to-one, when a charter sent back returns the page to it. */
export const ONBOARDING_REOPENED =
  'The 1:1 is open again, so the employee can redraft the charter from what you tell it.';

/**
 * Said, with focus on the one-to-one, when a charter sent back with a note is being redrafted.
 *
 * @param name - The employee.
 */
export function redraftingFromNote(name: string): string {
  return `Sent back with your note: ${name} is redrafting the charter from your one-to-one.`;
}

/** How long the first-week rail's advance plays: its 150 ms pause and 280 ms slide. */
export const RAIL_ADVANCE_MS = 430;

/**
 * How long the rail fades once the week has moved on to Working, before the card takes its place
 * (`[data-rail-leaving]` in `app/globals.css`): the page's height still changes, as the transform
 * rule allows no other way, but it no longer cuts.
 */
export const RAIL_EXIT_MS = 150;

/** How long the card settles in where the rail was (`.rail[data-arriving]`). */
export const CARD_SETTLE_MS = 220;

/** A draft the manager sent back, and whether the employee is redrafting it. */
interface SentBack {
  readonly charterId: Id<'charters'>;
  readonly redrafting: boolean;
}

/** The rail's step while what it is read from is still loading. */
const UNSETTLED = -1;

/**
 * Whether the week moved on in front of the manager: the step the page showed before is one it
 * had read, and behind the current one.
 *
 * @param before - The step the page showed before, while the moment that starts from it plays.
 * @param step - The current step.
 */
function movedOn(before: number | undefined, step: number): boolean {
  return before !== undefined && before !== UNSETTLED && before < step;
}

/**
 * The strip's tabs with their counts: what waits on the manager (in warn), the work still open
 * (under the queue's Needs you and In progress filters), the skills proposed. A tab with nothing
 * to count draws no badge.
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
export function onDayZero(
  agent: Pick<Doc<'agents'>, 'state'>,
  charter: Pick<Doc<'charters'>, '_id'> | null,
): boolean {
  return charter === null && (agent.state === 'deployed' || agent.state === 'day-one-in-progress');
}

/** What the employee page's shell is given. */
export interface EmployeeShellProps {
  readonly agentId: Id<'agents'>;
  readonly children: ReactNode;
}

/**
 * The employee page (round two section 3.3 and 3.9): the employee's name, state and zone, the
 * first-week rail (one card in the header once the employee is working), and either the day-zero
 * state or the tab strip over the selected tab's page.
 * Every tab reads the employee through `useEmployee`, so the page loads it once.
 *
 * A hash addressed to the work environment (`#surfaces`, which the Slack OAuth redirect and the
 * cards' links carry) is sent on to the Surfaces tab, where the environment selects the tab it
 * names and scrolls to itself.
 *
 * @param agentId - The employee, from the route.
 */
export function EmployeeShell({ agentId, children }: EmployeeShellProps) {
  const agent = useQuery(api.agents.get, { agentId });
  // The employee's other reads wait on it: each refuses an employee that is gone, so once a
  // retire lands they are dropped in the same render that learns it, and the page says so.
  const present = agent ? { agentId } : 'skip';
  const latest = useQuery(api.charters.latest, present);
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const surfaceMode = surfaceConfig?.mode;
  const surfaceRows = useQuery(
    api.surfaces.listForAgent,
    surfaceMode === 'real' ? present : 'skip',
  );
  const inbox = useQuery(api.work.needsYouForAgent, present);
  const workItems = useQuery(api.work.listForAgent, present);
  const proposedSkills = useQuery(api.skills.proposed, present);
  const metrics = useQuery(api.metrics.forAgent, present);
  const session = useQuery(api.voice.latest, present);
  const phase = oneToOnePhase(session).kind;
  const segment = useSelectedLayoutSegment();
  const router = useRouter();
  const selected = tabOfSegment(segment);
  const charter = latest ?? null;

  // What a change said once the control that made it left the page with its
  // card (a charter sent back), and where focus goes after it.
  const [pageOutcome, setPageOutcome] = useState<ChangeOutcome | null>(null);
  // The draft the manager sent back and what became of it, until the page shows what follows it.
  const [sentBack, setSentBack] = useState<SentBack | null>(null);
  // The Skills tab's last authoring verdict, here so it outlives the tab (A D11).
  const [lastAttempt, setLastAttempt] = useState<AuthoringAttempt | null>(null);
  const onboarding = useRef<HTMLDivElement>(null);
  const arriving = useArrival(agent !== undefined && agent !== null);
  // The name the page last showed, so an employee retired while its page is open is named.
  const [shownName, setShownName] = useState<string | null>(null);
  if (agent && agent.name !== shownName) setShownName(agent.name);

  const surfaces = useMemo(
    (): SurfaceRecord[] => (surfaceRows ?? []).map((row) => toSurfaceRecord(row)),
    [surfaceRows],
  );
  const dayZero = agent ? onDayZero(agent, charter) : false;
  const shownState = agent ? shownEmployeeState(agent.state, charter) : undefined;
  const steps = agent
    ? firstWeekSteps({
        deployedAt: agent.createdAt,
        state: shownEmployeeState(agent.state, charter),
        phase,
        charter,
        writeLanded:
          metrics !== undefined && metrics.actions.approved + metrics.actions.automatic.writes > 0,
        writeHeld: (workItems ?? []).some((item) => item.state === 'actions-pending'),
        zone: agentZone(agent),
      })
    : [];
  // The step counts once everything it is read from has loaded, so the rail filling in as the
  // page loads is never played as the employee moving on.
  const settled =
    agent !== undefined && latest !== undefined && workItems !== undefined && metrics !== undefined;
  const step = settled ? currentStep(steps) : UNSETTLED;
  const advanced = movedOn(usePreviousValue(step, RAIL_ADVANCE_MS), step);
  const exiting = movedOn(usePreviousValue(step, RAIL_ADVANCE_MS + RAIL_EXIT_MS), step);
  const settling = movedOn(
    usePreviousValue(step, RAIL_ADVANCE_MS + RAIL_EXIT_MS + CARD_SETTLE_MS),
    step,
  );
  // Once the employee is working the week is one card in the header (the operator's ruling of
  // 30 September). Only an active employee can be working, and whether it is waits on the
  // figures that say a write landed: until they load its page draws neither, so a working
  // employee's page never shows the whole rail and then takes it away. Any other employee's rail
  // is drawn at once, from the row until the charter is read, as it always was.
  const stageKnown = shownState !== 'active' || (latest !== undefined && metrics !== undefined);
  // The week moving on to Working in front of the manager plays on the whole rail first, where
  // the step it moves from is on screen; the rail then fades out, and the card settles in where
  // it was, so the page does not cut from one to the other.
  const atWorking = stageKnown && steps.at(-1)?.status === 'now';
  const railLeaving = atWorking && !advanced && exiting;
  const working = atWorking && !exiting;
  // What follows a draft sent back is the 1:1 again, or, when an approved
  // charter stands beneath the draft, that charter: only the first reopens
  // anything, so only then does the page say so and take focus. A charter
  // drafted later retires the sentence.
  const charterId = charter?._id;
  const agentName = agent?.name;
  useEffect(() => {
    if (sentBack !== null && dayZero) {
      onboarding.current?.focus();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- said once, when the 1:1 is back on the page after a draft was sent back
      setPageOutcome({
        tone: 'done',
        text: sentBack.redrafting
          ? redraftingFromNote(agentName ?? 'The employee')
          : ONBOARDING_REOPENED,
      });
      setSentBack(null);
    } else if (sentBack !== null && charterId !== undefined && charterId !== sentBack.charterId) {
      setSentBack(null);
    } else if (sentBack === null && charterId !== undefined) {
      setPageOutcome(null);
    }
  }, [sentBack, dayZero, charterId, agentName]);

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

  const reportSentBack = useCallback(
    (sent: Id<'charters'>, outcome: SentBackOutcome): void =>
      setSentBack({ charterId: sent, redrafting: outcome.redrafting }),
    [setSentBack],
  );
  const employee = useMemo(
    (): Employee | null =>
      agent
        ? {
            agent,
            charter,
            surfaceMode,
            surfaces,
            arriving,
            reportSentBack,
            lastAttempt,
            setLastAttempt,
          }
        : null,
    [agent, charter, surfaceMode, surfaces, arriving, reportSentBack, lastAttempt, setLastAttempt],
  );

  if (agent === null) {
    return shownName === null ? <NoSuchEmployee /> : <EmployeeRetired name={shownName} />;
  }

  if (!agent || !employee) {
    return (
      <div className="flex min-h-screen items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }

  const items = employeeTabItems(agentId, {
    needsYou: inbox?.total,
    // The queue's own rule: a stopped run the inbox lists counts, as it does under Needs you.
    work:
      workItems === undefined || inbox === undefined
        ? undefined
        : openWorkCount(workItems, needsYouItemIds(inbox.entries)),
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
            phase={phase}
            managerLookupFailure={
              (surfaceRows ?? []).find(
                (row) => row.class === 'chat' && isManagerLookupFailure(row.reason),
              )?.reason
            }
            stage={working ? <FirstWeekCard steps={steps} arriving={settling} /> : undefined}
          />
          {/* The page's own status keeps a gap under the header when it says something. */}
          <div className="mt-3 has-[>p:empty]:mt-0">
            <StatusRegion outcome={pageOutcome} />
          </div>
          {stageKnown && !working ? (
            <div className="mt-5" data-rail-leaving={railLeaving ? '' : undefined}>
              <FirstWeekRail steps={steps} advanced={advanced} />
            </div>
          ) : null}
          {dayZero && segment === 'surfaces' ? (
            // The environment is the one tab day zero can need: a card's link or the Slack
            // OAuth return lands here before the one-to-one is held.
            <div className="mt-6 grid gap-4">
              <Link
                href={employeeTabHref(agentId, 'needs-you')}
                className="inline-flex min-h-11 items-center self-start text-sm"
              >
                Back to the one-to-one
              </Link>
              {children}
            </div>
          ) : dayZero ? (
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
