/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName, type FunctionReference } from 'convex/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The new manager's acceptance dialog on the home (the transfer plan, section 7.3), over a
 * preview shaped as `transferAcceptance.transferPreview` answers it. The seams are the Convex
 * hooks, by function name, and the router, whose search names the request.
 */
const backend = vi.hoisted(() => ({
  /** The preview's read: a value, undefined while it loads, or the error it was refused with. */
  preview: undefined as unknown,
  /** Mutations that reject, by function name, with the words of the `ConvexError` they throw. */
  refusals: {} as Record<string, string>,
  calls: [] as Array<{ name: string; args: unknown }>,
  asked: [] as Array<{ name: string; args: unknown }>,
  /** When set, the acceptance answers only once the test calls it, as a slow round trip does. */
  hold: undefined as undefined | Promise<void>,
  /** Every queries object handed to `useQueries`, in render order. */
  subscriptions: [] as unknown[],
}));

vi.mock('convex/react', () => ({
  useQueries: (queries: Record<string, { query: FunctionReference<'query'>; args: unknown }>) => {
    backend.subscriptions.push(queries);
    return Object.fromEntries(
      Object.entries(queries).map(([key, { query, args }]) => {
        backend.asked.push({ name: getFunctionName(query), args });
        // The live client hands a new object on every render, as a fresh decode does.
        const answer = backend.preview;
        const fresh =
          typeof answer === 'object' && answer !== null && !(answer instanceof Error)
            ? structuredClone(answer)
            : answer;
        return [key, fresh];
      }),
    );
  },
  useMutation:
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) {
        const { ConvexError } = await import('convex/values');
        throw new ConvexError(refusal);
      }
      if (backend.hold !== undefined) await backend.hold;
      return name === 'transferAcceptance:accept' ? { agentId: 'agent-maya' } : null;
    },
}));

const route = vi.hoisted(() => ({ search: '', replaced: [] as string[] }));

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    replace: (href: string): void => {
      route.replaced.push(href);
    },
  }),
  usePathname: (): string => '/',
  useSearchParams: (): URLSearchParams => new URLSearchParams(route.search),
}));

import { ConvexError } from 'convex/values';
import { AcceptTransfer, acceptanceSections } from '../../../app/home/AcceptTransfer';
import type { HandoverPreview } from '../../../app/handover-words';
import { axeViolations } from '../../fixtures/dom/axe';
import {
  focusedName,
  mount,
  press,
  said,
  settle,
  typeInto,
  unmountAll,
} from '../../fixtures/dom/press';
import { underTarget } from '../../fixtures/dom/targets';

/** Maya, handed by sam@kestrel.example to the signed-in manager, in real mode. */
const PREVIEW: HandoverPreview = {
  transferId: 'transfer-1' as HandoverPreview['transferId'],
  mode: 'real',
  employee: {
    agentId: 'agent-maya' as HandoverPreview['employee']['agentId'],
    name: 'Maya',
    state: 'active',
    roleLine: 'owns triage for tier-2 asks',
  },
  fromAddress: 'sam@kestrel.example',
  note: 'She is mid-way through the September close.',
  requestedAt: Date.UTC(2026, 9, 1, 9),
  expiresAt: Date.UTC(2026, 9, 15, 9),
  takesOn: {
    waiting: {
      'one-to-one': 0,
      charter: 0,
      plan: 1,
      held: 0,
      skill: 0,
      parked: 0,
      stopped: 0,
      surface: 0,
    },
    openWork: 3,
    openWorkAtLeast: false,
    registeredSkills: 2,
    charter: { version: '0.2', approved: true },
    scopes: [{ scope: 'docs:read' }],
    recordLength: 41,
    recordAtLeast: false,
  },
  leavesBehind: {
    surfaces: [{ slug: 'linear', displayName: 'Linear' }],
    scopesRevoked: ['linear:read'],
    mirroredPages: 12,
    mirroredPagesAtLeast: false,
    autonomousActions: false,
  },
  reportingLines: ['Report blockers to Sam in #revops.'],
  documentation: [
    { sourceId: 'source-handbook' as never, label: 'Handbook' },
    { sourceId: 'source-wiki' as never, label: 'Wiki' },
  ],
  runsInFlight: 0,
};

