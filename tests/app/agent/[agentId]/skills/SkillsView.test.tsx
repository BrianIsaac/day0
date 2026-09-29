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
});
