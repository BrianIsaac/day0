/** @vitest-environment jsdom */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';
import type { Id } from '../../../../convex/_generated/dataModel';
import {
  EmployeeShell,
  employeeTabItems,
  onDayZero,
} from '../../../../app/agent/[agentId]/EmployeeShell';
import { CharterView } from '../../../../app/agent/[agentId]/charter/CharterView';
import { WorkView } from '../../../../app/agent/[agentId]/work/WorkView';
import { ManageView } from '../../../../app/agent/[agentId]/manage/ManageView';
import { RetiredNotice, RetiredNoticeProvider } from '../../../../app/RetiredNotice';
import {
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
  unmountAll,
} from '../../../fixtures/dom/press';
import { ARRIVAL_MS } from '../../../../app/arrival';
import { dashboardMetrics } from '../../../fixtures/dashboard/metrics';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /**
   * What the backend's subscriptions do while a call lands, by function name: Convex applies the
   * queries a mutation changed before the mutation's promise resolves.
   */
  landing: {} as Record<string, () => void>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /**
   * What a query answers, by function name; undefined (loading) otherwise. An `Error` is thrown
   * during render, as `useQuery` rethrows what the backend's query threw.
   */
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
      backend.landing[name]?.();
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown, args?: unknown): unknown => {
      if (args === 'skip') return undefined;
      const answer = backend.queries[getFunctionName(reference as never)];
      if (answer instanceof Error) throw answer;
      return answer;
    },
    useMutation: call,
    useAction: call,
  };
});

const route = vi.hoisted(() => {
  const replaced: string[] = [];
  return {
    /** The segment below the employee's page, null on the page itself. */
    segment: null as string | null,
    /** Every address the page replaced the location with. */
    replaced,
    /** One router for the whole run, as Next hands the page one. */
    router: {
      replace: (href: string): void => {
        replaced.push(href);
      },
    },
  };
});

vi.mock('next/navigation', () => ({
  useSelectedLayoutSegment: (): string | null => route.segment,
  useRouter: () => route.router,
}));

/** The employee page with a tab's page inside it, as the layout renders it. */
function page(tab: ReactNode = null) {
  return <EmployeeShell agentId={'agent-1' as Id<'agents'>}>{tab}</EmployeeShell>;
}

describe('the panels the dashboard loads on demand', (): void => {
  // Resolved by path: under jsdom, Vite rewrites `new URL(path, import.meta.url)`
  // into a served asset address rather than a file.
  const read = (file: string): string =>
    readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), '../../../../app/agent/[agentId]', file),
      'utf8',
    );
  const holders: Record<string, string> = {
    ChatRoom: 'DayZero.tsx',
    VoiceRoom: 'DayZero.tsx',
    MockEnvironment: 'surfaces/SurfacesView.tsx',
  };

  it('loads the chat room, the voice room and the work environment as their own chunks, the voice room never on the server', (): void => {
    for (const [panel, file] of Object.entries(holders)) {
      const source = read(file);
      expect(source).not.toMatch(new RegExp(`import \\{ ${panel} \\} from '\\.{1,2}/${panel}'`));
      expect(source).toMatch(new RegExp(`const ${panel} = dynamic\\(`));
    }
    const voice = /const VoiceRoom = dynamic\([\s\S]*?\}\);/.exec(read('DayZero.tsx'))?.[0] ?? '';
    expect(voice).toContain('ssr: false');
    // The shell reads the environment's hash rules from their own light module, never the panel.
    expect(read('EmployeeShell.tsx')).not.toMatch(
      /from '\.\/(MockEnvironment|ChatRoom|VoiceRoom)'/,
    );
  });
});

