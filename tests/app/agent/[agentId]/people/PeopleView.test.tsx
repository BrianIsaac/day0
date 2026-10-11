/** @vitest-environment jsdom */

import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  /** Mutations that reject, by function name, with the words of the `ConvexError` they throw. */
  refusals: {} as Record<string, string>,
  /** What a mutation resolves with, by function name. */
  results: {} as Record<string, unknown>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation:
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      // A refusal written as the transport's envelope reaches the page as a plain error, as an
      // uncaught backend error does; any other is the `ConvexError` a refusal is.
      if (refusal?.startsWith('[CONVEX')) throw new Error(refusal);
      if (refusal !== undefined) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError(refusal);
      }
      return backend.results[name];
    },
  useAction: () => async (): Promise<void> => undefined,
}));

import {
  lastEndedHandover,
  managerCardState,
  namedPeople,
  PeopleView,
  provenanceLine,
} from '../../../../../app/agent/[agentId]/people/PeopleView';
import type { CutCandidate } from '../../../../../app/agent/[agentId]/people/HandOver';
import type { Doc, Id } from '../../../../../convex/_generated/dataModel';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { APPROVED_CHARTER, asEmployee, EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import {
  choose,
  focusedName,
  mount,
  press,
  settle,
  said,
  typeInto,
  unmountAll,
} from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';
import {
  EVALUATION_EMPLOYEE_TRANSFER_REFUSAL,
  UNVERIFIED_FOR_ASK,
} from '../../../../../src/agent/manager-transfer';

describe('namedPeople', () => {
  it('reads the people the charter names with how each is reached, and nobody from a body without the list', () => {
    expect(
      namedPeople({
        namedCollaborators: [
          { name: 'Priya', topic: 'segment and pipeline', introPath: 'self' },
          { name: 'Aman', topic: 'forecasting', introPath: 'sideways' },
          { name: '', topic: 'nobody' },
          { topic: 'no name' },
          'not a person',
        ],
      }),
    ).toEqual([
      { name: 'Priya', topic: 'segment and pipeline', introPath: 'self' },
      { name: 'Aman', topic: 'forecasting' },
    ]);
    expect(namedPeople({})).toEqual([]);
    expect(namedPeople(undefined)).toEqual([]);
  });
});

describe('provenanceLine', () => {
  it('names the earlier manager who approved the version, never "you" (the second pass, item 4)', () => {
    const approvedAt = Date.UTC(2026, 8, 26, 14, 23);
    expect(
      provenanceLine(
        { ...APPROVED_CHARTER, approvedAt } as Doc<'charters'>,
        'UTC',
        'sam@kestrel.example',
      ),
    ).toBe('Named in charter version 0.1, approved by sam@kestrel.example 26 Sep 2026, 14:23.');
  });

  it('says which charter version names them, and whether and when it was approved', () => {
    const approvedAt = Date.UTC(2026, 8, 26, 14, 23);
    expect(provenanceLine({ ...APPROVED_CHARTER, approvedAt } as Doc<'charters'>, 'UTC')).toBe(
      'Named in charter version 0.1, approved by you 26 Sep 2026, 14:23.',
    );
    expect(provenanceLine({ ...APPROVED_CHARTER, approved: false } as Doc<'charters'>, 'UTC')).toBe(
      'Named in charter version 0.1, not approved yet.',
    );
  });
});

/** 1 October 2026, 09:00 UTC. */
const ASKED = Date.UTC(2026, 9, 1, 9, 0);

/** The request Mira's old manager has open to lead@day0.local. */
const OPEN_ASKED = {
  transferId: 'transfer-1' as Id<'managerTransfers'>,
  agentId: 'agent-1' as Id<'agents'>,
  toAddress: 'lead@day0.local',
  note: 'Mid-way through the close.',
  state: 'asked' as const,
  requestedAt: ASKED,
  expiresAt: Date.UTC(2026, 9, 15, 9, 0),
};

/**
 * The employee's cards as `surfaces.listForAgent` lists them: Linear connected on the old
 * manager's credential, Slack approved, Notion still proposed, and a Looker card found absent after
 * the old manager approved it, which the move cuts as well.
 */
const SURFACES = [
  { displayName: 'Linear', verdict: 'connected', credentialId: 'credential-1' },
  { displayName: 'Slack', verdict: 'approved' },
  { displayName: 'Notion', verdict: 'proposed' },
  { displayName: 'Looker', verdict: 'absent', managerApprovedAt: 5 },
] as CutCandidate[];

/** The page's reads for an employee that reports to its owner, with no handover. */
function settled(overrides: Record<string, unknown> = {}): void {
  backend.queries = {
    'managerTransfers:openForAgent': null,
    'agents:managerStanding': { standing: 'you' },
    'managerTransfers:departures': [],
    'config:surfaceMode': {
      mode: 'real',
      label: 'real (local)',
      deploymentProfile: 'customer-local',
    },
    'surfaces:listForAgent': SURFACES,
    ...overrides,
  };
}

/** The Manager card, the section whose heading is Manager. */
function managerCard(scope: ParentNode): HTMLElement {
  const card = [...scope.querySelectorAll<HTMLElement>('section')].find(
    (section) => section.querySelector('h2')?.textContent === 'Manager',
  );
  if (!card) throw new Error('no Manager card');
  return card;
}

/** The dialog open on the page. */
function openDialog(): HTMLElement {
  const dialog = document.querySelector<HTMLElement>('[role="dialog"], [role="alertdialog"]');
  if (!dialog) throw new Error('no dialog');
  return dialog;
}

/** The buttons of a scope, by their names. */
function buttonNames(scope: ParentNode): string[] {
  return [...scope.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
}

describe('PeopleView', () => {
  beforeEach(() => settled());

  afterEach(() => {
    unmountAll();
    backend.queries = {};
    backend.refusals = {};
    backend.results = {};
    backend.calls = [];
  });

  const charter = {
    ...APPROVED_CHARTER,
    body: {
      namedCollaborators: [{ name: 'Priya', topic: 'segment and pipeline', introPath: 'self' }],
    },
  } as Doc<'charters'>;

  it('names the manager as you, says what that means and offers Hand over, and the people the charter names', () => {
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { charter }));
    expect(html).toContain('boss<wbr/>@day0.local');
    expect(html).toMatch(/>you<\/span>/);
    expect(html).toMatch(/>manager<\/span>/);
    expect(html).toContain(
      'Every held write and every plan comes to you. One manager per employee.',
    );
    expect(html).toContain('Priya');
    expect(html).toContain(' · segment and pipeline · reaches out directly');
    expect(html).toContain('Named in charter version 0.1, approved by you.');
    backend.queries['managerTransfers:earlierManagers'] = [
      { fromAddress: 'sam@kestrel.example', decidedAt: 5_000 },
    ];
    const carried = renderToStaticMarkup(
      asEmployee(<PeopleView />, { charter: { ...charter, approvedAt: 1_000 } }),
    );
    // Approved before a handover by the manager who handed it over (the second pass, item 4).
    expect(carried).toContain('approved by sam@kestrel.example');
    expect(carried).not.toContain('approved by you');
    // An amendment can add a person, so the line never claims the one-to-one named them.
    expect(html).not.toContain('From your one-to-one');
    // 13-P: in mock mode the graph is not kept, and the Proposed card says what a deployment of
    // the manager's own does, where it said the tab proposed nobody yet. Re-pinned by 13-FD: said
    // as every other mock-mode sentence says it, of "the hosted office", where it said "this demo".
    expect(html).toContain(
      'In a deployment of your own, Mira proposes people from the one-to-one and your documentation for you to confirm. The hosted office keeps the names the one-to-one gave the charter, below.',
    );
    expect(html).not.toMatch(/<button[^>]*>(Confirm|Dismiss|A different person)/);
    expect(html).toMatch(/<button[^>]*>Hand over<\/button>/);
    // The free edit is gone (the transfer plan, section 9).
    expect(html).not.toContain('Change manager');
    // Every manager-facing word says employee (N29); a link's address is not a word.
    expect(html.replace(/<[^>]*>/g, ' ')).not.toMatch(/\bagent\b/i);
  });

  it("says in the hosted office that the employee reads the charter's names, as no graph is kept there (13-FD)", () => {
    const mock = renderToStaticMarkup(asEmployee(<PeopleView />, { surfaceMode: 'mock' }));
    expect(mock).toContain(
      'The hosted office keeps no graph, so Mira reads the people only as its charter names them.',
    );
    expect(mock).not.toContain('regenerated when the graph changes');
    const real = renderToStaticMarkup(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(real).toContain('regenerated when the graph changes');
    expect(real).not.toContain('The hosted office keeps no graph');
  });

  it('says the one-to-one asks who the employee works with when the charter names nobody', () => {
    expect(renderToStaticMarkup(asEmployee(<PeopleView />))).toContain(
      'The charter names nobody yet.',
    );
  });

  it('offers Hand over only once the mode is known, since what happens depends on it', () => {
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { surfaceMode: undefined }));
    expect(html).not.toContain('Hand over</button>');
  });

  it('claims nothing about the address while its standing is read', () => {
    settled({ 'agents:managerStanding': undefined });
    const html = renderToStaticMarkup(asEmployee(<PeopleView />));
    expect(html).toContain('boss<wbr/>@day0.local');
    expect(html).not.toMatch(/>you<\/span>/);
    expect(html).not.toContain('Hand over</button>');
  });

  it('asks through a dialog that says what happens, then says so on the card and gives it focus', async () => {
    backend.results = { 'managerTransfers:ask': 'transfer-1' };
    const view = mount(asEmployee(<PeopleView />, { charter, surfaceMode: 'real' }));

    await press(view.container, 'Hand over');
    const dialog = openDialog();
    expect(dialog.querySelector('h2')?.textContent).toBe('Hand Mira over to another manager?');
    expect(dialog.textContent).toContain("The new manager's email address");
    expect(dialog.textContent).toContain(
      'They accept or decline in Day0, signed in with this address.',
    );
    expect(dialog.textContent).toContain('A note for them (optional)');
    expect(dialog.textContent).toContain(
      'What they should know first. They read it before they decide.',
    );
    expect([...dialog.querySelectorAll('li')].map((line) => line.textContent)).toEqual([
      'Nothing changes until they accept. You keep every decision in the meantime, and you can cancel.',
      'When they accept, Mira becomes theirs. It leaves your home and your team, and this page closes to you.',
      'Its connection to Linear is cut. They approve it and connect it again with their own credentials.',
      'Its connection to Slack is cut. They approve it and connect it again with their own credentials.',
      'Its connection to Looker is cut. They approve it and connect it again with their own credentials.',
      'Credentials only Mira uses are revoked. Ones another employee or your documentation uses stay yours.',
      'Its record, charter, skills and lessons go with it. Your documentation stays yours.',
      expect.stringMatching(
        /^Unanswered, the request expires on \d{1,2} \w{3} \d{4}, \d{2}:\d{2}, UTC time\.$/,
      ),
    ]);
    const [address, note] = [...dialog.querySelectorAll<HTMLInputElement>('input, textarea')];
    if (!address || !note) throw new Error('no fields');
    expect(document.activeElement).toBe(address);
    expect(buttonNames(dialog)).toEqual(['Cancel', 'Ask them']);
    typeInto(address, ' lead@day0.local ');
    typeInto(note, ' Mid-way through the close. ');
    expect(buttonNames(dialog)).toEqual(['Cancel', 'Ask lead@day0.local']);
    await press(dialog, 'Ask lead@day0.local');

    expect(backend.calls).toEqual([
      {
        name: 'managerTransfers:ask',
        args: {
          agentId: 'agent-1',
          toAddress: 'lead@day0.local',
          note: 'Mid-way through the close.',
        },
      },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      'Asked lead@day0.local to take Mira on. Nothing changes until they accept.',
    ]);
    expect(document.activeElement).toBe(managerCard(view.container));
  });

  it('asks without a note when none is written', async () => {
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Hand over');
    const address = openDialog().querySelector('input');
    if (!address) throw new Error('no field');
    typeInto(address, 'lead@day0.local');
    await press(openDialog(), 'Ask lead@day0.local');
    expect(backend.calls).toEqual([
      { name: 'managerTransfers:ask', args: { agentId: 'agent-1', toAddress: 'lead@day0.local' } },
    ]);
  });

  it('says the office goes with the employee in the hosted office', async () => {
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'mock' }));
    await press(view.container, 'Hand over');
    const lines = [...openDialog().querySelectorAll('li')].map((line) => line.textContent);
    expect(lines).toContain("In the hosted office, the office's systems go with Mira.");
    expect(lines.join(' ')).not.toMatch(/credential/);
  });

  it('keeps the dialog open on a refusal, says it there in the backend’s words, and nothing on the card', async () => {
    backend.refusals = {
      'managerTransfers:ask':
        "That is your own address. Hand Mira over to another manager's address.",
    };
    const view = mount(asEmployee(<PeopleView />));

    await press(view.container, 'Hand over');
    const address = openDialog().querySelector('input');
    if (!address) throw new Error('no field');
    typeInto(address, 'boss@day0.local');
    await press(openDialog(), 'Ask boss@day0.local');

    expect(said(openDialog())).toEqual([
      "That is your own address. Hand Mira over to another manager's address.",
    ]);
    expect(said(managerCard(view.container))).toEqual([]);
    expect(focusedName()).toBe('Ask boss@day0.local');
  });

  it('says a refusal that reaches the page in the transport’s envelope without it (re-pinned from the header’s Change manager)', async () => {
    backend.refusals = {
      'managerTransfers:ask':
        '[CONVEX M(managerTransfers:ask)] [Request ID: 1] Server Error\nUncaught Error: That is not an e-mail address.\n    at handler (../convex/managerTransfers.ts:1:1)',
    };
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Hand over');
    const address = openDialog().querySelector('input');
    if (!address) throw new Error('no field');
    typeInto(address, 'lead@day0');
    await press(openDialog(), 'Ask lead@day0');
    expect(said(openDialog())).toEqual(['That is not an e-mail address.']);
    expect(focusedName()).toBe('Ask lead@day0');
  });

  it('says nothing on the card once a refused ask is cancelled (m38), and gives focus back to Hand over', async () => {
    backend.refusals = {
      'managerTransfers:ask': 'lead@day0.local has too many handovers waiting.',
    };
    const view = mount(asEmployee(<PeopleView />));

    await press(view.container, 'Hand over');
    const address = openDialog().querySelector('input');
    if (!address) throw new Error('no field');
    typeInto(address, 'lead@day0.local');
    await press(openDialog(), 'Ask lead@day0.local');
    expect(said(openDialog())).toEqual(['lead@day0.local has too many handovers waiting.']);
    await press(openDialog(), 'Cancel');

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual([]);
    expect(focusedName()).toBe('Hand over');
  });

  it('holds Ask until the cards are read in real mode, so the account of what is cut is whole', async () => {
    settled({ 'surfaces:listForAgent': undefined });
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    await press(view.container, 'Hand over');
    const address = openDialog().querySelector('input');
    if (!address) throw new Error('no field');
    typeInto(address, 'lead@day0.local');
    const ask = [...openDialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Ask lead@day0.local',
    );
    expect(ask?.disabled).toBe(true);
  });

  it('holds every other control on the card while a change runs', async () => {
    settled({ 'agents:managerStanding': { standing: 'other', bossEmail: 'ana@day0.local' } });
    let release: () => void = () => undefined;
    backend.results = {
      'agents:adoptManagerAddress': new Promise<void>((resolve) => {
        release = resolve;
      }).then(() => ({ changed: true, reprobed: 0 })),
    };
    const view = mount(asEmployee(<PeopleView />));
    const card = managerCard(view.container);
    const make = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Make it you',
    );
    make?.focus();
    await act(async (): Promise<void> => {
      make?.click();
    });
    expect(
      [...card.querySelectorAll('button')].map((button) => [button.textContent, button.disabled]),
    ).toEqual([
      ['Hand over to ana@day0.local', true],
      ['Make it you', true],
    ]);
    await act(async (): Promise<void> => {
      release();
    });
  });

  it('says an asked request with its stamps and offers to change the address or cancel', () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));
    const card = managerCard(view.container);
    expect(card.textContent).toContain(
      'Handing over to lead@day0.local. Asked 1 Oct 2026, 09:00, UTC time; expires 15 Oct 2026, 09:00, UTC time. Mira works for you until they accept.',
    );
    expect(buttonNames(card)).toEqual(['Change the address', 'Cancel the handover']);
  });

  it('changes the address of an asked request in the same dialog, with its note', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    backend.results = { 'managerTransfers:changeAddress': 'transfer-2' };
    const view = mount(asEmployee(<PeopleView />));

    await press(view.container, 'Change the address');
    const [address, note] = [...openDialog().querySelectorAll<HTMLInputElement>('input, textarea')];
    if (!address || !note) throw new Error('no fields');
    expect(address.value).toBe('lead@day0.local');
    expect(note.value).toBe('Mid-way through the close.');
    typeInto(address, 'deputy@day0.local');
    await press(openDialog(), 'Ask deputy@day0.local');

    expect(backend.calls).toEqual([
      {
        name: 'managerTransfers:changeAddress',
        args: {
          transferId: 'transfer-1',
          toAddress: 'deputy@day0.local',
          note: 'Mid-way through the close.',
        },
      },
    ]);
    expect(said(view.container)).toEqual([
      'Asked deputy@day0.local to take Mira on. Nothing changes until they accept.',
    ]);
  });

  it('says the change of address asks again, and offers Keep the address rather than a second Cancel', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Change the address');
    const description = document.getElementById(
      openDialog().getAttribute('aria-describedby') ?? '',
    );
    expect(description?.textContent).toBe(
      'The request to lead@day0.local is cancelled and a new one is asked, so its 14 days start again.',
    );
    expect(buttonNames(openDialog())).toEqual(['Keep the address', 'Ask lead@day0.local']);
    await press(openDialog(), 'Keep the address');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(backend.calls).toEqual([]);
  });

  it('keeps the dialog open on a refused change of address, and says it there only', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    backend.refusals = {
      'managerTransfers:changeAddress': 'The handover is already addressed to lead@day0.local.',
    };
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Change the address');
    await press(openDialog(), 'Ask lead@day0.local');
    expect(said(openDialog())).toEqual(['The handover is already addressed to lead@day0.local.']);
    expect(said(managerCard(view.container))).toEqual([]);
  });

  it('keeps the confirmation open on a refused cancel, and says it there only', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    backend.refusals = { 'managerTransfers:cancel': 'This handover was already accepted.' };
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Cancel the handover');
    await press(openDialog(), 'Cancel the handover');
    expect(said(openDialog())).toEqual(['This handover was already accepted.']);
    expect(said(managerCard(view.container))).toEqual([]);
  });

  it('cancels behind a confirmation that keeps focus on Keep, then says so on the card', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));

    await press(view.container, 'Cancel the handover');
    const confirm = openDialog();
    expect(confirm.getAttribute('role')).toBe('alertdialog');
    expect(confirm.querySelector('h2')?.textContent).toBe(
      'Cancel the handover to lead@day0.local?',
    );
    expect(confirm.textContent).toContain('Their request disappears from their inbox.');
    expect(focusedName()).toBe('Keep the handover');
    await press(confirm, 'Cancel the handover');

    expect(backend.calls).toEqual([
      { name: 'managerTransfers:cancel', args: { transferId: 'transfer-1' } },
    ]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(said(view.container)).toEqual(['The handover to lead@day0.local is cancelled.']);
  });

  it('keeps the request when Keep is pressed, and sends nothing', async () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Cancel the handover');
    await press(openDialog(), 'Keep the handover');
    expect(backend.calls).toEqual([]);
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(focusedName()).toBe('Cancel the handover');
  });

  it('says an accepting request with the runs it waits on and its deadline, and offers no control', () => {
    settled({
      'managerTransfers:openForAgent': {
        ...OPEN_ASKED,
        state: 'accepting',
        settleBy: Date.UTC(2026, 9, 2, 10, 15),
        runsInFlight: 2,
      },
    });
    const view = mount(asEmployee(<PeopleView />));
    const card = managerCard(view.container);
    expect(card.textContent).toContain(
      'Accepted by lead@day0.local. Mira is finishing 2 runs; it becomes theirs when they end, by 2 Oct 2026, 10:15, UTC time at the latest.',
    );
    expect(buttonNames(card)).toEqual([]);
  });

  it('says it aloud when the asked manager declines, once the decline is read', () => {
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));
    expect(said(view.container)).toEqual([]);
    // The request leaves asked a read before its decline arrives.
    settled();
    act((): void => view.root.render(asEmployee(<PeopleView />)));
    expect(said(view.container)).toEqual([]);
    settled({
      'managerTransfers:departures': [
        {
          transferId: 'transfer-1',
          agentId: 'agent-1',
          agentName: 'Mira',
          toAddress: 'lead@day0.local',
          state: 'declined',
          decidedAt: Date.UTC(2026, 9, 3, 8, 30),
        },
      ],
    });
    act((): void => view.root.render(asEmployee(<PeopleView />)));
    expect(said(view.container)).toEqual([
      'Declined by lead@day0.local on 3 Oct 2026, 08:30, UTC time.',
    ]);
  });

  it('says nothing aloud of an ended request that was not open on this page', () => {
    settled({
      'managerTransfers:departures': [
        {
          transferId: 'transfer-1',
          agentId: 'agent-1',
          agentName: 'Mira',
          toAddress: 'lead@day0.local',
          state: 'expired',
          decidedAt: Date.UTC(2026, 9, 3, 8, 30),
        },
      ],
    });
    expect(said(mount(asEmployee(<PeopleView />)).container)).toEqual([]);
  });

  it('says the newest decline with its reason, and offers Hand over again', () => {
    settled({
      'managerTransfers:departures': [
        {
          transferId: 'transfer-1',
          agentId: 'agent-1',
          agentName: 'Mira',
          toAddress: 'lead@day0.local',
          state: 'declined',
          decidedAt: Date.UTC(2026, 9, 3, 8, 30),
          declineReason: 'Not my team.',
        },
      ],
    });
    const view = mount(asEmployee(<PeopleView />));
    const card = managerCard(view.container);
    expect(card.textContent).toContain(
      'Declined by lead@day0.local on 3 Oct 2026, 08:30, UTC time: "Not my team."',
    );
    expect(buttonNames(card)).toEqual(['Hand over']);
  });

  it('says the newest expiry, and nothing of another employee’s requests', () => {
    settled({
      'managerTransfers:departures': [
        {
          transferId: 'transfer-9',
          agentId: 'agent-2',
          agentName: 'Tomas',
          toAddress: 'other@day0.local',
          state: 'declined',
          decidedAt: Date.UTC(2026, 9, 4, 8, 30),
        },
        {
          transferId: 'transfer-1',
          agentId: 'agent-1',
          agentName: 'Mira',
          toAddress: 'lead@day0.local',
          state: 'expired',
          decidedAt: Date.UTC(2026, 9, 3, 8, 30),
        },
      ],
    });
    const card = managerCard(mount(asEmployee(<PeopleView />)).container);
    expect(card.textContent).toContain(
      'The request to lead@day0.local expired on 3 Oct 2026, 08:30, UTC time.',
    );
    expect(card.textContent).not.toContain('other@day0.local');
  });

  it('flags an address that is not the owner’s and offers Hand over to it, filled in, or Make it you (D17)', async () => {
    settled({ 'agents:managerStanding': { standing: 'other', bossEmail: 'ana@day0.local' } });
    const agent = { ...asEmployeeAgent(), bossEmail: 'ana@day0.local' };
    const view = mount(asEmployee(<PeopleView />, { agent }));
    const card = managerCard(view.container);
    expect(card.textContent).toContain(
      'Mira reports to ana@day0.local, who is not you. From this release the manager is the account that owns the employee. Hand Mira over to ana@day0.local, or make yourself its manager.',
    );
    expect(card.innerHTML).not.toMatch(/>you<\/span>/);
    expect(buttonNames(card)).toEqual(['Hand over to ana@day0.local', 'Make it you']);
    // Flagged in the warn tone the home's line has, and Make it you names what it answers.
    expect(card.className).toContain('border-[var(--color-warn-line)]');
    const make = [...card.querySelectorAll('button')].find(
      (button) => button.textContent === 'Make it you',
    );
    expect(document.getElementById(make?.getAttribute('aria-describedby') ?? '')?.textContent).toBe(
      'Mira reports to ana@day0.local, who is not you. From this release the manager is the account that owns the employee. Hand Mira over to ana@day0.local, or make yourself its manager.',
    );

    await press(card, 'Hand over to ana@day0.local');
    expect(openDialog().querySelector('input')?.value).toBe('ana@day0.local');
    expect(await axeViolations(openDialog())).toEqual([]);
    expect(underTarget(openDialog())).toEqual([]);
    await press(openDialog(), 'Cancel');
  });

  it('makes the owner the manager with Make it you, and says so on the card', async () => {
    settled({ 'agents:managerStanding': { standing: 'other', bossEmail: 'ana@day0.local' } });
    backend.results = { 'agents:adoptManagerAddress': { changed: true, reprobed: 0 } };
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Make it you');
    expect(backend.calls).toEqual([
      { name: 'agents:adoptManagerAddress', args: { agentId: 'agent-1' } },
    ]);
    expect(said(view.container)).toEqual(['Mira now reports to you.']);
    expect(document.activeElement).toBe(managerCard(view.container));
  });

  it('says a refused Make it you on the card in the backend’s words', async () => {
    settled({ 'agents:managerStanding': { standing: 'other', bossEmail: 'ana@day0.local' } });
    backend.refusals = {
      'agents:adoptManagerAddress': 'Your sign-in does not carry a verified email address.',
    };
    const view = mount(asEmployee(<PeopleView />));
    await press(view.container, 'Make it you');
    expect(said(view.container)).toEqual(['Your sign-in does not carry a verified email address.']);
  });

  it('draws an evaluation employee and an unverified owner without the flag or the you chip, and says why there is no Hand over (the wave 9 review’s U4-m8)', () => {
    const why = {
      evaluation: EVALUATION_EMPLOYEE_TRANSFER_REFUSAL,
      unverified: UNVERIFIED_FOR_ASK,
    } as const;
    for (const standing of ['evaluation', 'unverified'] as const) {
      settled({ 'agents:managerStanding': { standing } });
      const card = managerCard(mount(asEmployee(<PeopleView />)).container);
      expect(card.textContent).toContain('Every held write and every plan comes to you.');
      expect(card.textContent).not.toContain('who is not you');
      expect(card.innerHTML).not.toMatch(/>you<\/span>/);
      // The ask would refuse, so the card offers none and says the refusal's own words.
      expect(buttonNames(card)).toEqual([]);
      expect(card.textContent).toContain(why[standing]);
      unmountAll();
    }
  });

  it('passes axe and keeps every control at 44 px, on the card in each state and in both dialogs (14.1 item 10)', async () => {
    const states: Record<string, unknown>[] = [
      {},
      { 'managerTransfers:openForAgent': OPEN_ASKED },
      {
        'managerTransfers:openForAgent': {
          ...OPEN_ASKED,
          state: 'accepting',
          settleBy: ASKED,
          runsInFlight: 0,
        },
      },
      { 'agents:managerStanding': { standing: 'other', bossEmail: 'ana@day0.local' } },
    ];
    for (const state of states) {
      settled(state);
      const view = mount(asEmployee(<PeopleView />));
      expect(await axeViolations(view.container)).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      unmountAll();
    }
    settled({ 'managerTransfers:openForAgent': OPEN_ASKED });
    const view = mount(asEmployee(<PeopleView />));
    for (const control of ['Change the address', 'Cancel the handover']) {
      await press(view.container, control);
      expect(await axeViolations(openDialog())).toEqual([]);
      expect(underTarget(openDialog())).toEqual([]);
      await press(
        openDialog(),
        control === 'Change the address' ? 'Keep the address' : 'Keep the handover',
      );
    }
  });
});

