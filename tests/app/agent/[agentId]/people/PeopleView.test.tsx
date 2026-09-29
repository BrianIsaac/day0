/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({
  queries: {} as Record<string, unknown>,
  /** Mutations that reject, by function name, with the text they reject with. */
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
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    },
  useAction: () => async (): Promise<void> => undefined,
}));

import {
  namedPeople,
  PeopleView,
  provenanceLine,
} from '../../../../../app/agent/[agentId]/people/PeopleView';
import { managerChangeLines } from '../../../../../app/agent/[agentId]/people/ChangeManager';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { APPROVED_CHARTER, asEmployee } from '../../../../fixtures/dom/employee';
import { focusedName, mount, press, said, typeInto } from '../../../../fixtures/dom/press';

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

describe('PeopleView', () => {
  afterEach(() => {
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

  it('names the manager and the people the charter names with a provenance line, and offers no control it cannot honour', () => {
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { charter }));
    expect(html).toContain('boss@day0.local');
    expect(html).toContain('Priya');
    expect(html).toContain(' · segment and pipeline · reaches out directly');
    expect(html).toContain('Named in charter version 0.1, approved by you.');
    // An amendment can add a person, so the line never claims the one-to-one named them.
    expect(html).not.toContain('From your one-to-one');
    expect(html).toContain('does not propose people for you to confirm yet');
    expect(html).not.toMatch(/<button[^>]*>(Confirm|Dismiss|A different person)/);
    expect(html).toMatch(/<button[^>]*>Change manager<\/button>/);
  });

  it('says the one-to-one asks who the employee works with when the charter names nobody', () => {
    expect(renderToStaticMarkup(asEmployee(<PeopleView />))).toContain(
      'The charter names nobody yet.',
    );
  });

  it('offers Change manager only once the mode is known, since what moves depends on it', () => {
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { surfaceMode: undefined }));
    expect(html).not.toContain('Change manager</button>');
  });

  it('changes the manager through a dialog that says what moves, then says so and gives focus back', async () => {
    backend.results = { 'agents:setBossEmail': { changed: true, reprobed: 1 } };
    const view = mount(asEmployee(<PeopleView />, { charter, surfaceMode: 'real' }));

    await press(view.container, 'Change manager');
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    if (!dialog) throw new Error('no dialog');
    expect(dialog.textContent).toContain(
      'Once a chat surface is connected, it looks the new manager up and sends decision requests to their DM.',
    );
    const field = dialog.querySelector('input');
    if (!field) throw new Error('no field');
    expect(document.activeElement).toBe(field);
    typeInto(field, ' lead@day0.local ');
    await press(document.body, 'Save');

    expect(backend.calls).toEqual([
      { name: 'agents:setBossEmail', args: { agentId: 'agent-1', bossEmail: 'lead@day0.local' } },
    ]);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual(['Mira now reports to lead@day0.local.']);
    expect(focusedName()).toBe('Change manager');
    view.unmount();
  });

  it('keeps the dialog open on a refusal and says it there', async () => {
    backend.refusals = {
      'agents:setBossEmail':
        '[CONVEX M(agents:setBossEmail)] [Request ID: 1] Server Error\nUncaught Error: The manager must be an email address, such as name@company.com.\n    at handler (../convex/agents.ts:1:1)',
    };
    const view = mount(asEmployee(<PeopleView />, { charter, surfaceMode: 'real' }));

    await press(view.container, 'Change manager');
    await press(document.body, 'Save');

    const dialog = document.querySelector<HTMLElement>('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(said(dialog as HTMLElement)).toEqual([
      'The manager must be an email address, such as name@company.com.',
    ]);
    expect(said(view.container)).toEqual([]);
    view.unmount();
  });

  it('says nothing beside the button once a refused change is cancelled (m38)', async () => {
    backend.refusals = {
      'agents:setBossEmail':
        '[CONVEX M(agents:setBossEmail)] [Request ID: 1] Server Error\nUncaught Error: The manager must be an email address, such as name@company.com.\n    at handler (../convex/agents.ts:1:1)',
    };
    const view = mount(asEmployee(<PeopleView />, { charter, surfaceMode: 'real' }));

    await press(view.container, 'Change manager');
    await press(document.body, 'Save');
    await press(document.body, 'Cancel');

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(said(view.container)).toEqual([]);
    view.unmount();
  });
});

describe('managerChangeLines', () => {
  it('says the DM moves and open requests are sent again once a chat surface found the manager', () => {
    expect(managerChangeLines('Mira', 'real', true)[0]).toBe(
      'The chat surface looks the new manager up at once; once it finds them, decision requests and the DMs about finished work go to their DM, and the decision requests still open are sent to it again.',
    );
  });

  it('says nothing is sent in the hosted office, and that the page stays with the account either way', () => {
    const lines = managerChangeLines('Mira', 'mock', false);
    expect(lines[0]).toBe(
      'In the hosted office the address is a name on the record: nothing is sent to it.',
    );
    expect(lines).toContain(
      'This page stays with your account: the address is who Mira reports to, not who signs in.',
    );
    expect(lines).toContain(
      'The record gains a manager change; decisions already made stay in it as they were.',
    );
  });
});
