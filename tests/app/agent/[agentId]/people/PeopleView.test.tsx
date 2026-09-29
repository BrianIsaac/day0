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

import { namedPeople, PeopleView } from '../../../../../app/agent/[agentId]/people/PeopleView';
import { APPROVED_CHARTER, asEmployee } from '../../../../fixtures/dom/employee';

describe('namedPeople', () => {
  it('reads the people the charter names, and nobody from a body without the list', () => {
    expect(
      namedPeople({
        namedCollaborators: [
          { name: 'Priya', topic: 'segment and pipeline' },
          { name: '', topic: 'nobody' },
          { topic: 'no name' },
          'not a person',
        ],
      }),
    ).toEqual([{ name: 'Priya', topic: 'segment and pipeline' }]);
    expect(namedPeople({})).toEqual([]);
    expect(namedPeople(undefined)).toEqual([]);
  });
});

describe('PeopleView', () => {
  it('names the manager and the people the charter names, and offers no control it cannot honour', () => {
    const charter = {
      ...APPROVED_CHARTER,
      body: { namedCollaborators: [{ name: 'Priya', topic: 'segment and pipeline' }] },
    };
    const html = renderToStaticMarkup(asEmployee(<PeopleView />, { charter }));
    expect(html).toContain('boss@day0.local');
    expect(html).toContain('Priya');
    expect(html).toContain('segment and pipeline');
    expect(html).toContain('does not propose people for you to confirm yet');
    expect(html).not.toMatch(/<button[^>]*>(Confirm|Dismiss)/);
  });

  it('says the one-to-one asks who the employee works with when the charter names nobody', () => {
    expect(renderToStaticMarkup(asEmployee(<PeopleView />))).toContain(
      'The charter names nobody yet.',
    );
  });
});