describe('PeopleView on an installation that signs everyone in as one manager', () => {
  afterEach(() => {
    unmountAll();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('says why there is no Hand over under local-dev with the local sign-in, and offers it under customer-local', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('NEXT_PUBLIC_DEV_NO_AUTH', 'true');
    vi.resetModules();
    const { PeopleView: LocalPeople } =
      await import('../../../../../app/agent/[agentId]/people/PeopleView');
    const { asEmployee: asLocalEmployee } = await import('../../../../fixtures/dom/employee');
    settled({
      'config:surfaceMode': { mode: 'real', label: 'real (local)', deploymentProfile: 'local-dev' },
    });
    const local = managerCard(mount(asLocalEmployee(<LocalPeople />)).container);
    expect(local.textContent).toContain(
      'This installation signs everyone in as one manager. Handing over needs each manager to sign in as themselves (the customer-local profile).',
    );
    expect(buttonNames(local)).toEqual([]);
    unmountAll();

    settled();
    const customer = managerCard(mount(asLocalEmployee(<LocalPeople />)).container);
    expect(customer.textContent).not.toContain('signs everyone in as one manager');
    expect(buttonNames(customer)).toEqual(['Hand over']);
  });
});

describe('the Manager card’s state and reads', () => {
  it('waits for the open request and the standing, and puts an open request before the standing', () => {
    expect(managerCardState(undefined, { standing: 'you' }, undefined)).toEqual({
      kind: 'loading',
    });
    expect(managerCardState(null, undefined, undefined)).toEqual({ kind: 'loading' });
    expect(
      managerCardState(OPEN_ASKED, { standing: 'other', bossEmail: 'a@b.c' }, undefined),
    ).toEqual({
      kind: 'asked',
      open: OPEN_ASKED,
    });
    expect(managerCardState(null, { standing: 'you' }, undefined)).toEqual({
      kind: 'standing',
      standing: { standing: 'you' },
      ended: undefined,
    });
  });

  it('reads the newest ended request for this employee, and none once one was accepted since', () => {
    const declined = {
      transferId: 'transfer-1' as Id<'managerTransfers'>,
      agentId: 'agent-1' as Id<'agents'>,
      agentName: 'Mira',
      toAddress: 'lead@day0.local',
      state: 'declined' as const,
      decidedAt: 2,
    };
    expect(lastEndedHandover([declined], declined.agentId)).toEqual(declined);
    expect(
      lastEndedHandover([{ ...declined, state: 'accepted' }, declined], declined.agentId),
    ).toBeUndefined();
    expect(lastEndedHandover(undefined, declined.agentId)).toBeUndefined();
  });

  it('draws the runs the server counts for the move, and reads no work of its own to count them (U4-m4)', () => {
    settled({
      'managerTransfers:openForAgent': {
        ...OPEN_ASKED,
        state: 'accepting',
        settleBy: ASKED,
        runsInFlight: 1,
      },
      // An approved set not yet applied, which the old card counted and the move does not.
      'work:listForAgent': [
        { state: 'executing' },
        { state: 'actions-pending', approvedIndexes: [0] },
      ],
    });
    const view = mount(asEmployee(<PeopleView />));
    expect(managerCard(view.container).textContent).toContain('Mira is finishing 1 run;');
  });
});

/** The graph a real-mode tab reads: one of each proposal and one confirmed person. */
const GRAPH = {
  proposals: [
    {
      personId: 'person-dana',
      name: 'Dana Okafor',
      role: 'Finance systems owner',
      status: 'unverified',
      evidence: [
        {
          quote:
            '| NetLedger | the books | Finance systems owner: Dana Okafor approves `NetLedger` access |',
          where: 'Kestrel Supply onboarding',
          at: Date.UTC(2026, 9, 5, 6, 0),
        },
        { quote: 'Dana Okafor for NetLedger.', where: 'the one-to-one', at: 1 },
      ],
      waiting: [{ type: 'approval-authority', scope: 'NetLedger access' }],
    },
    {
      personId: 'person-sara',
      name: 'Sara Lim',
      status: 'unverified',
      evidence: [{ quote: 'Sara Lim for ad-hoc asks.', where: 'the one-to-one', at: 1 }],
      match: { identityId: 'identity-sara', handle: 'sara' },
      waiting: [{ type: 'collaborator' }],
    },
    {
      personId: 'person-priya-2',
      name: 'Priya Shah',
      status: 'unverified',
      evidence: [{ quote: 'Priya Shah owns pipeline.', where: 'Team overview', at: 1 }],
      possiblySameAs: {
        personId: 'person-priya',
        name: 'Priya Shah',
        role: 'Revenue operations',
        standing: 'confirmed',
      },
      waiting: [],
    },
  ],
  confirmed: [
    {
      personId: 'person-priya',
      name: 'Priya Shah',
      role: 'Revenue operations',
      confirmedAt: Date.UTC(2026, 9, 5, 7, 0),
      evidence: {
        quote: 'Priya Shah for segment and pipeline.',
        where: 'the one-to-one',
        at: Date.UTC(2026, 9, 5, 5, 0),
      },
      identities: [
        {
          identityId: 'identity-priya',
          provider: 'slack',
          externalId: 'U0PRIYA',
          displayName: 'priya',
          verified: true,
        },
      ],
      edges: [
        {
          relationshipId: 'edge-priya',
          type: 'collaborator',
          scope: 'segment and pipeline',
          since: Date.UTC(2026, 9, 5, 7, 0),
          fromEmployee: true,
        },
      ],
    },
  ],
};

/** The Proposed card, the section whose heading is Proposed. */
function section(scope: ParentNode, title: string): HTMLElement {
  const card = [...scope.querySelectorAll<HTMLElement>('section')].find(
    (candidate) => candidate.querySelector('h2')?.textContent === title,
  );
  if (!card) throw new Error(`no ${title} card`);
  return card;
}

describe('PeopleView: the people graph (wave 13, 13-P)', () => {
  beforeEach(() => settled({ 'people:forEmployee': GRAPH }));

  afterEach(() => {
    unmountAll();
    backend.queries = {};
    backend.refusals = {};
    backend.results = {};
    backend.calls = [];
  });

  it('shows each proposal with its evidence and the buttons its state takes, in the drafted words', () => {
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    const proposed = section(view.container, 'Proposed');
    expect(proposed.textContent).toContain(
      'Mira found these people. Confirm the ones that are right.',
    );
    expect(proposed.textContent).toContain('3 waiting on you');
    expect(proposed.textContent).toContain('Dana Okafor, Finance systems owner');
    // A table row's bars and code marks are left out, and further evidence waits behind a disclosure.
    expect(proposed.textContent).toContain(
      'Evidence: “NetLedger · the books · Finance systems owner: Dana Okafor approves NetLedger access” (Kestrel Supply onboarding, 5 Oct 2026, 06:00).',
    );
    expect(proposed.querySelector('summary')?.textContent).toBe('1 more source');
    expect(proposed.textContent).toContain('Approver: NetLedger access.');
    expect(proposed.textContent).toContain('Collaborator.');
    expect(proposed.textContent).toContain('Matches Slack user @sara.');
    expect(proposed.textContent).toContain(
      'Possibly the same as Priya Shah, Revenue operations (already confirmed).',
    );
    expect(proposed.textContent).toContain(
      'Same person adds these words to Priya Shah; Different keeps them apart.',
    );
    expect([...proposed.querySelectorAll('h3')].map((heading) => heading.textContent)).toEqual([
      'Dana Okafor, Finance systems owner',
      'Sara Lim',
      'Priya Shah',
    ]);
    expect(buttonNames(proposed)).toEqual([
      'Confirm',
      'Dismiss',
      'Confirm as @sara',
      'A different person',
      'Dismiss',
      'Same person',
      'Different',
    ]);
  });

  it('confirms, dismisses and merges through the card, says so in its one status region and keeps focus on it', async () => {
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    await press(view.container, 'Confirm Dana Okafor');
    expect(backend.calls).toContainEqual({
      name: 'people:confirm',
      args: { personId: 'person-dana', agentId: 'agent-1' },
    });
    expect(said(section(view.container, 'Proposed'))).toEqual([
      'Confirmed Dana Okafor: now under Confirmed.',
    ]);
    // The row that followed the decided one takes focus, the pressed control having gone with it.
    expect(document.activeElement?.textContent).toBe('Sara Lim');
    await press(view.container, 'A different person: Sara Lim is not @sara');
    expect(backend.calls.at(-1)).toEqual({
      name: 'people:notThisMatch',
      args: { personId: 'person-sara', agentId: 'agent-1', identityId: 'identity-sara' },
    });
    await press(view.container, 'Same person: Priya Shah is the Priya Shah already confirmed');
    expect(backend.calls.at(-1)?.name).toBe('people:samePerson');
    backend.refusals['people:dismiss'] = 'Nothing about this person is waiting on you.';
    await press(view.container, 'Dismiss Sara Lim');
    expect(said(section(view.container, 'Proposed'))).toEqual([
      'Nothing about this person is waiting on you.',
    ]);
  });

  it('lists a confirmed person with their identities and edges, and changes, ends and adds an edge', async () => {
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    const confirmed = section(view.container, 'Confirmed');
    expect(confirmed.textContent).toContain('Priya Shah, Revenue operations');
    expect(confirmed.textContent).toContain('Confirmed by you 5 Oct 2026, 07:00.');
    expect(confirmed.textContent).toContain('Identities: Slack @priya.');
    expect(confirmed.textContent).toContain(
      'Collaborator: segment and pipeline · since 5 Oct 2026, 07:00',
    );
    await press(confirmed, 'End collaborator Priya Shah');
    expect(backend.calls.at(-1)).toEqual({
      name: 'people:retireRelationship',
      args: { relationshipId: 'edge-priya', agentId: 'agent-1' },
    });
    await press(confirmed, 'Change collaborator Priya Shah');
    const select = confirmed.querySelector('select') as HTMLSelectElement;
    await choose(select, 'escalation-contact');
    typeInto(confirmed.querySelector('input') as HTMLInputElement, 'pipeline questions');
    await press(confirmed, 'Save');
    expect(backend.calls.at(-1)).toEqual({
      name: 'people:editRelationship',
      args: {
        relationshipId: 'edge-priya',
        agentId: 'agent-1',
        type: 'escalation-contact',
        scope: 'pipeline questions',
      },
    });
    expect(said(confirmed)).toEqual(['Changed Priya Shah to escalation contact.']);
    await press(confirmed, 'Add a relationship with Priya Shah');
    await settle();
    // The form takes focus as it opens; Cancel hands it back to the person's row.
    expect(document.activeElement?.tagName).toBe('SELECT');
    await press(confirmed, 'Cancel');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    expect(document.activeElement?.textContent).toBe('Priya Shah, Revenue operations');
    await press(confirmed, 'Add a relationship with Priya Shah');
    await press(confirmed, 'Add');
    expect(backend.calls.at(-1)).toEqual({
      name: 'people:addRelationship',
      args: { personId: 'person-priya', agentId: 'agent-1', type: 'collaborator' },
    });
  });

  it('says when older people are left out past the read bound (W13-R23)', () => {
    settled({ 'people:forEmployee': { ...GRAPH, more: true } });
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(section(view.container, 'Proposed').textContent).toContain(
      'Showing the 500 most recently added proposals; decide some and the rest appear.',
    );
  });

  it('names the address a Same person would bring before it is pressed (W13-R24)', () => {
    const [dana, sara, priya] = GRAPH.proposals;
    settled({
      'people:forEmployee': {
        ...GRAPH,
        proposals: [
          dana,
          sara,
          { ...priya, possiblySameAs: { ...priya.possiblySameAs, bringsAddress: 'ceo@acme.test' } },
        ],
      },
    });
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(section(view.container, 'Proposed').textContent).toContain(
      'Same person would also give Priya Shah the address ceo@acme.test.',
    );
  });

  it("offers a source's proposed change on a confirmed person with Take and Dismiss, and says a failed lookup (W13-R3, W13-R25)", async () => {
    const [priya] = GRAPH.confirmed;
    settled({
      'people:forEmployee': {
        ...GRAPH,
        confirmed: [
          {
            ...priya,
            proposedChange: {
              title: 'Head of revenue operations',
              primaryEmail: 'priya.shah@kestrel.test',
              quote: 'Priya Shah, Head of revenue operations, priya.shah@kestrel.test',
              where: 'Team directory',
              at: Date.UTC(2026, 9, 6, 2, 0),
            },
            lookupFailedAt: Date.UTC(2026, 9, 6, 3, 0),
          },
        ],
      },
    });
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    const confirmed = section(view.container, 'Confirmed');
    expect(confirmed.textContent).toContain('Proposed changeTeam directory proposes a change');
    expect(confirmed.textContent).toContain(
      // W14-R18: a change that names an address says what Take does with it.
      'Team directory proposes a change: title “Head of revenue operations”, address priya.shah@kestrel.test. What you confirmed stays until you take it. Take looks the new address up in Slack and Linear, and drops the accounts Day0 found by the old one.',
    );
    expect(confirmed.textContent).toContain(
      'Evidence: “Priya Shah, Head of revenue operations, priya.shah@kestrel.test” (Team directory, 6 Oct 2026, 02:00).',
    );
    expect(confirmed.textContent).toContain(
      'Day0 could not look Priya Shah up in Slack or Linear on 6 Oct 2026, 03:00, so a message or ticket from them may show an id instead of their name. If it stays so, check those connections on the Surfaces tab.',
    );
    await press(confirmed, 'Take the proposed change for Priya Shah');
    expect(backend.calls.at(-1)).toEqual({
      name: 'personChanges:take',
      args: { personId: 'person-priya', agentId: 'agent-1' },
    });
    expect(said(confirmed)).toEqual(['Took the proposed change for Priya Shah.']);
    await press(confirmed, 'Dismiss the proposed change for Priya Shah');
    expect(backend.calls.at(-1)?.name).toBe('personChanges:dismiss');
    expect(said(confirmed)).toEqual(['Dismissed the proposed change for Priya Shah.']);
    expect(await axeViolations(view.container)).toEqual([]);
  });

  it('says so while the graph is read, when nobody waits, and in mock mode, with no button to press', () => {
    settled({ 'people:forEmployee': undefined });
    const reading = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(section(reading.container, 'Proposed').textContent).toContain('Reading your people.');
    unmountAll();
    settled({ 'people:forEmployee': { proposals: [], confirmed: [] } });
    const empty = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(section(empty.container, 'Proposed').textContent).toContain(
      'No one to confirm. Mira proposes people after its charter is approved and when your documentation changes.',
    );
    expect(section(empty.container, 'Confirmed').textContent).toContain(
      'No one confirmed works with Mira yet.',
    );
    expect(buttonNames(section(empty.container, 'Proposed'))).toEqual([]);
    unmountAll();
    const mock = mount(asEmployee(<PeopleView />));
    expect(mock.container.textContent).not.toContain('Confirmed');
    expect(backend.calls).toEqual([]);
  });

  it('reads the aside in the drafted words, never identities', () => {
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    expect(html).toContain(
      'Names and roles, at most eight lines, regenerated when the graph changes. Never identities or credentials.',
    );
  });

  it('passes axe with every target 44 px tall in every state of the graph, the edge form open', async () => {
    const states: Array<unknown> = [undefined, { proposals: [], confirmed: [] }, GRAPH];
    for (const graph of states) {
      settled({ 'people:forEmployee': graph });
      const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
      expect(await axeViolations(view.container)).toEqual([]);
      expect(underTarget(view.container)).toEqual([]);
      unmountAll();
    }
    settled({ 'people:forEmployee': GRAPH });
    const view = mount(asEmployee(<PeopleView />, { surfaceMode: 'real' }));
    await press(view.container, 'Add a relationship with Priya Shah');
    expect(await axeViolations(view.container)).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
  });
});

/** The fixture employee's row, for a test that changes one field of it. */
function asEmployeeAgent(): Doc<'agents'> {
  return EMPLOYEE_ROW;
}
