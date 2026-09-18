import { describe, expect, it } from 'vitest';
import {
  ticketRestRefusal,
  assignIssue,
  deleteComment,
  issueRestoreSteps,
  LinearClient,
  LinearRequestError,
  MAX_RETRY_WAIT_MS,
  moveIssue,
  RETRY_PAUSE_MS,
  retryOnce,
  readComments,
  readIssueSnapshot,
  readMutationNames,
  readStateHistory,
  readViewer,
  stateMovedByActor,
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

describe('a failed Linear call, classified', (): void => {
  const NOW = 1_789_700_000_000;
  const timedOut = (): DOMException => new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  const json = (value: unknown, init: ResponseInit): Response => new Response(JSON.stringify(value), init);

  async function failure(answer: () => Promise<Response>): Promise<LinearRequestError> {
    const error: unknown = await readViewer(new LinearClient('k', answer as typeof fetch, () => NOW)).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(LinearRequestError);
    return error as LinearRequestError;
  }

  it('calls a timeout, a dropped connection, a 5xx and a rate limit transient, with the wait Linear asked for', async (): Promise<void> => {
    expect(await failure(async () => { throw timedOut(); })).toMatchObject({ transient: true, reason: 'a timeout' });
    expect(await failure(async () => { throw new TypeError('fetch failed'); })).toMatchObject({
      transient: true,
      reason: 'a network failure',
    });
    expect(await failure(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))).toMatchObject({
      transient: true,
      reason: 'HTTP 502',
      waitMs: undefined,
    });
    expect(await failure(async () => json({}, { status: 429, headers: { 'Retry-After': '7' } }))).toMatchObject({
      transient: true,
      reason: 'HTTP 429',
      waitMs: 7_000,
    });
    // Linear's documented rate limit: HTTP 400, RATELIMITED, and the window's end in epoch milliseconds.
    const limited = { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] };
    expect(
      await failure(async () => json(limited, { status: 400, headers: { 'X-RateLimit-Requests-Reset': String(NOW + 5_000) } })),
    ).toMatchObject({ transient: true, reason: 'a Linear rate limit', waitMs: 5_000 });
    expect(await failure(async () => json(limited, { status: 400 }))).toMatchObject({
      transient: true,
      reason: 'a Linear rate limit',
      waitMs: undefined,
    });
  });

  it('calls a timeout while the answer is still arriving a timeout too', async (): Promise<void> => {
    const stalled = new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(new TextEncoder().encode('{"da'));
        controller.error(timedOut());
      },
    });
    expect(await failure(async () => new Response(stalled, { status: 200 }))).toMatchObject({
      transient: true,
      reason: 'a timeout',
    });
  });

  it('never calls a request Linear refused as wrong transient', async (): Promise<void> => {
    const invalid = { errors: [{ message: 'Argument Validation Error', extensions: { code: 'INVALID_INPUT' } }] };
    const refused = await failure(async () => json(invalid, { status: 400 }));
    expect(refused).toMatchObject({ transient: false });
    expect(refused.message).toBe('Linear: Argument Validation Error');
    expect(await failure(async () => new Response('', { status: 401 }))).toMatchObject({
      transient: false,
      reason: 'HTTP 401',
    });
    expect(await failure(async () => json({ errors: [{ message: 'Query too complex' }] }, { status: 200 }))).toMatchObject({
      transient: false,
    });
  });
});

