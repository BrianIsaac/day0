/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import {
  RetireDialog,
  retireAlternative,
  retireLines,
  retirePhrase,
} from '../../../../../app/agent/[agentId]/manage/RetireDialog';
import type { RetirePreview } from '../../../../../app/agent/[agentId]/manage/retire-words';
import { EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import { focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  /** Mutations that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation resolves with, by function name. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
  useMutation:
    (reference: unknown) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    },
}));

/** A real-mode preview: Linear revoked, Slack kept for a colleague, one claim kept. */
const REAL_PREVIEW: RetirePreview = {
  mode: 'real',
  rowCounts: { charters: 2, workItems: 3, skills: 3, surfaces: 2, corrections: 1, events: 41 },
  atLeast: false,
  revoked: [{ slug: 'linear', displayName: 'Linear' }],
  kept: [{ slug: 'slack', displayName: 'Slack' }],
  keptClaims: 1,
  tombstone: true,
};

/** A held write and a plan waiting on the manager. */
const INBOX = {
  entries: [
    { kind: 'held', key: 'held-1', subject: 'REVOPS-7', heldWrites: 1 },
    { kind: 'plan', key: 'plan-1', subject: 'REVOPS-9', questions: 0 },
  ],
  total: 2,
};

/** The dialog open over a page with an opener, as the Manage tab opens it. */
function open(mode: RetirePreview['mode'] = 'real', agent: Doc<'agents'> = EMPLOYEE_ROW) {
  const outcome = { closed: 0, retired: [] as string[] };
  const view = mount(
    <RetireDialog
      agent={agent}
      mode={mode}
      onClose={() => {
        outcome.closed += 1;
      }}
      onRetired={(name) => outcome.retired.push(name)}
    />,
  );
  return { view, outcome };
}

/** The open dialog. */
function dialog(): HTMLElement {
  const found = document.querySelector<HTMLElement>('[role="alertdialog"]');
  if (!found) throw new Error('no retire dialog');
  return found;
}

/** The typed-confirmation field. */
function field(): HTMLInputElement {
  const found = dialog().querySelector('input');
  if (!found) throw new Error('no confirmation field');
  return found;
}

/** The dialog's Retire button, enabled or not. */
function retireButton(): HTMLButtonElement {
  const found = [...dialog().querySelectorAll('button')].find(
    (candidate) => candidate.textContent === 'Retire Mira',
  );
  if (!found) throw new Error('no Retire button');
  return found;
}

/** Press a key on whatever holds focus. */
function key(name: string, shiftKey = false): void {
  act((): void => {
    (document.activeElement ?? document.body).dispatchEvent(
      new KeyboardEvent('keydown', { key: name, shiftKey, bubbles: true }),
    );
  });
}

describe('RetireDialog: what retiring does, said before it is done (Q15, N1)', (): void => {
  afterEach((): void => {
    backend.queries = {};
    backend.refusals = {};
    backend.results = {};
    backend.calls = [];
  });

  it('opens on Keep, named for the employee, with the counts from the preview and what waits', (): void => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    const { view } = open();

    const heading = document.getElementById(dialog().getAttribute('aria-labelledby') ?? '');
    expect(heading?.textContent).toBe('Retire Mira?');
    expect(dialog().getAttribute('aria-modal')).toBe('true');
    expect(focusedName()).toBe('Keep Mira');
    const lines = [...dialog().querySelectorAll('dt')].map((term) => [
      term.textContent,
      ...[...(term.nextElementSibling?.children ?? [])].map((detail) => detail.textContent),
    ]);
    expect(lines).toEqual([
      [
        'Revoked',
        'The Linear credential, at once. A write reaching a system after this moment is refused.',
      ],
      [
        'Deleted',
        '2 charter versions, 3 work items, 3 skills, 2 connections, 1 correction and 41 events across 6 tables.',
      ],
      [
        'Kept',
        'One record under your account: the name, the rows each table lost and the date, so the audit export can say the employee existed.',
        'The Slack credential, which another employee or a documentation source still uses.',
        'The claim on the item it may already have written, so no colleague repeats the write.',
      ],
      ['Waiting on you', '1 held write and 1 plan, discarded undecided.'],
    ]);
    view.unmount();
  });

  it('keeps Tab inside the dialog, wrapping at both ends', (): void => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    const { view } = open();

    // Retire is disabled until the words match, so Keep is the last control.
    key('Tab');
    expect(document.activeElement).toBe(field());
    key('Tab', true);
    expect(focusedName()).toBe('Keep Mira');
    view.unmount();
  });

  it('closes on Escape and on Keep, retiring nothing', async (): Promise<void> => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    const { view, outcome } = open();

    key('Escape');
    await press(document.body, 'Keep Mira');

    expect(outcome.closed).toBe(2);
    expect(backend.calls).toEqual([]);
    view.unmount();
  });

  it('enables Retire only once the typed words match, then retires and hands the name on', async (): Promise<void> => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    backend.results = { 'reset:retire': { agentName: 'Mira' } };
    const { view, outcome } = open();

    expect(retireButton().disabled).toBe(true);
    typeInto(field(), 'retire Mir');
    expect(retireButton().disabled).toBe(true);
    typeInto(field(), ' Retire  mira ');
    expect(retireButton().disabled).toBe(false);
    await press(document.body, 'Retire Mira');

    expect(backend.calls).toEqual([{ name: 'reset:retire', args: { agentId: 'agent-1' } }]);
    expect(outcome.retired).toEqual(['Mira']);
    expect(said(document.body)).toContain('Mira is retired.');
    view.unmount();
  });

  it('says a refusal inside the dialog and leaves it open', async (): Promise<void> => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    backend.refusals = {
      'reset:retire':
        '[CONVEX M(reset:retire)] [Request ID: 1] Server Error\nUncaught Error: This employee holds 2001 items and 0 rejections, more than one retirement keeps (2000).\n    at handler (../convex/reset.ts:1:1)',
    };
    const { view, outcome } = open();

    typeInto(field(), retirePhrase('Mira'));
    await press(document.body, 'Retire Mira');

    expect(said(dialog())).toEqual([
      'This employee holds 2001 items and 0 rejections, more than one retirement keeps (2000).',
    ]);
    expect(outcome.retired).toEqual([]);
    expect(dialog().isConnected).toBe(true);
    view.unmount();
  });

  it('counts before it offers Retire, even when the words are typed', (): void => {
    const { view } = open();

    expect(dialog().textContent).toContain('Counting what retiring Mira would change');
    typeInto(field(), 'retire Mira');
    expect(retireButton().disabled).toBe(true);
    view.unmount();
  });

  it('offers supervision where a pause would be, since there is no pause', (): void => {
    backend.queries = { 'reset:retirePreview': REAL_PREVIEW, 'work:needsYouForAgent': INBOX };
    const { view } = open();

    expect(dialog().textContent).toContain(
      'Not sure? Keep Mira: with autonomous actions off, nothing but reads and the DM to you lands without your approval, and nothing is deleted.',
    );
    view.unmount();
    const autonomous = { ...EMPLOYEE_ROW, autonomousActions: true } as Doc<'agents'>;
    expect(retireAlternative(autonomous, 'real')).toBe(
      'Not sure? Keep Mira and turn autonomous actions off instead: nothing but reads and the DM to you lands without your approval, and nothing is deleted.',
    );
    expect(retireAlternative(EMPLOYEE_ROW, 'mock')).toBe(
      'Not sure? Keep Mira: in the hosted office nothing it does leaves the mock office, and every write waits for your decision.',
    );
  });

  it('in the hosted office promises no revoke and no record, only the wipe', (): void => {
    const mock: RetirePreview = {
      ...REAL_PREVIEW,
      mode: 'mock',
      revoked: [],
      kept: [],
      keptClaims: 0,
      tombstone: false,
    };
    expect(retireLines(mock, '')).toEqual([
      {
        term: 'Deleted',
        details: [
          '2 charter versions, 3 work items, 3 skills, 2 connections, 1 correction and 41 events across 6 tables.',
        ],
      },
      {
        term: 'Kept',
        details: ['Nothing: the hosted office keeps no record of a retired employee.'],
      },
      { term: 'Waiting on you', details: ['Nothing.'] },
    ]);
    backend.queries = { 'reset:retirePreview': mock, 'work:needsYouForAgent': INBOX };
    const { view } = open('mock');
    expect(dialog().textContent).toContain(
      'This removes Mira and everything it made in the hosted office. It cannot be undone.',
    );
    view.unmount();
  });

  it('says when no credential is bound only by the employee', (): void => {
    const lines = retireLines({ ...REAL_PREVIEW, revoked: [], kept: [], keptClaims: 0 }, '');
    expect(lines[0]).toEqual({
      term: 'Revoked',
      details: ['Nothing: no credential is bound only by this employee.'],
    });
    expect(lines[2]?.details).toEqual([
      'One record under your account: the name, the rows each table lost and the date, so the audit export can say the employee existed.',
    ]);
  });
});