describe('the page after a draft charter is sent back (step 45)', (): void => {
  const agent = (state: string) => ({
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state,
    createdAt: 1,
  });
  const draft = {
    _id: 'charter-2',
    _creationTime: 2,
    agentId: 'agent-1',
    version: '0.2',
    approved: false,
    createdAt: 2,
    body: {
      whyThisHire: 'Close week.',
      proposedFunction: 'Own routine revenue operations work.',
      shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
      proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
      namedCollaborators: [],
      priorityReading: [],
      openQuestions: [],
    },
  };

  afterEach((): void => {
    backend.queries = {};
    unmountAll();
    document.body.replaceChildren();
  });

  it('says the 1:1 is open again and gives it focus when the send-back reopened it', async (): Promise<void> => {
    route.segment = 'charter';
    backend.queries = {
      'agents:get': agent('charter-pending'),
      'charters:latest': draft,
      'charters:transcriptOf': null,
    };
    backend.results = { 'charters:requestChanges': { ok: true, redrafting: false } };
    const view = mount(page(<CharterView />));
    await press(view.container, 'Send back');
    backend.queries = { 'agents:get': agent('deployed'), 'charters:latest': null };
    act((): void => view.root.render(page(<CharterView />)));
    await settle();

    expect(said(view.container)).toContain(
      'The 1:1 is open again, so the employee can redraft the charter from what you tell it.',
    );
    expect(focusedName()).toBe('The 1:1 that drafts the charter');
    view.unmount();
  });

  it('says the employee is redrafting from the note, and the pill and rail say the charter is being drafted', async (): Promise<void> => {
    route.segment = 'charter';
    backend.queries = {
      'agents:get': agent('charter-pending'),
      'charters:latest': draft,
      'charters:transcriptOf': { transcript: 'Employee: Why this hire?\nManager: Close week.' },
    };
    backend.results = { 'charters:requestChanges': { ok: true, redrafting: true } };
    const view = mount(page(<CharterView />));
    typeInto(view.container.querySelector('textarea')!, 'Name the committee deck.');
    await press(view.container, 'Send and redraft');
    backend.queries = {
      'agents:get': agent('day-one-in-progress'),
      'charters:latest': null,
      'voice:latest': {
        _id: 'session-1',
        mode: 'chat',
        state: 'active',
        pendingTranscript: 'Employee: Why this hire?\nManager: Close week.',
      },
    };
    act((): void => view.root.render(page(<CharterView />)));
    await settle();

    expect(said(view.container)).toContain(
      'Sent back with your note: the employee is redrafting the charter from your one-to-one.',
    );
    expect(said(view.container).join(' ')).not.toContain('The 1:1 is open again');
    expect(focusedName()).toBe('The 1:1 that drafts the charter');
    expect(view.container.querySelector('header')?.textContent).toContain('Drafting the charter');
    expect(view.container.querySelector('header')?.textContent).not.toContain('In your one-to-one');
    const rail = view.container.querySelector('ol[aria-label="First week"]');
    expect(rail?.querySelector('[aria-current="step"]')?.textContent).toContain('Charter approved');
    view.unmount();
  });

  it('says nothing reopened and moves no focus when an approved charter stands beneath the draft', async (): Promise<void> => {
    route.segment = 'charter';
    backend.queries = {
      'agents:get': agent('active'),
      'charters:latest': draft,
      'charters:transcriptOf': null,
    };
    backend.results = { 'charters:requestChanges': { ok: true, redrafting: false } };
    const view = mount(page(<CharterView />));
    await press(view.container, 'Send back');
    backend.queries = {
      'agents:get': agent('active'),
      'charters:latest': { ...draft, _id: 'charter-1', version: '0.1', approved: true },
    };
    act((): void => view.root.render(page(<CharterView />)));
    await settle();

    expect(said(view.container).join(' ')).not.toContain('The 1:1 is open again');
    expect(focusedName()).not.toBe('The 1:1 that drafts the charter');
    view.unmount();
  });
});

describe('the page in the layout (N29, UX 11)', (): void => {
  afterEach((): void => {
    backend.queries = {};
    unmountAll();
    document.body.replaceChildren();
  });

  it('leaves the one main landmark to the layout, loading and loaded', async (): Promise<void> => {
    route.segment = 'work';
    const view = mount(page(<WorkView />));
    expect(view.container.textContent).toContain('loading employee…');
    expect(view.container.querySelector('main')).toBeNull();
    backend.queries = {
      'agents:get': {
        _id: 'agent-1',
        _creationTime: 1,
        bossEmail: 'boss@day0.local',
        name: 'Priya',
        userId: 'owner',
        state: 'active',
        createdAt: 1,
      },
    };
    act((): void => view.root.render(page(<WorkView />)));
    await settle();
    expect(view.container.textContent).toContain('Work queue');
    expect(view.container.querySelector('main')).toBeNull();
    view.unmount();
  });
});