describe('one retry', (): void => {
  function recorder(): { lines: string[]; sleeps: number[]; say: (line: string) => void; sleep: (ms: number) => Promise<void> } {
    const lines: string[] = [];
    const sleeps: number[] = [];
    return {
      lines,
      sleeps,
      say: (line: string): void => {
        lines.push(line);
      },
      sleep: async (ms: number): Promise<void> => {
        sleeps.push(ms);
      },
    };
  }
  const timeout = (): LinearRequestError =>
    new LinearRequestError('Linear did not answer within 30 s.', 'a timeout', true);

  it('names the retry, pauses, and runs the second attempt it is given', async (): Promise<void> => {
    const io = recorder();
    const result = await retryOnce('label delete', io, async (): Promise<string> => {
      throw timeout();
    }, async (): Promise<string> => 'gone');
    expect(result).toBe('gone');
    expect(io.lines).toEqual(['retrying label delete after a timeout']);
    expect(io.sleeps).toEqual([RETRY_PAUSE_MS]);
  });

  it('waits as long as Linear asked, and says so', async (): Promise<void> => {
    const io = recorder();
    let calls = 0;
    await retryOnce('label delete', io, async (): Promise<void> => {
      calls += 1;
      if (calls === 1) throw new LinearRequestError('Linear answered HTTP 429.', 'HTTP 429', true, 7_000);
    });
    expect(calls).toBe(2);
    expect(io.lines).toEqual(['retrying label delete after HTTP 429, in 7 s as Linear asked']);
    expect(io.sleeps).toEqual([7_000]);
  });

  it('fails with one line naming both failures when the retry fails too', async (): Promise<void> => {
    const io = recorder();
    await expect(
      retryOnce('label delete', io, async (): Promise<void> => {
        throw timeout();
      }, async (): Promise<void> => {
        throw new LinearRequestError('Linear answered HTTP 503.', 'HTTP 503', true);
      }),
    ).rejects.toThrow('label delete failed twice: a timeout, then HTTP 503');
  });

  it("never retries a request Linear called wrong, nor an error that is not Linear's", async (): Promise<void> => {
    const io = recorder();
    let again = 0;
    const wrong = new LinearRequestError('Linear: Argument Validation Error', 'HTTP 400', false);
    await expect(
      retryOnce('fin-status create', io, async (): Promise<void> => {
        throw wrong;
      }, async (): Promise<void> => {
        again += 1;
      }),
    ).rejects.toBe(wrong);
    await expect(
      retryOnce('fin-status create', io, async (): Promise<void> => {
        throw new Error('Linear issueCreate did not succeed.');
      }, async (): Promise<void> => {
        again += 1;
      }),
    ).rejects.toThrow('Linear issueCreate did not succeed.');
    expect(again).toBe(0);
    expect(io.lines).toEqual([]);
    expect(io.sleeps).toEqual([]);
  });

  it('does not turn a caller abort into a transient provider failure', async (): Promise<void> => {
    const io = recorder();
    let calls = 0;
    const fetch = (async (): Promise<Response> => {
      calls += 1;
      throw new DOMException('The caller stopped the operation', 'AbortError');
    }) as typeof globalThis.fetch;
    const client = new LinearClient('k', fetch);

    await expect(retryOnce('workspace read', io, () => readViewer(client))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(calls).toBe(1);
    expect(io.lines).toEqual([]);
    expect(io.sleeps).toEqual([]);
  });

  it('does not wait past its cap, and says how long Linear asked for', async (): Promise<void> => {
    const io = recorder();
    let again = 0;
    await expect(
      retryOnce('label delete', io, async (): Promise<void> => {
        throw new LinearRequestError('Linear answered HTTP 429.', 'HTTP 429', true, 1_800_000);
      }, async (): Promise<void> => {
        again += 1;
      }),
    ).rejects.toThrow(
      `label delete failed: Linear asked to wait 1800 s after HTTP 429, longer than the ${MAX_RETRY_WAIT_MS / 1_000} s a retry waits`,
    );
    expect(again).toBe(0);
    expect(io.sleeps).toEqual([]);
  });
});

describe('who moved the issue', (): void => {
  it('reads the state history with the actor and both states of each change', async (): Promise<void> => {
    const { fetch, calls } = fakeFetch(() => ({ data: { issue: { history: { nodes: [
      { id: 'h1', createdAt: 't1', actor: { id: 'u1' }, fromState: { id: 's-backlog' }, toState: { id: 's-done' } },
      { id: 'h2', createdAt: 't2', actor: null, fromState: null, toState: null },
    ] } } } }));
    await expect(readStateHistory(new LinearClient('k', fetch), 'i7')).resolves.toEqual([
      { actorId: 'u1', fromStateId: 's-backlog', toStateId: 's-done' },
      { actorId: null, fromStateId: null, toStateId: null },
    ]);
    expect(calls[0]?.body.variables).toEqual({ id: 'i7' });
    expect(calls[0]?.body.query).toContain('history');
  });

  it('attributes the current state to the key only when its own change produced it', (): void => {
    const ours = { actorId: 'u1', fromStateId: 's-backlog', toStateId: 's-done' };
    const theirs = { actorId: 'other', fromStateId: 's-backlog', toStateId: 's-done' };
    const elsewhere = { actorId: 'u1', fromStateId: 's-done', toStateId: 's-review' };
    expect(stateMovedByActor([ours], 'u1', 's-backlog', 's-done')).toBe(true);
    expect(stateMovedByActor([theirs], 'u1', 's-backlog', 's-done')).toBe(false);
    expect(stateMovedByActor([ours, elsewhere], 'u1', 's-backlog', 's-review')).toBe(false);
    expect(stateMovedByActor([], 'u1', 's-backlog', 's-done')).toBe(false);
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

  it('leaves concurrent comments and changed assignments outside the recorded writes', () => {
    expect(issueRestoreSteps(before, {
      stateId: 's-in-progress', assigneeId: 'other-user', commentIds: ['c1', 'ours', 'human'],
    }, { commentIds: ['ours'], stateId: 's-done', assigneeId: 'u1' })).toEqual([
      { kind: 'delete-comment', commentId: 'ours' },
    ]);
  });

  it('undoes the state, the assignee and every comment the run added, and nothing else', (): void => {
    const steps = issueRestoreSteps(before, {
      stateId: 's-done',
      assigneeId: 'u1',
      commentIds: ['c1', 'c2', 'c3'],
    }, { commentIds: ['c2', 'c3'], stateId: 's-done', assigneeId: 'u1' });
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
