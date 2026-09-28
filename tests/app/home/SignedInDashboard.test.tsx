/** @vitest-environment jsdom */

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getFunctionName, type FunctionReference } from 'convex/server';

/**
 * The signed-in home as the owner sees it, over fixtures shaped as the
 * queries return them. The clock is fixed so the month, today and the waits
 * read the same on every run.
 */
const NOW = Date.UTC(2026, 8, 26, 6, 45);
const minutes = (n: number): number => NOW - n * 60_000;

const month = (days: Array<[string, number]> = []) => ({
  month: '2026-09',
  days: days.map(([day, landed]) => ({ day, landed })),
  atLeast: false,
});

/** The owner's company as `agents.rosterForUser` returns it, newest first. */
const roster = [
  {
    agentId: 'synthetic-owner-agent',
    name: 'Recorded colleague',
    state: 'active',
    autonomous: true,
    roleLine: 'Own routine revenue operations work from Linear tickets for the RevOps team.',
    openCount: 3,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 1,
    docSourceCount: 1,
    landedThisMonth: month([
      ['2026-09-03', 11],
      ['2026-09-17', 2],
    ]),
  },
  {
    agentId: 'synthetic-finance-agent',
    name: 'Finance colleague',
    state: 'active',
    autonomous: false,
    roleLine: 'Close the month for the finance team.',
    openCount: 2,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 2,
    docSourceCount: 1,
    landedThisMonth: month([['2026-09-26', 1]]),
  },
  {
    agentId: 'synthetic-new-agent',
    name: 'New colleague',
    state: 'deployed',
    autonomous: false,
    roleLine: 'charter pending',
    openCount: 0,
    parkedCount: 0,
    stoppedCount: 0,
    needsYou: 0,
    docSourceCount: 0,
    landedThisMonth: month(),
  },
];

/** What waits on the manager, as `work.needsYou` returns it, longest wait first. */
const inbox = {
  entries: [
    {
      kind: 'plan',
      key: 'plan:1',
      agentId: 'synthetic-finance-agent',
      employeeName: 'Finance colleague',
      subject: 'Draft the September close checklist',
      waitingSince: minutes(9),
      waitingAtLeast: false,
      workItemId: 'item-1',
      questions: 0,
    },
    {
      kind: 'held',
      key: 'held:2',
      agentId: 'synthetic-owner-agent',
      employeeName: 'Recorded colleague',
      subject: 'Send you a DM in Slack about escalation guidance',
      waitingSince: minutes(6),
      waitingAtLeast: false,
      workItemId: 'item-2',
      heldWrites: 1,
    },
    {
      kind: 'stopped',
      key: 'stopped:3',
      agentId: 'synthetic-finance-agent',
      employeeName: 'Finance colleague',
      subject: 'Close FIN-4',
      waitingSince: minutes(2),
      waitingAtLeast: false,
      workItemId: 'item-3',
    },
  ],
  total: 3,
  waitingByEmployee: [
    { agentId: 'synthetic-owner-agent', waiting: 1 },
    { agentId: 'synthetic-finance-agent', waiting: 2 },
    { agentId: 'synthetic-new-agent', waiting: 0 },
  ],
};

const oneEmployeeMetrics = {
  charter: { timeToFirstDraftedMs: 30_000, timeToFirstApprovedMs: 67_000, requestChanges: 0 },
  decisions: {
    requested: 2,
    approved: 2,
    rejected: 0,
    partiallyApproved: 0,
    cancelled: 0,
    medianLatencyMs: 48_000,
    p90LatencyMs: 49_000,
    byVia: {
      dashboard: { decided: 2, medianLatencyMs: 48_000, p90LatencyMs: 49_000 },
      channel: { decided: 0, medianLatencyMs: null, p90LatencyMs: null },
    },
  },
  actions: {
    autoApplied: 25,
    // The 17 September recording: 12 reads, 1 manager message, 12 writes.
    automatic: { reads: 12, managerMessages: 1, writes: 12 },
    sessionRestores: 0,
    held: 1,
    approved: 1,
    rejected: 0,
    refused: 0,
    blockedAfterRevocation: null,
    firstBlockAfterRevocationMs: null,
  },
  surfaces: { approved: 3, rejected: 0, absent: 1 },
  skills: { approved: 3, rejected: 0 },
  autonomyChanges: 1,
  auditTrail: { complete: 26, total: 26, fraction: 1 },
  pilot: {
    skillReuse: { runs: 0, reused: 0, rate: null },
    cycleTime: {
      ended: 0,
      medianToEndMs: null,
      completed: 0,
      medianToCompletionMs: null,
      p90ToCompletionMs: null,
    },
    reorientation: { answered: 0, amended: 0, rate: null },
    hoursSaved: { estimatedItems: 0, hours: null },
    retrieval: { tokens: null, recall: null },
  },
};