describe('the cards arriving on first render (v4 section 1.3)', (): void => {
  const agentRow = {
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Priya',
    userId: 'owner',
    state: 'active',
    createdAt: 1,
  };
  const workItem = (id: string, state: string) => ({
    _id: id,
    _creationTime: 1,
    agentId: 'agent-1',
    sourceCategory: 'ticket-queue',
    sourceSystem: 'linear',
    externalId: id,
    title: `Item ${id}`,
    contentSummary: 'Triage it.',
    contentRefs: [],
    state,
    observedAt: 1,
    createdAt: 1,
  });

  beforeEach((): void => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });

  afterEach((): void => {
    vi.useRealTimers();
    backend.queries = {};
    unmountAll();
    document.body.replaceChildren();
  });

  /** The arrival marks in the rendered page, in document order. */
  const marks = (root: ParentNode): (string | null)[] =>
    [...root.querySelectorAll('[data-cards]')].map((group) => group.getAttribute('data-cards'));

  it('marks both columns, then the queue’s rows as the second tier, for the arrival only', async (): Promise<void> => {
    backend.queries = {
      'agents:get': agentRow,
      'work:listForAgent': [workItem('w-1', 'discovered'), workItem('w-2', 'completed')],
    };
    route.segment = 'work';
    const view = mount(page(<WorkView />));
    await settle();
    expect(marks(view.container)).toEqual(['', 'rows', '']);
    act((): void => {
      vi.advanceTimersByTime(ARRIVAL_MS);
    });
    expect(marks(view.container)).toEqual([]);
    view.unmount();
  });

  it('marks nothing while the employee is still loading', async (): Promise<void> => {
    route.segment = 'work';
    const view = mount(page(<WorkView />));
    await settle();
    expect(marks(view.container)).toEqual([]);
    view.unmount();
  });
});

