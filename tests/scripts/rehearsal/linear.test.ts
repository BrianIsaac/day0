import { describe, expect, it } from 'vitest';
import {
  ticketRestRefusal,
  assignIssue,
  deleteComment,
  issueRestoreSteps,
  LinearClient,
  moveIssue,
  readComments,
  readIssueSnapshot,
  readMutationNames,
  readViewer,
  type IssueSnapshot,
} from '../../../scripts/rehearsal/linear';

interface Recorded {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables?: Record<string, unknown> };
}

function fakeFetch(
  answer: (body: Recorded['body']) => unknown,
  calls: Recorded[] = [],
): { fetch: typeof fetch; calls: Recorded[] } {
  const impl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as Recorded['body'];
    calls.push({ url: String(input), headers: init?.headers as Record<string, string>, body });
    return new Response(JSON.stringify(answer(body)), { status: 200 });
  }) as typeof fetch;
  return { fetch: impl, calls };
}

describe('the Linear client', (): void => {
  it('posts to the GraphQL endpoint with the key as the authorization header', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch(() => ({ data: { viewer: { id: 'u1', name: 'Op' } } }));
    const client = new LinearClient('lin_api_test', fetch);
    await expect(readViewer(client)).resolves.toEqual({ id: 'u1', name: 'Op' });
    expect(calls[0]!.url).toBe('https://api.linear.app/graphql');
    expect(calls[0]!.headers.Authorization).toBe('lin_api_test');
    expect(calls[0]!.body.query).toContain('viewer');
  });

  it('turns a GraphQL error list into a thrown error and never returns partial data', async (): Promise<void> => {
    const { fetch } = fakeFetch(() => ({ errors: [{ message: 'Query too complex' }] }));
    await expect(readViewer(new LinearClient('k', fetch))).rejects.toThrow('Query too complex');
  });

  it('snapshots an issue by identifier: state, assignee and comment ids', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch(() => ({
      data: {
        issue: {
          id: 'i7',
          identifier: 'REVOPS-7',
          state: { id: 's-backlog', name: 'Backlog' },
          assignee: null,
          comments: { nodes: [{ id: 'c1' }] },
        },
      },
    }));
    const snapshot = await readIssueSnapshot(new LinearClient('k', fetch), 'REVOPS-7');
    expect(snapshot).toEqual({
      id: 'i7',
      identifier: 'REVOPS-7',
      stateId: 's-backlog',
      stateName: 'Backlog',
      assigneeId: null,
      commentIds: ['c1'],
    });
    expect(calls[0]!.body.variables).toEqual({ id: 'REVOPS-7' });
  });

  it('assigns, moves and deletes through the named mutations with the ids as variables', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch((body) => {
      if (body.query.includes('issueUpdate')) return { data: { issueUpdate: { success: true } } };
      if (body.query.includes('commentDelete')) return { data: { commentDelete: { success: true } } };
      return { data: {} };
    });
    const client = new LinearClient('k', fetch);
    await assignIssue(client, 'i7', 'u1');
    await assignIssue(client, 'i7', null);
    await moveIssue(client, 'i7', 's-done');
    await deleteComment(client, 'c9');
    expect(calls.map((call) => call.body.variables)).toEqual([
      { id: 'i7', input: { assigneeId: 'u1' } },
      { id: 'i7', input: { assigneeId: null } },
      { id: 'i7', input: { stateId: 's-done' } },
      { id: 'c9' },
    ]);
  });

  it('refuses a mutation the provider answers success: false', async (): Promise<void> => {
    const { fetch } = fakeFetch(() => ({ data: { issueUpdate: { success: false } } }));
    await expect(assignIssue(new LinearClient('k', fetch), 'i7', 'u1')).rejects.toThrow('issueUpdate');
  });

  it('lists comments and mutation names', async (): Promise<void> => {
    const { fetch } = fakeFetch((body) =>
      body.query.includes('__type')
        ? { data: { __type: { fields: [{ name: 'commentDelete' }, { name: 'issueUpdate' }] } } }
        : { data: { issue: { comments: { nodes: [{ id: 'c1', body: 'hi', createdAt: 't' }] } } } },
    );
    const client = new LinearClient('k', fetch);
    await expect(readMutationNames(client)).resolves.toEqual(['commentDelete', 'issueUpdate']);
    await expect(readComments(client, 'i7')).resolves.toEqual([{ id: 'c1', body: 'hi', createdAt: 't' }]);
  });
});

describe('putting an issue back', (): void => {
  const before: IssueSnapshot = {
    id: 'i7',
    identifier: 'REVOPS-7',
    stateId: 's-backlog',
    stateName: 'Backlog',
    assigneeId: null,
    commentIds: ['c1'],
  };

  it('undoes the state, the assignee and every comment the run added, and nothing else', (): void => {
    const steps = issueRestoreSteps(before, {
      stateId: 's-done',
      assigneeId: 'u1',
      commentIds: ['c1', 'c2', 'c3'],
    });
    expect(steps).toEqual([
      { kind: 'delete-comment', commentId: 'c2' },
      { kind: 'delete-comment', commentId: 'c3' },
      { kind: 'move', stateId: 's-backlog' },
      { kind: 'assign', assigneeId: null },
    ]);
  });

  it('is empty when nothing changed', (): void => {
    expect(
      issueRestoreSteps(before, { stateId: 's-backlog', assigneeId: null, commentIds: ['c1'] }),
    ).toEqual([]);
  });
});

describe('the ticket at rest', (): void => {
  const base = { id: 'i1', identifier: 'REVOPS-7', stateId: 's', commentIds: [] as string[] };
  it('accepts an unassigned open ticket and refuses leftovers from an earlier run', (): void => {
    expect(ticketRestRefusal({ ...base, stateName: 'Backlog', assigneeId: null })).toBeUndefined();
    expect(ticketRestRefusal({ ...base, stateName: 'Todo', assigneeId: null })).toBeUndefined();
    expect(ticketRestRefusal({ ...base, stateName: 'Backlog', assigneeId: 'u1' })).toContain('already assigned');
    expect(ticketRestRefusal({ ...base, stateName: 'Done', assigneeId: null })).toContain('is Done');
    expect(ticketRestRefusal({ ...base, stateName: 'In Progress', assigneeId: null })).toContain('In Progress');
  });
});
