/** @vitest-environment jsdom */

import { createRef } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { DayZero, ModePicker } from '../../../../app/agent/[agentId]/DayZero';
import { EMPLOYEE_ROW, asEmployee } from '../../../fixtures/dom/employee';
import { button, mount, press, settle } from '../../../fixtures/dom/press';

afterEach((): void => {
  backend.queries = {};
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

/** The voice probe answering that voice is, or is not, configured. */
function probe(configured: boolean): void {
  vi.stubGlobal(
    'fetch',
    async (): Promise<Response> => new Response(JSON.stringify({ configured })),
  );
}

describe('ModePicker', () => {
  it('asks in the first person and offers Voice first where it is configured', async () => {
    probe(true);
    const picked: string[] = [];
    const view = mount(<ModePicker onPick={(mode) => picked.push(mode)} />);
    await settle();
    expect(view.container.textContent).toContain(
      "I'd like a few minutes to understand the role you brought me on for.",
    );
    expect(button(view.container, 'Voice').className).toContain('bg-[var(--color-accent)]');
    await press(view.container, 'Chat');
    expect(picked).toEqual(['chat']);
    view.unmount();
  });

  it('greys Voice out and says why when the deployment has no voice, Chat taking the lead', async () => {
    probe(false);
    const view = mount(<ModePicker onPick={() => undefined} />);
    await settle();
    const voice = [...view.container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'Voice',
    );
    expect(voice?.disabled).toBe(true);
    expect(button(view.container, 'Chat').className).toContain('bg-[var(--color-accent)]');
    expect(view.container.textContent).toContain('Voice is off on this deployment');
    view.unmount();
  });
});

describe('DayZero', () => {
  it('sets the one-to-one beside what the employee knows so far and the first lines of its record', async () => {
    probe(true);
    backend.queries = {
      'skills:registered': [{ _id: 's1', name: 'read-docs' }],
      'workspace:read': { 'AGENTS.md': 'x'.repeat(1_500), 'SOUL.md': '' },
      'events:recent': [
        {
          _id: 'e1',
          _creationTime: 1,
          agentId: 'agent-1',
          type: 'agent.deployed',
          payload: {},
          createdAt: Date.UTC(2026, 8, 29, 9, 2),
        },
      ],
    };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'deployed' },
        charter: null,
        surfaceMode: 'mock',
      }),
    );
    await settle();
    const region = view.container.querySelector('[role="region"]');
    expect(region?.getAttribute('aria-label')).toBe('The 1:1 that drafts the charter');
    expect(view.container.textContent).toContain('What Mira knows so far');
    expect(view.container.textContent).toContain('boss@day0.local');
    expect(view.container.textContent).toContain('the hosted mock office');
    expect(
      [...view.container.querySelectorAll('a')]
        .find((link) => link.textContent?.includes('hosted mock office'))
        ?.getAttribute('href'),
    ).toBe('/agent/agent-1/surfaces');
    expect(view.container.textContent).toContain('read-docs');
    expect(view.container.textContent).toContain('1 of 2 written, 1.5 kB');
    expect(view.container.querySelectorAll('li')).toHaveLength(1);
    view.unmount();
  });

  it('goes back into the room a reload left, once the session says which', async () => {
    probe(true);
    backend.queries = { 'voice:latest': { mode: 'chat' } };
    const view = mount(
      asEmployee(<DayZero onboarding={createRef<HTMLDivElement>()} arriving={false} />, {
        agent: { ...EMPLOYEE_ROW, state: 'day-one-in-progress' },
        charter: null,
      }),
    );
    await settle();
    expect(view.container.textContent).not.toContain('voice or chat?');
    view.unmount();
  });
});
