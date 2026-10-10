/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({
  results: {} as Record<string, unknown>,
  refusals: {} as Record<string, string>,
  calls: [] as Array<{ name: string; args: unknown }>,
}));

vi.mock('convex/react', () => ({
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

import {
  ChangesRequest,
  SENT_BACK,
} from '../../../../../app/agent/[agentId]/charter/ChangesRequest';
import { button, mount, press, said, typeInto } from '../../../../fixtures/dom/press';

const draft = {
  _id: 'charter-1',
  _creationTime: 1,
  agentId: 'agent-1',
  version: '0.0',
  approved: false,
  createdAt: 1,
  body: {},
} as unknown as Doc<'charters'>;

afterEach((): void => {
  backend.results = {};
  backend.refusals = {};
  backend.calls = [];
});

describe('asking the employee for changes (round two section 3.5)', (): void => {
  it('sends the draft back with the reason, says the employee redrafts, and tells the page which draft went', async (): Promise<void> => {
    backend.results = { 'charters:requestChanges': { ok: true, redrafting: true } };
    const page: Array<[string, { redrafting: boolean }]> = [];
    const view = mount(
      <ChangesRequest
        charter={draft}
        name="Mira"
        hasTranscript
        onSentBack={(id, outcome) => page.push([id, outcome])}
      />,
    );
    // W14-R56: the card scrolls the form to the top, where the sticky header would cover its
    // heading without the same margin the amend panel has.
    expect(view.container.querySelector('form')?.className).toContain('scroll-mt-24');
    expect(view.container.textContent).toContain(
      'Mira redrafts from your transcript and this note. Nothing you said is thrown away.',
    );
    expect(view.container.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled).toBe(
      true,
    );
    typeInto(
      view.container.querySelector('textarea')!,
      '  The 30-day goal should name the committee deck. ',
    );
    expect(button(view.container, 'Send and redraft').className).toMatch(/\bmin-h-11\b/);
    await press(view.container, 'Send and redraft');

    expect(backend.calls).toEqual([
      {
        name: 'charters:requestChanges',
        args: { charterId: 'charter-1', reason: 'The 30-day goal should name the committee deck.' },
      },
    ]);
    expect(said(view.container)).toEqual([
      'Sent back: Mira is redrafting from your one-to-one and your note.',
    ]);
    expect(page).toEqual([['charter-1', { redrafting: true }]]);
    view.unmount();
  });

  it('says the draft is withdrawn and tells the page which draft went', async (): Promise<void> => {
    backend.results = { 'charters:requestChanges': { ok: true, redrafting: false } };
    const page: Array<[string, { redrafting: boolean }]> = [];
    const view = mount(
      <ChangesRequest
        charter={draft}
        name="Mira"
        hasTranscript={false}
        onSentBack={(id, outcome) => page.push([id, outcome])}
      />,
    );
    expect(view.container.textContent).toContain('No transcript was kept for this draft');
    await press(view.container, 'Send back');
    expect(backend.calls.map((entry) => entry.name)).toEqual(['charters:requestChanges']);
    expect(said(view.container)).toEqual([SENT_BACK]);
    expect(SENT_BACK).toBe('Charter sent back: this draft is withdrawn.');
    expect(page).toEqual([['charter-1', { redrafting: false }]]);
    view.unmount();
  });

  it("says the backend's refusal in its own words and keeps the draft's page", async (): Promise<void> => {
    backend.refusals = {
      'charters:requestChanges': `[CONVEX M(charters:requestChanges)] [Request ID: 1] Server Error\nUncaught Error: Only the latest draft can be sent back.\n    at handler (../convex/charters.ts:1:1)`,
    };
    const page: Array<[string, { redrafting: boolean }]> = [];
    const view = mount(
      <ChangesRequest
        charter={draft}
        name="Mira"
        hasTranscript
        onSentBack={(id, outcome) => page.push([id, outcome])}
      />,
    );
    typeInto(view.container.querySelector('textarea')!, 'Name the deck.');
    await press(view.container, 'Send and redraft');
    expect(said(view.container)).toEqual(['Only the latest draft can be sent back.']);
    expect(page).toEqual([]);
    view.unmount();
  });
});
