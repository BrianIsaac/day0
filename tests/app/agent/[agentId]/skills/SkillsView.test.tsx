import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
});
