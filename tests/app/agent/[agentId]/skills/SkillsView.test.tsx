/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../../convex/_generated/dataModel';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { SkillsView } from '../../../../../app/agent/[agentId]/skills/SkillsView';
import { asEmployee, EMPLOYEE_ROW } from '../../../../fixtures/dom/employee';
import { mount } from '../../../../fixtures/dom/press';

afterEach((): void => {
  backend.queries = {};
});

describe('SkillsView', () => {
  it("lands a work card's link on the failed skill's row, in view and focused, once the lists answer (D3)", () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skills:awaitingVerification': [],
      'skillControls:notYetWritten': [],
      'skills:verificationFailed': [
        {
          _id: 'skill-9',
          name: 'kanban-comment-and-close',
          state: 'failed',
          body: '',
          description: 'Close a ticket.',
          authoringAttempts: 1,
          verificationLog: 'smoke test failed',
        },
      ],
    };
    window.location.hash = '#skill-skill-9';
    const scrolled: string[] = [];
    const scrollIntoView = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element): void {
      scrolled.push(this.id);
    };
    try {
      const view = mount(asEmployee(<SkillsView />));
      expect(scrolled).toEqual(['skill-skill-9']);
      expect(document.activeElement?.id).toBe('skill-skill-9');
      view.unmount();
    } finally {
      Element.prototype.scrollIntoView = scrollIntoView;
      window.location.hash = '';
    }
  });

  it('draws the tab when the fragment is not one it wrote, a malformed escape included', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skills:awaitingVerification': [],
      'skillControls:notYetWritten': [],
      'skills:verificationFailed': [],
    };
    window.location.hash = '#skill-%E0%A4%A';
    try {
      const view = mount(asEmployee(<SkillsView />));
      expect(view.container.textContent).toContain('How a skill is made');
      view.unmount();
    } finally {
      window.location.hash = '';
    }
  });

  it('sets the proposed and the registered skills beside how a skill is made, as drawn', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [
        { _id: 's1', name: 'read-docs', state: 'registered', body: '', description: 'Read.' },
      ],
    };
    const html = renderToStaticMarkup(asEmployee(<SkillsView />));
    expect(html).toContain('read-docs');
    expect(html).toContain('>How a skill is made</h2>');
    expect(html).not.toContain('>So far</h2>');
  });

  it('says the last authoring run did not finish from the attempt the shell holds, so it outlives the tab (A D11, E D9)', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skills:get': { _id: 'skill-1', name: 'refresh-the-tile', state: 'approved' },
    };
    const html = renderToStaticMarkup(
      asEmployee(<SkillsView />, {
        lastAttempt: {
          skillId: 'skill-1' as Id<'skills'>,
          name: 'refresh-the-tile',
          reason: 'The sandbox component is not running.',
        },
      }),
    );
    expect(html).toContain(
      'Authoring did not finish: refresh-the-tile: The sandbox component is not running.',
    );
  });

  it('says an authoring a pause held is held, not that it did not finish (D-8 (b), wave 13 item 6)', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skills:get': { _id: 'skill-1', name: 'refresh-the-tile', state: 'approved' },
    };
    const html = renderToStaticMarkup(
      asEmployee(<SkillsView />, {
        lastAttempt: {
          skillId: 'skill-1' as Id<'skills'>,
          name: 'refresh-the-tile',
          reason: 'held while Priya is paused: writing it starts when you resume Priya',
          held: true,
        },
      }),
    );
    expect(html).toContain(
      'refresh-the-tile is held while Priya is paused: writing it starts when you resume Priya.',
    );
    expect(html).not.toContain('Authoring did not finish');
  });

  it('hides the last verdict once its skill was retired or replaced by its revision (10-C)', () => {
    for (const state of ['retired', 'superseded'] as const) {
      backend.queries = {
        'skills:proposed': [],
        'skills:registered': [],
        'skills:get': { _id: 'skill-1', name: 'refresh-the-tile', state },
      };
      const html = renderToStaticMarkup(
        asEmployee(<SkillsView />, {
          lastAttempt: {
            skillId: 'skill-1' as Id<'skills'>,
            name: 'refresh-the-tile',
            reason: 'The sandbox component is not running.',
          },
        }),
      );
      expect(html).not.toContain('Authoring did not finish');
    }
  });

  it('lists a revision not yet being written with the skills not callable, beside the version it revises (10-C)', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [
        {
          _id: 's1',
          name: 'kanban-comment-and-close',
          state: 'registered',
          sourceType: 'agent-authored',
          body: '',
          description: 'Close.',
        },
      ],
      'skillControls:notYetWritten': [
        {
          _id: 's2',
          name: 'kanban-comment-and-close',
          state: 'approved',
          sourceType: 'agent-authored',
          body: '',
          description: 'Close.',
          revisionOf: 's1',
        },
      ],
    };
    const html = renderToStaticMarkup(asEmployee(<SkillsView />));
    expect(html).toContain('>Not callable</h2>');
    expect(html).toContain('keeps running this version until the new one registers.');
  });
  it('lists a skill whose authoring a pause holds as held, saying when it starts, after the page is opened again (D-8 (b))', () => {
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skillControls:notYetWritten': [
        {
          _id: 's3',
          name: 'chat-thread-reply',
          state: 'approved',
          sourceType: 'agent-authored',
          body: '',
          description: 'Threaded reply.',
        },
      ],
    };
    const html = renderToStaticMarkup(
      asEmployee(<SkillsView />, {
        surfaceMode: 'real',
        agent: { ...EMPLOYEE_ROW, pausedAt: 5 },
      }),
    ).replace(/<!-- -->/g, '');
    expect(html).toContain('>Not callable</h2>');
    expect(html).toContain('>Held<');
    expect(html).toContain('Held while Mira is paused: writing it starts when you resume Mira.');
    // Nothing stopped and a press would only be held again: the row offers no Retry and no hint.
    expect(html).not.toContain('Retry chat-thread-reply');
    expect(html).not.toContain('with the reason it stopped');
  });

  it('leaves an adoption in flight, stopped short or failed to the adoption card, so Not callable offers no Retry on it (the wave 10 review, M3 and B1)', () => {
    const adoption = (id: string, state: string): Record<string, unknown> => ({
      _id: id,
      name: `adopted-${state}`,
      state,
      sourceType: 'agent-authored',
      body: '',
      description: 'Close.',
      offeredVersionId: 'version-1',
      authoringAttempts: 1,
      verificationLog: 'the stored skill was not verified: no sandbox; Retry runs its check',
    });
    backend.queries = {
      'skills:proposed': [],
      'skills:registered': [],
      'skills:awaitingVerification': [adoption('s1', 'authoring')],
      'skills:verificationFailed': [
        adoption('s2', 'failed'),
        {
          _id: 's3',
          name: 'own-draft',
          state: 'failed',
          sourceType: 'agent-authored',
          body: '',
          description: 'Its own.',
          authoringAttempts: 1,
          verificationLog: 'smoke.py exited 1',
        },
      ],
    };
    const html = renderToStaticMarkup(asEmployee(<SkillsView />));
    expect(html).toContain('own-draft');
    expect(html).not.toContain('adopted-authoring');
    expect(html).not.toContain('adopted-failed');
  });
});
