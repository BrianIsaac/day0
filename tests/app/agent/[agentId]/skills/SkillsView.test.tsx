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
});
