import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { CharterView } from '../../../../../app/agent/[agentId]/charter/CharterView';
import { APPROVED_CHARTER, asEmployee } from '../../../../fixtures/dom/employee';

describe('CharterView', () => {
  it('shows the charter card for the charter the page has', () => {
    const charter = {
      ...APPROVED_CHARTER,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction: 'Own routine revenue operations work.',
        shortTermGoals: { day30: 'a', day60: 'b', day90: 'c' },
        proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
        namedCollaborators: [],
        priorityReading: [],
        openQuestions: [],
      },
    };
    expect(renderToStaticMarkup(asEmployee(<CharterView />, { charter }))).toContain('Close week.');
  });

  it('says the one-to-one drafts it when there is none yet', () => {
    expect(renderToStaticMarkup(asEmployee(<CharterView />, { charter: null }))).toContain(
      'Mira has no charter yet: the Day-1 one-to-one drafts it.',
    );
  });
});