const state = vi.hoisted(() => ({
  roster: [] as unknown[],
  inbox: undefined as unknown,
}));

vi.mock('convex/react', () => {
  const answer = (reference: FunctionReference<'query'>): unknown => {
    const name = getFunctionName(reference);
    const shown = state.roster as typeof roster;
    if (name === 'agents:listForUser') {
      return shown.map((row) => ({ _id: row.agentId, name: row.name, state: row.state }));
    }
    if (name === 'agents:rosterForUser') return shown;
    if (name === 'work:needsYou') return state.inbox;
    if (name === 'config:surfaceMode') return { mode: 'mock', label: 'mock' };
    if (name === 'docSources:listMine') return [{ _id: 'synthetic-doc-source', label: 'Handbook' }];
    if (name === 'metrics:forOwner' && shown.length > 0) {
      const [first] = shown;
      return {
        employees: [
          {
            agentId: first!.agentId,
            name: first!.name,
            deployedAt: 1,
            metrics: oneEmployeeMetrics,
          },
        ],
        company: {
          employees: 1,
          charter: {
            timesToFirstApprovedMs: [67_000],
            medianTimeToFirstApprovedMs: 67_000,
            approvedEmployees: 1,
          },
          decisions: oneEmployeeMetrics.decisions,
          actions: oneEmployeeMetrics.actions,
          surfaces: oneEmployeeMetrics.surfaces,
          skills: oneEmployeeMetrics.skills,
          autonomyChanges: 1,
          auditTrail: oneEmployeeMetrics.auditTrail,
          pilot: oneEmployeeMetrics.pilot,
        },
        excludedAgents: 0,
        omittedEmployees: 0,
      };
    }
    return undefined;
  };
  return {
    useQuery: answer,
    // The home reads its inbox through `useQueries`, which answers a failed read as a value.
    useQueries: (queries: Record<string, { query: FunctionReference<'query'> }>) =>
      Object.fromEntries(Object.entries(queries).map(([key, { query }]) => [key, answer(query)])),
    useMutation: (): (() => Promise<void>) => async (): Promise<void> => undefined,
  };
});

vi.mock('next/navigation', () => ({
  useRouter: (): { push: () => void } => ({ push: (): void => undefined }),
}));

import { NEEDS_YOU_UNREADABLE } from '../../../app/home/NeedsYouList';
import { SignedInDashboard } from '../../../app/home/SignedInDashboard';

const boss = { email: 'boss@example.invalid', firstName: 'Boss' };