describe('the employee page shell (round two section 3.3 and 3.9)', (): void => {
  const row = (state: string, fields: Record<string, unknown> = {}) => ({
    _id: 'agent-1',
    _creationTime: 1,
    bossEmail: 'boss@day0.local',
    name: 'Mira',
    userId: 'owner',
    state,
    zone: 'UTC',
    createdAt: Date.UTC(2026, 8, 29, 9, 2),
    ...fields,
  });
  const approved = { _id: 'charter-1', version: '1', approved: true, createdAt: 2, body: {} };

  afterEach((): void => {
    backend.queries = {};
    route.segment = null;
    route.replaced.length = 0;
    window.history.replaceState(null, '', window.location.pathname);
    unmountAll();
    document.body.replaceChildren();
  });

  it("makes the employee's name the page's one heading, under a breadcrumb home", async (): Promise<void> => {
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    const view = mount(page());
    await settle();
    const headings = view.container.querySelectorAll('h1');
    expect([...headings].map((heading) => heading.textContent)).toEqual(['Mira']);
    const crumb = view.container.querySelector('nav[aria-label="Breadcrumb"]');
    expect(crumb?.querySelector('a')?.getAttribute('href')).toBe('/');
    expect(crumb?.querySelector('[aria-current="page"]')?.textContent).toBe('Mira');
    view.unmount();
  });

  it('draws the nine tabs in order, Needs you selected on the page itself and under its pages', async (): Promise<void> => {
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    const selected = async (segment: string | null): Promise<string | null | undefined> => {
      route.segment = segment;
      const view = mount(page());
      await settle();
      const tabs = [...view.container.querySelectorAll('[role="tab"]')];
      expect(tabs.map((tab) => tab.textContent)).toEqual([
        'Needs you',
        'Work',
        'Charter',
        'People',
        'Documentation',
        'Skills',
        'Surfaces',
        'Record',
        'Manage',
      ]);
      const current = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
      view.unmount();
      return current?.textContent;
    };
    expect(await selected(null)).toBe('Needs you');
    expect(await selected('work')).toBe('Work');
    expect(await selected('surfaces')).toBe('Surfaces');
    expect(await selected('reorientation')).toBe('Needs you');
  });

  it('counts what waits on the manager in warn, the work under way and the skills proposed', (): void => {
    const items = employeeTabItems('agent-1', { needsYou: 3, work: 2, skills: 1 });
    expect(items.map((item) => [item.key, item.href, item.count, item.hot])).toEqual([
      ['needs-you', '/agent/agent-1', 3, true],
      ['work', '/agent/agent-1/work', 2, false],
      ['charter', '/agent/agent-1/charter', undefined, false],
      ['people', '/agent/agent-1/people', undefined, false],
      ['documentation', '/agent/agent-1/documentation', undefined, false],
      ['skills', '/agent/agent-1/skills', 1, false],
      ['surfaces', '/agent/agent-1/surfaces', undefined, false],
      ['record', '/agent/agent-1/record', undefined, false],
      ['manage', '/agent/agent-1/manage', undefined, false],
    ]);
  });

  it('counts the work neither finished nor set aside, from the queue', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:needsYouForAgent': { entries: [], total: 4 },
      'work:listForAgent': [
        { _id: 'w1', state: 'plan-pending' },
        { _id: 'w2', state: 'executing' },
        { _id: 'w3', state: 'completed' },
        { _id: 'w4', state: 'skipped' },
        { _id: 'w5', state: 'failed' },
      ],
    };
    const view = mount(page());
    await settle();
    const tab = (name: string): string | null | undefined =>
      [...view.container.querySelectorAll('[role="tab"]')].find((candidate) =>
        candidate.textContent?.startsWith(name),
      )?.textContent;
    expect(tab('Needs you')).toBe('Needs you 4');
    expect(tab('Work')).toBe('Work 2');
    view.unmount();
  });

  it('counts a stopped run the inbox lists, as the queue files it under Needs you (D7, m5)', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:needsYouForAgent': {
        entries: [{ kind: 'stopped', agentId: 'agent-1', workItemId: 'w5' }],
        total: 1,
      },
      'work:listForAgent': [
        { _id: 'w2', state: 'executing' },
        { _id: 'w3', state: 'completed' },
        { _id: 'w5', state: 'failed' },
        { _id: 'w6', state: 'failed' },
      ],
    };
    const view = mount(page());
    await settle();
    const work = [...view.container.querySelectorAll('[role="tab"]')].find((candidate) =>
      candidate.textContent?.startsWith('Work'),
    );
    expect(work?.textContent).toBe('Work 2');
    view.unmount();
  });

  it('sends a hash addressed to the environment to the Surfaces tab, and leaves any other hash be', async (): Promise<void> => {
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    // A cold load: the hash is in the address before the page, and no hashchange fires for it.
    window.history.replaceState(null, '', '#surfaces');
    const view = mount(page());
    await settle();
    expect(route.replaced).toEqual(['/agent/agent-1/surfaces#surfaces']);
    view.unmount();

    route.replaced.length = 0;
    route.segment = 'surfaces';
    const there = mount(page());
    await settle();
    expect(route.replaced).toEqual([]);
    there.unmount();

    route.segment = 'work';
    window.history.replaceState(null, '', '#item-w1');
    const item = mount(page());
    await settle();
    expect(route.replaced).toEqual([]);
    item.unmount();
  });

  it("follows a card's #surfaces link from another tab to the Surfaces tab", async (): Promise<void> => {
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    route.segment = 'work';
    const view = mount(page());
    await settle();
    expect(route.replaced).toEqual([]);
    act((): void => {
      window.history.replaceState(null, '', '#surfaces');
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    expect(route.replaced).toEqual(['/agent/agent-1/surfaces#surfaces']);
    view.unmount();
  });

  /** What each of the employee's other reads throws once the employee is gone, as the backend does. */
  const gone = (): Record<string, unknown> =>
    Object.fromEntries(
      [
        'charters:latest',
        'surfaces:listForAgent',
        'work:needsYouForAgent',
        'work:listForAgent',
        'skills:proposed',
        'metrics:forAgent',
      ].map((name) => [name, new Error('agent not found')]),
    );

  it('says "No such employee" for an id that names none, reading nothing else of it', async (): Promise<void> => {
    backend.queries = { ...gone(), 'config:surfaceMode': { mode: 'real' }, 'agents:get': null };
    const view = mount(page());
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('No such employee');
    expect(view.container.textContent).not.toContain('loading employee');
    view.unmount();
  });

  it('names the employee as retired, not missing, when it goes while its page is open', async (): Promise<void> => {
    route.segment = 'manage';
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'config:surfaceMode': { mode: 'real' },
      'surfaces:listForAgent': [],
    };
    const view = mount(page(<p>the manage tab</p>));
    await settle();
    expect(view.container.textContent).toContain('the manage tab');

    backend.queries = { ...gone(), 'config:surfaceMode': { mode: 'real' }, 'agents:get': null };
    act((): void => view.root.render(page(<p>the manage tab</p>)));
    await settle();
    expect(view.container.querySelector('h1')?.textContent).toBe('Mira is retired');
    expect(view.container.textContent).not.toContain('the manage tab');
    const back = view.container.querySelector('a[href="/"]');
    expect(back?.textContent).toBe('Back to your employees');
    expect(back?.className).toMatch(/\bmin-h-11\b/);
    // The page changed under the manager: the heading says where they are now.
    expect(focusedName()).toBe('Mira is retired');
    view.unmount();
  });

  it('retires the employee from its own Manage tab and lands on the company home, the page never crashing', async (): Promise<void> => {
    route.segment = 'manage';
    const standing = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'config:surfaceMode': { mode: 'mock' },
      'work:needsYouForAgent': { entries: [], total: 0 },
      'reset:retirePreview': {
        mode: 'mock',
        rowCounts: { events: 3 },
        atLeast: false,
        revoked: [],
        kept: [],
        keptClaims: 0,
        tombstone: false,
      },
    };
    backend.queries = standing;
    backend.results = { 'reset:retire': { agentName: 'Mira' } };
    // The layout's hand-off around the page, and the home it lands on once the route changes.
    const app = (home: boolean) => (
      <RetiredNoticeProvider>
        {home ? <RetiredNotice /> : page(<ManageView />)}
      </RetiredNoticeProvider>
    );
    const view = mount(app(false));
    await settle();
    backend.landing = {
      'reset:retire': (): void => {
        backend.queries = { ...gone(), 'config:surfaceMode': { mode: 'mock' }, 'agents:get': null };
        view.root.render(app(false));
      },
    };

    await press(view.container, 'Retire Mira…');
    const field = document.querySelector<HTMLInputElement>('[role="alertdialog"] input');
    if (!field) throw new Error('no retire dialog');
    typeInto(field, 'retire Mira');
    await press(document.body, 'Retire Mira');

    expect(backend.calls.at(-1)).toEqual({ name: 'reset:retire', args: { agentId: 'agent-1' } });
    expect(view.container.querySelector('h1')?.textContent).toBe('Mira is retired');
    expect(route.replaced).toEqual(['/']);

    act((): void => view.root.render(app(true)));
    await settle();
    expect(said(view.container)).toEqual(['Mira is retired.']);
    expect(focusedName()).toBe('Mira is retired.');
    backend.landing = {};
    view.unmount();
  });

  it('shows day zero in place of the tabs until the one-to-one has drafted a charter', async (): Promise<void> => {
    expect(onDayZero({ state: 'deployed' }, null)).toBe(true);
    expect(onDayZero({ state: 'day-one-in-progress' }, null)).toBe(true);
    expect(onDayZero({ state: 'deployed' }, { _id: 'charter-1' as Id<'charters'> })).toBe(false);
    expect(onDayZero({ state: 'active' }, null)).toBe(false);

    backend.queries = { 'agents:get': row('deployed'), 'charters:latest': null };
    const view = mount(page(<p>a tab</p>));
    await settle();
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.textContent).not.toContain('a tab');
    expect(view.container.textContent).toContain('Day-1 one-to-one: voice or chat?');
    expect(view.container.textContent).toContain('What Mira knows so far');
    expect(view.container.textContent).toContain('Waiting for your one-to-one');
    const rail = view.container.querySelector('ol[aria-label="First week"]');
    expect(rail?.querySelector('[aria-current="step"]')?.textContent).toContain('Day-1 one-to-one');
    view.unmount();
  });

  it('shows the Surfaces page on day zero when the address names it, with the way back', async (): Promise<void> => {
    backend.queries = { 'agents:get': row('deployed'), 'charters:latest': null };
    route.segment = 'surfaces';
    const view = mount(page(<p>the environment</p>));
    await settle();
    expect(view.container.textContent).toContain('the environment');
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelector('a[href="/agent/agent-1"]')?.textContent).toBe(
      'Back to the one-to-one',
    );
    view.unmount();
  });

  it('plays no advance as the page loads, the figures arriving after the employee', async (): Promise<void> => {
    backend.queries = {};
    const view = mount(page());
    await settle();
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    act((): void => view.root.render(page()));
    await settle();
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': dashboardMetrics(),
    };
    act((): void => view.root.render(page()));
    await settle();
    const rail = view.container.querySelector('ol[aria-label="First week"]');
    expect(rail?.querySelector('[aria-current="step"]')?.textContent).toContain('Working');
    expect(rail?.hasAttribute('data-advanced')).toBe(false);
    view.unmount();
  });

  it('moves the first-week rail on while the manager watches, and only then plays its advance', async (): Promise<void> => {
    const noWrite = {
      ...dashboardMetrics(),
      actions: {
        ...dashboardMetrics().actions,
        approved: 0,
        automatic: { reads: 0, managerMessages: 0, writes: 0 },
      },
    };
    backend.queries = {
      'agents:get': row('charter-pending'),
      'charters:latest': { ...approved, approved: false },
      'work:listForAgent': [],
      'metrics:forAgent': noWrite,
    };
    const view = mount(page());
    await settle();
    const rail = (): Element | null => view.container.querySelector('ol[aria-label="First week"]');
    expect(rail()?.hasAttribute('data-advanced')).toBe(false);
    expect(rail()?.querySelector('[aria-current="step"]')?.textContent).toContain(
      'Charter approved',
    );

    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': noWrite,
    };
    act((): void => view.root.render(page()));
    await settle();
    expect(rail()?.hasAttribute('data-advanced')).toBe(true);
    expect(rail()?.querySelector('[aria-current="step"]')?.textContent).toContain(
      'First supervised write',
    );
    view.unmount();
  });
});
