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
import { asEmployee } from '../../../../fixtures/dom/employee';

afterEach((): void => {
  backend.queries = {};
});

describe('SkillsView', () => {
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
      'skillControls:pendingRevisions': [
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