/** The page as the manager reads it at desktop: stacked labels out, tags stripped. */
const readAs = (markup: string): string =>
  markup
    .replace(/<span aria-hidden="true" class="[^"]*\bsm:hidden[^"]*">[^<]*<\/span>/g, '')
    .replace(/<span aria-hidden="true" class="[^"]*\blg:hidden[^"]*">[\s\S]*?<\/span><\/span>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ');

function render(rows: unknown[], needsYou: unknown = inbox): string {
  state.roster = rows;
  state.inbox = needsYou;
  return renderToStaticMarkup(<SignedInDashboard boss={boss} />);
}

beforeEach((): void => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach((): void => {
  vi.useRealTimers();
});

describe('the signed-in home with nobody deployed', (): void => {
  const html = (): string => render([], { entries: [], total: 0, waitingByEmployee: [] });

  it('welcomes the manager and opens on the deploy form, faces showing', (): void => {
    const page = html();
    expect(readAs(page)).toContain('Welcome, Boss.');
    expect(readAs(page)).toContain('Give your first employee a name.');
    expect(page).toContain('Deploy a new Day0 employee');
    expect(page).toMatch(/<details\b[^>]*\bopen=""/);
    expect(readAs(page)).toContain('What happens after Deploy');
    expect(page).not.toContain('Deploy another');
    expect(page).not.toContain('>Needs you<');
  });

  it('shows the empty roster and the ready office below the form', (): void => {
    const page = html();
    expect(readAs(page)).toContain('Your employees 0 total');
    expect(page.indexOf('Deploy a new Day0 employee')).toBeLessThan(page.indexOf('Your employees'));
    expect(page.indexOf('Your employees')).toBeLessThan(page.indexOf('Mini office world'));
    expect(page).toContain('office ready');
  });

  it('names each face by its number and no title carries a person (N6)', (): void => {
    const page = html();
    const faces = [...page.matchAll(/<button[^>]*aria-label="(Face \d+)"/g)].map(
      (match) => match[1],
    );
    expect(faces).toHaveLength(29);
    expect(faces[0]).toBe('Face 1');
    const titles = [...page.matchAll(/title="([^"]*)"/g)].map((match) => match[1]);
    expect(titles.filter((title) => title.includes('@'))).toEqual([]);
    expect(page).not.toContain('singapore-ai-builders');
    expect(page).toContain('Singapore Codex Pets · 29');
  });

  it('keeps the documentation link', (): void => {
    expect(html()).toContain('href="/documentation"');
  });
});

describe('the company home', (): void => {
  it('heads the page with the company in one line and offers another deploy', (): void => {
    const page = render(roster);
    expect(readAs(page)).toContain('Your employees 2 active · 3 things need you');
    expect(page).toMatch(/<button[^>]*aria-expanded="false"[^>]*aria-controls="deploy-form"/);
    expect(readAs(page)).toContain('Deploy another');
    expect(page).not.toContain('Deploy a new Day0 employee');
  });

  it('orders the main column as drawn: needs you, the roster, the office, the month, the figures, reset', (): void => {
    const page = render(roster);
    const order = [
      '>Needs you<',
      '>Roster<',
      'Mini office world',
      'September, supervised from here',
      'Company supervision',
      'Reset demo',
    ].map((marker) => page.indexOf(marker));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it('loses only the inbox when the backend cannot read it, and says so (M6)', (): void => {
    const page = render(
      roster,
      new Error('[CONVEX Q(work:needsYou)] Server Error: too many documents read'),
    );
    const text = readAs(page);
    expect(text).toContain(NEEDS_YOU_UNREADABLE);
    for (const marker of [
      '>Roster<',
      'Mini office world',
      'September, supervised from here',
      'Company supervision',
      'Reset demo',
    ]) {
      expect(page).toContain(marker);
    }
    expect(text).toContain('Your employees 2 active');
    expect(text).not.toContain('things need you');
  });

  it('gives Deploy another, each roster name and Manage a 44 px target (N14, m26)', (): void => {
    const page = render(roster);
    expect(/<button[^>]*aria-controls="deploy-form"[^>]*>/.exec(page)?.[0]).toMatch(/\bmin-h-11\b/);
    const names = [...page.matchAll(/<th scope="row"[^>]*><a [^>]*>/g)].map(([tag]) => tag);
    expect(names.length).toBeGreaterThan(0);
    for (const tag of names) expect(tag).toMatch(/\bmin-h-11\b/);
    expect(/<a [^>]*href="\/documentation"[^>]*>/.exec(page)?.[0]).toMatch(/\bmin-h-11\b/);
  });

  it('lists what waits on the manager from the inbox, and the roster counts it per employee', (): void => {
    const text = readAs(render(roster));
    expect(text).toContain('Finance colleague · a plan to approve');
    expect(text).toContain('Recorded colleague · a write is held for you');
    expect(text).toContain('held since 26 Sep 2026, 06:39');
    expect(text).toContain('Recorded colleague Active');
    expect(text).toContain('acts on its own 1 3 13');
    expect(text).toContain(
      'Finance colleague Active Close the month for the finance team. asks first 2 2 1',
    );
    expect(text).toContain('New colleague Deployed charter pending asks first 0 0 0');
  });

  it('shows every employee’s link, role and autonomy on the roster', (): void => {
    const page = render(roster);
    const list = page.slice(page.indexOf('>Roster<'), page.indexOf('Mini office world'));
    for (const row of roster) {
      expect(list).toContain(`href="/agent/${row.agentId}"`);
      expect(list).toContain(row.name);
      expect(list).toContain(row.roleLine);
    }
    expect(list.match(/acts on its own/g)).toHaveLength(1);
    expect(list.match(/asks first/g)).toHaveLength(2);
  });

  it('puts the role line on each office name plate', (): void => {
    const page = render(roster);
    const office = page.slice(page.indexOf('Mini office world'), page.indexOf('Reset demo'));
    for (const row of roster) expect(office).toContain(row.roleLine);
  });

  it('shows parked work beside open work, as the 19 Sep run left the company', (): void => {
    const page = render([
      { ...roster[0], name: 'Priya', openCount: 0, parkedCount: 3 },
      { ...roster[1], name: 'Aiko', openCount: 0, parkedCount: 1 },
      { ...roster[2], name: 'Mateo' },
    ]);
    const text = readAs(page.slice(page.indexOf('>Roster<'), page.indexOf('Mini office world')));
    expect(text).toContain('Priya Active');
    expect(text).toContain('1 0 3 parked 13');
    expect(text).toContain('2 0 1 parked 1');
    expect(page).toContain(
      'title="Parked: waiting on a connection, a permission, a skill or a free slot',
    );
  });

  it('shows stopped work that still waits on the manager, as the 19 Sep second run left the company', (): void => {
    const page = render([
      { ...roster[0], name: 'Priya', openCount: 0, stoppedCount: 2 },
      { ...roster[1], name: 'Aiko', openCount: 1, parkedCount: 1, stoppedCount: 1 },
      { ...roster[2], name: 'Mateo' },
    ]);
    const list = page.slice(page.indexOf('>Roster<'), page.indexOf('Mini office world'));
    expect(readAs(list)).toContain('1 0 2 stopped 13');
    expect(readAs(list)).toContain('2 1 1 parked · 1 stopped 1');
    expect(list).toContain(
      'title="Stopped: ended short of done, with Retry on the card. The ones waiting on you are in Needs you."',
    );
    expect(list.match(/title="Stopped/g)).toHaveLength(2);
  });

  it('lays the month out with what landed on each day and what waits today', (): void => {
    const page = render(roster);
    expect(page).toContain('aria-label="Days of September"');
    const today = /<li aria-current="date"[^>]*>([\s\S]*?)<\/li>/.exec(page)?.[1] ?? '';
    expect(readAs(today).trim()).toBe('26 1 landed 3 waiting');
    expect(readAs(page)).toContain('Decisions 2 approved, 0 rejected');
  });

  it('says "employee" in every manager-facing string, never "agent" (N29)', (): void => {
    const text = readAs(render(roster));
    expect(text).not.toMatch(/\bagents?\b/i);
    const deploy = readAs(render([], { entries: [], total: 0, waitingByEmployee: [] }));
    expect(deploy).not.toMatch(/\bagents?\b/i);
  });

  it('sets no type below the 12 px floor anywhere on the home', (): void => {
    expect(render(roster)).not.toMatch(/text-\[(9|10|11)px\]/);
    expect(render([], { entries: [], total: 0, waitingByEmployee: [] })).not.toMatch(
      /text-\[(9|10|11)px\]/,
    );
  });

  it('arrives the main column’s cards with the page and leaves the aside still (v4 section 1.3)', (): void => {
    const page = render(roster);
    expect(page).toMatch(/<div data-cards="" class="flex min-w-0 flex-col gap-6"><section/);
    expect(page.match(/data-cards=""/g)).toHaveLength(1);
    expect(page).toMatch(/<aside class="flex flex-col gap-6">/);
  });

  it('keeps the hosted one-employee home under a snapshot', (): void => {
    const page = render([roster[0]], {
      entries: [inbox.entries[1]],
      total: 1,
      waitingByEmployee: [{ agentId: 'synthetic-owner-agent', waiting: 1 }],
    });
    expect(page).toContain('Company supervision');
    expect(page).toMatchSnapshot();
  });
});

describe('Deploy another', (): void => {
  it('opens the form above the inbox with the caret in the name, and closes it again', (): void => {
    vi.useRealTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.roster = roster;
    state.inbox = inbox;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => root.render(<SignedInDashboard boss={boss} />));
    const toggle = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Deploy another',
    )!;

    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    const form = host.querySelector('#deploy-form');
    expect(form).not.toBeNull();
    expect(host.innerHTML.indexOf('Deploy a new Day0 employee')).toBeLessThan(
      host.innerHTML.indexOf('>Needs you<'),
    );
    expect(document.activeElement).toBe(form?.querySelector('input[type="text"]'));
    expect(form?.querySelector('details')?.hasAttribute('open')).toBe(false);

    const cancel = [...host.querySelectorAll('button')].find(
      (button) => button.textContent === 'Cancel',
    )!;
    act(() => cancel.click());
    expect(host.querySelector('#deploy-form')).toBeNull();
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggle);

    act(() => root.unmount());
    host.remove();
  });
});
