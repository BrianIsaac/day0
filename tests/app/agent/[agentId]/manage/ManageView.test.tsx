/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import type { SurfaceRecord } from '../../../../../src/surfaces/types';
import { EmployeeContext } from '../../../../../app/agent/[agentId]/employee-context';
import { ManageView } from '../../../../../app/agent/[agentId]/manage/ManageView';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { mount, press, typeInto } from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

const route = vi.hoisted(() => ({ replaced: [] as string[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: (href: string): number => route.replaced.push(href) }),
}));

describe('ManageView: the manager DM setting waits for a manager channel (N7)', (): void => {
  afterEach((): void => {
    backend.queries = {};
  });

  const agent = {
    _id: 'a1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state: 'active',
    createdAt: 1,
  } as unknown as Doc<'agents'>;
  const approved = { approved: true } as unknown as Doc<'charters'>;

  /** The Manage tab as the shell hands it this employee. */
  function manage(
    surfaces: SurfaceRecord[],
    options: {
      mode?: 'mock' | 'real' | 'loading';
      charter?: Doc<'charters'> | null;
      state?: Doc<'agents'>['state'];
    } = {},
  ): string {
    return renderToStaticMarkup(
      <EmployeeContext
        value={{
          agent: { ...agent, state: options.state ?? agent.state },
          charter: options.charter === undefined ? approved : options.charter,
          surfaceMode: options.mode === 'loading' ? undefined : (options.mode ?? 'real'),
          surfaces,
          arriving: false,
          reportSentBack: () => undefined,
          lastAttempt: null,
          setLastAttempt: () => undefined,
        }}
      >
        <ManageView />
      </EmployeeContext>,
    );
  }

  const channel = (): SurfaceRecord =>
    ({
      slug: 'slack',
      displayName: 'Slack',
      class: 'chat',
      verdict: 'connected',
      credentialLanded: true,
      lastVerifiedAt: Date.now() - 60_000,
      managerDmChannelId: 'D0MANAGER',
      managerUserId: 'UMANAGER',
    }) as unknown as SurfaceRecord;

  it('is hidden until a chat surface has found the manager, then offered', (): void => {
    expect(manage([])).not.toMatch(/<select/);
    expect(manage([])).toContain('Once a chat surface finds your DM');
    const withChannel = manage([channel()]);
    expect(withChannel).toMatch(/<label[^>]*>Manager DMs<\/label>/);
    expect(withChannel).toMatch(/<select/);
  });

  it('offers the autonomy switch once the charter is approved, in real mode only', (): void => {
    expect(manage([])).toContain('role="switch"');
    const drafted = { approved: false } as unknown as Doc<'charters'>;
    const pending = { charter: drafted, state: 'charter-pending' as const };
    expect(manage([], pending)).not.toContain('role="switch"');
    expect(manage([], pending)).toContain('once Priya&#x27;s charter is approved');
    // A newer draft over the approved charter leaves the employee active, and the switch with it.
    expect(manage([], { charter: drafted })).toContain('role="switch"');
    const mock = manage([], { mode: 'mock' });
    expect(mock).not.toContain('role="switch"');
    expect(mock).toContain('holds its writes for your decision');
    expect(mock).not.toContain('DM to you');
    expect(mock).not.toContain('Manager DMs');
  });

  it('says the charter is what the DM setting waits for when it is, not the chat surface', (): void => {
    const drafted = { approved: false } as unknown as Doc<'charters'>;
    const html = manage([channel()], { charter: drafted, state: 'charter-pending' });
    expect(html).toContain('Once Priya&#x27;s charter is approved, choose here');
    expect(html).not.toContain('Once a chat surface finds your DM');
  });

  it('says it is loading, not what mock mode offers, until the mode is known', (): void => {
    const html = manage([], { mode: 'loading' });
    expect(html).toContain('Loading the switch');
    expect(html).not.toContain('hosted office');
  });

  // Re-pinned for 12-P: the card said there was no pause for one employee; there is one now, in
  // real mode, and the hosted office says it has none, as its autonomy card says it has no switch.
  it('offers Pause by name to an active employee in real mode, and says the hosted office has none', (): void => {
    const real = manage([]);
    expect(real).toContain(
      'Stops intake and holds every run at its next gate. Nothing is deleted; resume any time.',
    );
    expect(real).toMatch(/<button[^>]*>Pause Priya<\/button>/);
    expect(real).not.toContain('There is no pause for one employee');
    const mock = manage([], { mode: 'mock' });
    expect(mock).toContain(
      'The hosted office has no pause: every write Priya drafts there waits for your decision.',
    );
    expect(mock).not.toContain('Pause Priya');
    // Round two draws an Appearance card; the stylesheet has no light theme to choose.
    expect(real).not.toContain('Appearance');
  });

  it('marks a paused employee on its card and offers Resume by name, in place of Pause', (): void => {
    const html = renderToStaticMarkup(
      <EmployeeContext
        value={{
          agent: { ...agent, pausedAt: Date.UTC(2026, 9, 4, 9, 30), pauseReason: 'Quarter close.' },
          charter: approved,
          surfaceMode: 'real',
          surfaces: [],
          arriving: false,
          reportSentBack: () => undefined,
          lastAttempt: null,
          setLastAttempt: () => undefined,
        }}
      >
        <ManageView />
      </EmployeeContext>,
    );
    expect(html).toMatch(/<button[^>]*>Resume Priya<\/button>/);
    expect(html).not.toContain('Pause Priya');
    expect(html).toMatch(/text-\[var\(--color-warn\)\][^>]*>Paused</);
    expect(html).toContain('Reason: Quarter close.');
    // The card itself is drawn in warn while it holds the employee, as Retire is drawn in danger.
    expect(html).toMatch(
      /<section[^>]*border-\[var\(--color-warn-line\)\][^>]*>(?:(?!<section).)*>Pause</s,
    );
  });

  it('pauses and resumes this employee through the backend', async (): Promise<void> => {
    backend.calls = [];
    const view = mount(
      <EmployeeContext
        value={{
          agent,
          charter: approved,
          surfaceMode: 'real',
          surfaces: [],
          arriving: false,
          reportSentBack: () => undefined,
          lastAttempt: null,
          setLastAttempt: () => undefined,
        }}
      >
        <ManageView />
      </EmployeeContext>,
    );
    await press(view.container, 'Pause Priya');
    expect(backend.calls).toEqual([{ name: 'agents:pause', args: { agentId: 'a1' } }]);
    view.unmount();

    backend.calls = [];
    const paused = mount(
      <EmployeeContext
        value={{
          agent: { ...agent, pausedAt: 5 },
          charter: approved,
          surfaceMode: 'real',
          surfaces: [],
          arriving: false,
          reportSentBack: () => undefined,
          lastAttempt: null,
          setLastAttempt: () => undefined,
        }}
      >
        <ManageView />
      </EmployeeContext>,
    );
    await press(paused.container, 'Resume Priya');
    expect(backend.calls).toEqual([{ name: 'agents:resume', args: { agentId: 'a1' } }]);
    paused.unmount();
  });

  // Re-pinned for 12-P: before the charter there is no work to hold, and the card says when Pause
  // comes rather than that there is none.
  it('says at day zero that no work comes before the charter, not that the employee keeps working (second pass, walk M3)', (): void => {
    const real = manage([], { mode: 'real', charter: null, state: 'day-one-in-progress' });
    expect(real).toContain(
      'Pause is here once Priya&#x27;s charter is approved; until then it takes on no work.',
    );
    expect(real).not.toContain('Pause Priya');
    const mock = manage([], { mode: 'mock', charter: null, state: 'day-one-in-progress' });
    expect(mock).toContain(
      'The hosted office has no pause: Priya takes on work only once its charter is approved, and every write waits for your decision.',
    );
    for (const page of [real, mock]) expect(page).not.toContain('keeps working');
  });

  it('says what retiring does in each mode, and waits for the mode before offering it', (): void => {
    expect(manage([])).toContain('Day0 deletes its copy of any credential only Priya uses');
    expect(manage([], { mode: 'mock' })).toContain(
      'Removes Priya and everything it made in the hosted office.',
    );
    // A retire keeps the handover requests that name the employee, which the dialog counts; the
    // card no longer says nothing is kept (seen on the wave 10 bed).
    expect(manage([], { mode: 'mock' })).not.toContain('Nothing is kept');
    expect(manage([], { mode: 'loading' })).toMatch(/<button[^>]*disabled=""[^>]*>Retire Priya…/);
  });

  it('opens the retire dialog from its card and goes to the company home once the employee is gone', async (): Promise<void> => {
    route.replaced = [];
    backend.queries = {
      'reset:retirePreview': {
        mode: 'mock',
        rowCounts: { events: 3 },
        atLeast: false,
        revoked: [],
        kept: [],
        keptClaims: 0,
        tombstone: false,
      },
      'work:needsYouForAgent': { entries: [], total: 0 },
      'managerTransfers:openForAgent': null,
      'transferDepartures:keptAtRetire': { requests: 0 },
    };
    backend.results = { 'reset:retire': { agentName: 'Mira' } };
    const view = mount(asEmployee(<ManageView />));

    await press(view.container, 'Retire Mira…');
    const field = document.querySelector<HTMLInputElement>('[role="alertdialog"] input');
    if (!field) throw new Error('no retire dialog');
    typeInto(field, 'retire Mira');
    await press(document.body, 'Retire Mira');

    expect(backend.calls.at(-1)).toEqual({ name: 'reset:retire', args: { agentId: 'agent-1' } });
    expect(route.replaced).toEqual(['/']);
    view.unmount();
  });
});