/** The dialog open on the page. */
function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="dialog"]');
  if (!found) throw new Error('no dialog');
  return found;
}

/** The dialog's heading. */
function title(): string {
  return document.getElementById(dialog().getAttribute('aria-labelledby') ?? '')?.textContent ?? '';
}

/** Each section of the account: its term, then its lines. */
function sections(): string[][] {
  return [...dialog().querySelectorAll('dt')].map((term) => [
    term.textContent ?? '',
    ...[...(term.nextElementSibling?.querySelectorAll('li') ?? [])].map(
      (line) => line.textContent ?? '',
    ),
  ]);
}

/** Press a key on whatever holds focus. */
function key(name: string, shiftKey = false): void {
  act((): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }),
    );
  });
}

describe('AcceptTransfer', () => {
  beforeEach(() => {
    route.search = '?transfer=transfer-1';
  });

  afterEach(() => {
    unmountAll();
    backend.preview = undefined;
    backend.refusals = {};
    backend.calls = [];
    backend.asked = [];
    backend.hold = undefined;
    backend.subscriptions = [];
    route.search = '';
    route.replaced = [];
  });

  it('draws only its empty status line and reads nothing without a request in the address', () => {
    route.search = '';
    const view = mount(<AcceptTransfer />);
    const regions = view.container.querySelectorAll('[role="status"]');
    expect(regions).toHaveLength(1);
    expect(regions[0]?.textContent).toBe('');
    expect(view.container.textContent).toBe('');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(backend.asked).toEqual([]);
  });

  it('says it is reading while the preview loads, for the request the address names', () => {
    mount(<AcceptTransfer />);
    expect(title()).toBe('Handover');
    expect(said(dialog())).toEqual(['Reading what comes with this handover']);
    expect(backend.asked).toContainEqual({
      name: 'transferAcceptance:transferPreview',
      args: { transferId: 'transfer-1' },
    });
  });

  it('hands useQueries one queries object across renders, which it subscribes by identity', () => {
    backend.preview = PREVIEW;
    const view = mount(<AcceptTransfer />);
    act((): void => view.root.render(<AcceptTransfer />));
    act((): void => view.root.render(<AcceptTransfer />));
    expect(backend.subscriptions.length).toBeGreaterThan(1);
    expect(new Set(backend.subscriptions).size).toBe(1);
  });

  it('says a refused read in the backend’s words, and closes by taking the request off the address', async () => {
    backend.preview = new ConvexError('This handover is addressed to someone else.');
    mount(<AcceptTransfer />);
    expect(dialog().textContent).toContain('This handover is addressed to someone else.');
    await press(dialog(), 'Close');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(route.replaced).toEqual(['/']);
  });

  it('says a read refused without words in its own, never the transport’s envelope', () => {
    backend.preview = new Error(
      '[CONVEX Q(transferAcceptance:transferPreview)] [Request ID: 1] Server Error',
    );
    mount(<AcceptTransfer />);
    expect(dialog().textContent).toContain('This handover could not be read.');
    expect(dialog().textContent).not.toContain('CONVEX');
  });

  it('says a request that no longer waits for an answer', () => {
    backend.preview = null;
    mount(<AcceptTransfer />);
    expect(dialog().textContent).toContain(
      'This handover is no longer waiting for an answer: it was answered or cancelled, or it expired.',
    );
  });

  it('says who asks, the note, what comes and what does not, and the line to check (plan 7.3)', () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    expect(title()).toBe('Take on Maya?');
    const description = document.getElementById(dialog().getAttribute('aria-describedby') ?? '');
    expect(description?.textContent).toBe(
      'sam@kestrel.example manages Maya today and asks you to take over. Maya: owns triage for tier-2 asks.',
    );
    expect(dialog().querySelector('blockquote')?.textContent).toBe(
      '“She is mid-way through the September close.”',
    );
    expect(sections()).toEqual([
      [
        'You take on',
        '3 items in progress',
        '2 skills',
        'charter version 0.2, approved',
        'permissions: docs:read',
        'its record: 41 events, decisions included, as they were made',
      ],
      [
        'Does not come with it',
        'Linear: you approve and connect it with your own credentials',
        "12 pages of sam@kestrel.example's documentation it stops reading",
        'autonomous actions: off until you turn them on',
      ],
      [
        'Check',
        '“Report blockers to Sam in #revops.”',
        'Amend the charter after you take Maya on if this no longer holds.',
      ],
    ]);
    expect(dialog().querySelector('legend')?.textContent).toBe('Reads for it');
    expect(
      [...dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].map(
        (tick) => tick.checked,
      ),
    ).toEqual([true, true]);
    expect(dialog().textContent).not.toContain('is finishing');
    expect(dialog().textContent).not.toMatch(/\bagent\b/i);
    expect([...dialog().querySelectorAll('button')].map((button) => button.textContent)).toEqual([
      'Decline',
      'Take on Maya',
    ]);
  });

  it('leaves the check out when the charter states no reporting line, and says when none of the acceptor’s documentation is linked', () => {
    backend.preview = { ...PREVIEW, reportingLines: [], documentation: [] };
    mount(<AcceptTransfer />);
    expect(sections().map(([term]) => term)).toEqual(['You take on', 'Does not come with it']);
    expect(dialog().textContent).toContain(
      'You have linked no documentation, so it reads none of yours yet.',
    );
  });

  it('says the runs the move waits for and the fifteen minutes (D18)', () => {
    backend.preview = { ...PREVIEW, runsInFlight: 2 };
    mount(<AcceptTransfer />);
    expect(dialog().textContent).toContain(
      'Maya is finishing 2 runs for sam@kestrel.example. It becomes yours when they end, within 15 minutes.',
    );
  });

  it('opens on the account, not on a control below it, and keeps Tab inside', () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    expect(document.activeElement?.tagName).toBe('DIV');
    expect(dialog().contains(document.activeElement)).toBe(true);
    key('Tab', true);
    expect(focusedName()).toBe('Take on Maya');
    key('Tab');
    expect(document.activeElement).toBe(dialog().querySelector('input[type="checkbox"]'));
  });

  it('takes the employee on with the acceptor’s zone and unticked sources, then says so on the home with focus', async () => {
    backend.preview = PREVIEW;
    const view = mount(<AcceptTransfer />);
    const wiki = dialog().querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1];
    await act(async (): Promise<void> => {
      wiki?.click();
    });
    await press(dialog(), 'Take on Maya');

    expect(backend.calls).toEqual([
      {
        name: 'transferAcceptance:accept',
        args: { transferId: 'transfer-1', zone: 'UTC', excludedDocSourceIds: ['source-wiki'] },
      },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(route.replaced).toEqual(['/']);
    expect(said(view.container)).toEqual(['Maya is yours.']);
    expect(document.activeElement?.textContent).toBe('Maya is yours.');
  });

  it('sends no source list when every source stays ticked', async () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    await press(dialog(), 'Take on Maya');
    expect(backend.calls).toEqual([
      { name: 'transferAcceptance:accept', args: { transferId: 'transfer-1', zone: 'UTC' } },
    ]);
  });

  it('says the employee is finishing its runs when it was accepted with runs in flight', async () => {
    backend.preview = { ...PREVIEW, runsInFlight: 1 };
    const view = mount(<AcceptTransfer />);
    await press(dialog(), 'Take on Maya');
    expect(said(view.container)).toEqual([
      'Accepted. Maya is finishing 1 run; it becomes yours when it ends.',
    ]);
  });

  it('keeps the dialog open on a refusal, says it there and nothing on the home', async () => {
    backend.preview = PREVIEW;
    backend.refusals = {
      'transferAcceptance:accept': 'This handover expired before it was accepted.',
    };
    const view = mount(<AcceptTransfer />);
    await press(dialog(), 'Take on Maya');
    expect(said(dialog())).toEqual(['This handover expired before it was accepted.']);
    expect(said(view.container)).toEqual([]);
    expect(focusedName()).toBe('Take on Maya');
    await press(dialog(), 'Decline');
    expect(said(dialog())).toEqual([]);
  });

  it('declines through a short reason it asks for first, then says so on the home', async () => {
    backend.preview = PREVIEW;
    const view = mount(<AcceptTransfer />);
    await press(dialog(), 'Decline');
    const reason = dialog().querySelector('textarea');
    if (!reason) throw new Error('no reason field');
    expect(document.activeElement).toBe(reason);
    expect(dialog().querySelector(`label[for="${reason.id}"]`)?.textContent).toBe(
      'Tell sam@kestrel.example why (optional)',
    );
    typeInto(reason, ' Not my team. ');
    await press(dialog(), 'Decline');

    expect(backend.calls).toEqual([
      {
        name: 'managerTransfers:decline',
        args: { transferId: 'transfer-1', reason: 'Not my team.' },
      },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual([
      "You declined to take Maya on. sam@kestrel.example sees it on Maya's People tab.",
    ]);
  });

  it('declines without a reason when none is written', async () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    await press(dialog(), 'Decline');
    await press(dialog(), 'Decline');
    expect(backend.calls).toEqual([
      { name: 'managerTransfers:decline', args: { transferId: 'transfer-1' } },
    ]);
  });

  it('reveals the reason with one button and sends the decline with another, so the first click sends nothing', async () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    const reveal = [...dialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Decline',
    );
    expect(reveal?.getAttribute('type')).toBe('button');
    await press(dialog(), 'Decline');
    const send = [...dialog().querySelectorAll('button')].find(
      (button) => button.textContent === 'Decline',
    );
    expect(send).not.toBe(reveal);
    expect(send?.getAttribute('type')).toBe('submit');
    expect(reveal?.isConnected).toBe(false);
    expect(backend.calls).toEqual([]);
  });

  it('keeps the employee drawn while the acceptance is in flight, though the request has left asked', async () => {
    backend.preview = PREVIEW;
    let release: () => void = () => undefined;
    backend.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const view = mount(<AcceptTransfer />);
    await press(dialog(), 'Take on Maya');
    // The request left `asked` before the acceptance's own answer arrived.
    backend.preview = null;
    act((): void => view.root.render(<AcceptTransfer />));
    expect(title()).toBe('Take on Maya?');
    expect(dialog().textContent).not.toContain('no longer waiting');
    expect(focusedName()).not.toBe('Close');
    await act(async (): Promise<void> => {
      release();
    });
    await settle();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual(['Maya is yours.']);
  });

  it('opens another request without the refusal said for the last one', async () => {
    backend.preview = PREVIEW;
    backend.refusals = {
      'transferAcceptance:accept': 'This handover expired before it was accepted.',
    };
    const view = mount(<AcceptTransfer />);
    await press(dialog(), 'Take on Maya');
    expect(said(dialog())).toEqual(['This handover expired before it was accepted.']);
    // The browser's Back, to another request's link.
    route.search = '?transfer=transfer-2';
    act((): void => view.root.render(<AcceptTransfer />));
    await settle();
    expect(said(dialog())).toEqual([]);
  });

  it('closes on Escape, deciding nothing', () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    key('Escape');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(backend.calls).toEqual([]);
    expect(route.replaced).toEqual(['/']);
  });

  it('passes axe and keeps every control at 44 px, before and while declining (14.1 item 10)', async () => {
    backend.preview = PREVIEW;
    mount(<AcceptTransfer />);
    expect(await axeViolations(dialog())).toEqual([]);
    expect(underTarget(dialog())).toEqual([]);
    await press(dialog(), 'Decline');
    expect(await axeViolations(dialog())).toEqual([]);
    expect(underTarget(dialog())).toEqual([]);
  });
});

describe('acceptanceSections', () => {
  it('quotes each reporting line and asks the acceptor to amend the charter if it no longer holds', () => {
    const check = acceptanceSections({
      ...PREVIEW,
      reportingLines: ['Report to Sam.', 'Copy Ana on escalations.'],
    }).find((section) => section.term === 'Check');
    expect(check?.lines).toEqual([
      '“Report to Sam.”',
      '“Copy Ana on escalations.”',
      'Amend the charter after you take Maya on if this no longer holds.',
    ]);
  });
});
