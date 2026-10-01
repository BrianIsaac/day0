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
import { useEmployee } from '../../../../app/agent/[agentId]/employee-context';
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
      'Sent back with your note: Priya is redrafting the charter from your one-to-one.',
    );
    expect(said(view.container).join(' ')).not.toContain('The 1:1 is open again');
    expect(focusedName()).toBe('The 1:1 that drafts the charter');
    expect(view.container.querySelector('header')?.textContent).toContain('Drafting the charter');
    expect(view.container.querySelector('header')?.textContent).not.toContain('In your one-to-one');
    // The face beside the pill says the same phase (review m3, second pass: pinned where the
    // header hands it over).
    expect(view.container.querySelector('header [title]')?.getAttribute('title')).toBe(
      'Priya, drafting the charter',
    );
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
      'managerTransfers:openForAgent': null,
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

    // No one-to-one held yet: the session query answers null (re-pinned for m23).
    backend.queries = {
      'agents:get': row('deployed'),
      'charters:latest': null,
      'voice:latest': null,
    };
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
    const back = view.container.querySelector('a[href="/agent/agent-1"]');
    expect(back?.textContent).toBe('Back to the one-to-one');
    // The inline-link look the rest of the page's links in running text take (second review w4).
    expect(back?.className).toContain('decoration-[var(--color-link-line)]');
    view.unmount();
  });

  it('reaches Manage from day zero by a visible link naming the employee (walk M3)', async (): Promise<void> => {
    for (const state of ['deployed', 'day-one-in-progress'] as const) {
      backend.queries = { 'agents:get': row(state), 'charters:latest': null };
      const view = mount(page(<p>a tab</p>));
      await settle();
      expect(view.container.querySelector('a[href="/agent/agent-1/manage"]')?.textContent).toBe(
        'Manage or retire Mira',
      );
      view.unmount();
    }
  });

  it('retires an employee at day zero from its Manage page, the dialog counting what it made (walk M3)', async (): Promise<void> => {
    route.segment = 'manage';
    backend.queries = {
      'agents:get': row('day-one-in-progress'),
      'charters:latest': null,
      'config:surfaceMode': { mode: 'mock' },
      'work:needsYouForAgent': { entries: [], total: 0 },
      'managerTransfers:openForAgent': null,
      'reset:retirePreview': {
        mode: 'mock',
        rowCounts: { voiceSessions: 1, events: 2 },
        atLeast: false,
        revoked: [],
        kept: [],
        keptClaims: 0,
        keptClaimsAtLeast: false,
        tombstone: false,
      },
    };
    backend.results = { 'reset:retire': { agentName: 'Mira' } };
    const view = mount(page(<ManageView />));
    await settle();
    expect(view.container.textContent).not.toContain('Day-1 one-to-one: voice or chat?');
    expect(view.container.querySelector('[role="tablist"]')).toBeNull();
    expect(view.container.querySelector('a[href="/agent/agent-1"]')?.textContent).toBe(
      'Back to the one-to-one',
    );

    await press(view.container, 'Retire Mira…');
    const dialog = document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain('2 events and 1 other row across 2 tables.');
    const field = dialog?.querySelector<HTMLInputElement>('input');
    if (!field) throw new Error('no retire dialog');
    typeInto(field, 'retire Mira');
    await press(document.body, 'Retire Mira');
    expect(backend.calls.at(-1)).toEqual({ name: 'reset:retire', args: { agentId: 'agent-1' } });
    expect(route.replaced).toEqual(['/']);
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
    // Re-pinned (unit S): a working employee's week is the card in the header, not the rail.
    const card = view.container.querySelector('header button[aria-label^="First week"]');
    expect(card?.textContent).toContain('Working');
    // Re-pinned (review m4, m9): the card plays no advance of its own, and settles in only when
    // it takes the rail's place in front of the manager, never as the page loads.
    expect(card?.closest('.rail')?.hasAttribute('data-arriving')).toBe(false);
    expect(view.container.querySelector('ol[aria-label="First week"]')).toBeNull();
    view.unmount();
  });

  it('keeps the Skills tab’s last authoring verdict when the manager leaves the tab and comes back (A D11)', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': dashboardMetrics(),
    };
    /** The Skills tab's part: file what the authoring run came to. */
    function Files() {
      const { setLastAttempt } = useEmployee();
      return (
        <button
          type="button"
          onClick={() =>
            setLastAttempt({
              skillId: 'skill-1' as Id<'skills'>,
              name: 'refresh-the-tile',
              reason: 'authoring did not finish',
            })
          }
        >
          Approve · author and verify
        </button>
      );
    }
    /** The Skills tab again, reading what the shell kept. */
    function Reads() {
      const { lastAttempt } = useEmployee();
      return <p>{lastAttempt ? `${lastAttempt.name}: ${lastAttempt.reason}` : 'nothing kept'}</p>;
    }
    route.segment = 'skills';
    const view = mount(page(<Files />));
    await settle();
    await press(view.container, 'Approve · author and verify');
    route.segment = 'work';
    act((): void => view.root.render(page(<p>the Work tab</p>)));
    await settle();
    route.segment = 'skills';
    act((): void => view.root.render(page(<Reads />)));
    await settle();
    expect(view.container.textContent).toContain('refresh-the-tile: authoring did not finish');
    view.unmount();
  });

  it('dates the one-to-one on the rail by when the conversation closed, not by a later redraft’s commit (second review x7)', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('charter-pending'),
      'charters:latest': { ...approved, approved: false },
      'work:listForAgent': [],
      'metrics:forAgent': dashboardMetrics(),
      'voice:latest': {
        _id: 'session-1',
        mode: 'chat',
        state: 'done',
        conversationEndedAt: Date.UTC(2026, 8, 29, 9, 40),
        // The draft sent back with a note was redrafted and committed a day later.
        claimedAt: Date.UTC(2026, 8, 30, 11, 5),
        endedAt: Date.UTC(2026, 8, 30, 11, 6),
      },
    };
    const view = mount(page());
    await settle();
    const step = [...view.container.querySelectorAll('ol[aria-label="First week"] li')].find(
      (item) => item.textContent?.includes('Day-1 one-to-one'),
    );
    expect(step?.textContent).toContain('29 Sep 2026, 09:40');
    expect(step?.textContent).not.toContain('30 Sep 2026');
    view.unmount();
  });

  it('draws a working employee’s week as one card in the header, with no rail under it', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': { ...dashboardMetrics(), workingSince: Date.UTC(2026, 8, 30, 6, 22) },
    };
    const view = mount(page());
    await settle();
    const header = view.container.querySelector('header');
    const card = header?.querySelector('button[aria-label^="First week"]');
    expect(card?.getAttribute('aria-expanded')).toBe('false');
    expect(card?.getAttribute('aria-label')).toBe(
      'First week: Working, since 30 Sep 2026, 06:22. Show the whole week',
    );
    // Under the office and state pills, in the header's right column.
    const column = card?.closest('div.grid');
    expect(column?.firstElementChild?.textContent).toContain('Active · Supervised');
    expect(column?.lastElementChild).toBe(card?.closest('.rail'));
    expect(view.container.querySelector('ol[aria-label="First week"]')).toBeNull();
    expect(view.container.querySelector('[role="tablist"]')).not.toBeNull();
    view.unmount();
  });

  it('gives focus to the employee’s name when the card goes with the whole week open (review m7)', async (): Promise<void> => {
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': dashboardMetrics(),
    };
    const view = mount(page());
    await settle();
    await press(view.container, 'First week: Working. Show the whole week');
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    // The employee is reset from another tab: its week starts again, and the card goes.
    backend.queries = {
      ...backend.queries,
      'agents:get': row('deployed'),
      'charters:latest': null,
    };
    act((): void => view.root.render(page()));
    await settle();
    expect(view.container.querySelector('header button[aria-label^="First week"]')).toBeNull();
    expect(document.activeElement?.tagName).toBe('H1');
    expect(focusedName()).toBe('Mira');
    view.unmount();
  });

  it('draws neither the rail nor the card while the figures that say whether an active employee is working load', async (): Promise<void> => {
    backend.queries = { 'agents:get': row('active'), 'charters:latest': approved };
    const view = mount(page());
    await settle();
    expect(view.container.querySelector('ol[aria-label="First week"]')).toBeNull();
    expect(view.container.querySelector('header button[aria-label^="First week"]')).toBeNull();
    view.unmount();
  });

  it('plays the advance on the rail when the first write lands in front of the manager, fades the rail, then settles the card in its place', async (): Promise<void> => {
    const noWrite = {
      ...dashboardMetrics(),
      writeLanded: false,
      actions: {
        ...dashboardMetrics().actions,
        approved: 0,
        automatic: { reads: 0, managerMessages: 0, writes: 0 },
      },
    };
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': [],
      'metrics:forAgent': noWrite,
    };
    const view = mount(page());
    await settle();
    expect(
      view.container
        .querySelector('ol[aria-label="First week"]')
        ?.querySelector('[aria-current="step"]')?.textContent,
    ).toContain('First supervised write');
    expect(view.container.querySelector('header button[aria-label^="First week"]')).toBeNull();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      backend.queries = { ...backend.queries, 'metrics:forAgent': dashboardMetrics() };
      act((): void => view.root.render(page()));
      await settle();
      // Re-pinned (review M3, m4, m11): the advance plays on the whole rail, where the step it
      // moves from is on screen, for its 430 ms; the rail then fades out for 150 ms and gives way
      // to the card, which settles in over 220 ms. Timed to the millisecond on a fake clock.
      const rail = (): Element | null =>
        view.container.querySelector('ol[aria-label="First week"]');
      const card = (): Element | null =>
        view.container.querySelector('header button[aria-label^="First week"]');
      const at = (ms: number): void => {
        act((): void => {
          vi.advanceTimersByTime(ms);
        });
      };
      expect(rail()?.hasAttribute('data-advanced')).toBe(true);
      expect(rail()?.querySelector('[aria-current="step"]')?.textContent).toContain('Working');
      expect(card()).toBeNull();
      at(429);
      expect(rail()?.hasAttribute('data-advanced')).toBe(true);
      expect(rail()?.closest('[data-rail-leaving]')).toBeNull();
      at(1);
      // Fading, the rail keeps the advance's fill, so the fade starts from the frame the advance
      // ended on (second pass: dropping it swapped the fill for the cell's own tint for a frame).
      expect(rail()?.hasAttribute('data-advanced')).toBe(true);
      expect(rail()?.closest('[data-rail-leaving]')).not.toBeNull();
      expect(card()).toBeNull();
      at(149);
      expect(rail()).not.toBeNull();
      at(1);
      expect(rail()).toBeNull();
      expect(card()?.textContent).toContain('Working');
      expect(card()?.closest('.rail')?.hasAttribute('data-arriving')).toBe(true);
      at(219);
      expect(card()?.closest('.rail')?.hasAttribute('data-arriving')).toBe(true);
      at(1);
      expect(card()?.closest('.rail')?.hasAttribute('data-arriving')).toBe(false);
    } finally {
      vi.useRealTimers();
      view.unmount();
    }
  });

  it('draws a not-yet-working employee’s rail from the row before its charter is read (review M4)', async (): Promise<void> => {
    backend.queries = { 'agents:get': row('deployed') };
    const view = mount(page());
    await settle();
    const rail = view.container.querySelector('ol[aria-label="First week"]');
    expect(rail?.querySelector('[aria-current="step"]')?.textContent).toContain('Day-1 one-to-one');
    view.unmount();
  });

  it('moves the first-week rail on while the manager watches, and only then plays its advance', async (): Promise<void> => {
    const noWrite = {
      ...dashboardMetrics(),
      writeLanded: false,
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

  it('says a write approved and not yet landed, keeps Working for a landing, and a failed write after approval is not one (X finding 5)', async (): Promise<void> => {
    const noWrite = {
      ...dashboardMetrics(),
      writeLanded: false,
      actions: { ...dashboardMetrics().actions, approved: 1 },
    };
    const work = (state: string) => [
      { _id: 'wi-1', _creationTime: 1, state, applyPhase: 'approved', approvedIndexes: [0] },
    ];
    backend.queries = {
      'agents:get': row('active'),
      'charters:latest': approved,
      'work:listForAgent': work('executing'),
      'metrics:forAgent': noWrite,
    };
    const view = mount(page());
    await settle();
    const current = (): string | undefined =>
      view.container
        .querySelector('ol[aria-label="First week"] [aria-current="step"]')
        ?.textContent?.trim();
    const card = (): Element | null =>
      view.container.querySelector('header button[aria-label^="First week"]');
    expect(current()).toContain('First supervised write');
    expect(current()).toContain('approved, not yet landed');
    expect(card()).toBeNull();

    // A decision that let nothing through is not an approval (second pass minor 9).
    backend.queries = {
      ...backend.queries,
      'work:listForAgent': [{ ...work('executing')[0], approvedIndexes: [] }],
    };
    act((): void => view.root.render(page()));
    await settle();
    expect(current()).toContain('after the first plan');

    // The approved write's apply failed: nothing landed, and nothing is on its way.
    backend.queries = { ...backend.queries, 'work:listForAgent': work('failed') };
    act((): void => view.root.render(page()));
    await settle();
    expect(current()).toContain('after the first plan');
    expect(card()).toBeNull();

    // A write landed: the card, from the server's one figure, once S's advance and fade have run.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      backend.queries = {
        ...backend.queries,
        'work:listForAgent': work('completed'),
        'metrics:forAgent': { ...dashboardMetrics(), workingSince: Date.UTC(2026, 8, 30, 6, 22) },
      };
      act((): void => view.root.render(page()));
      await settle();
      expect(card()).toBeNull();
      act((): void => {
        vi.advanceTimersByTime(580);
      });
      expect(card()?.getAttribute('aria-label')).toBe(
        'First week: Working, since 30 Sep 2026, 06:22. Show the whole week',
      );
    } finally {
      vi.useRealTimers();
      view.unmount();
    }
  });
});
