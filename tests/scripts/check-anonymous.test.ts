import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  EXIT_BROKEN,
  EXIT_INCOMPLETE,
  EXIT_KEPT,
  EXIT_NOT_RUN,
  anonymousExitCode,
  main,
  askWithNoIdentity,
  isGuardRefusalData,
  publicFunctionsOf,
  sweepWithNoIdentity,
  type PublicFunction,
} from '../../scripts/check-anonymous';
import type { CallOutcome } from '../../src/lib/anonymous-sweep';

const GUARD: CallOutcome = {
  kind: 'refused',
  message: 'not authenticated',
  data: 'not authenticated',
};

function fn(
  path: string,
  args: PublicFunction['args'] = { type: 'object', value: {} },
): PublicFunction {
  return { path, kind: 'query', args };
}

describe('the deployment check for a caller with no identity', (): void => {
  it("reads the public queries, mutations and actions from the deployment's API spec, by call path", (): void => {
    const spec = [
      {
        identifier: 'config.js:release',
        functionType: 'Query',
        visibility: { kind: 'public' },
        args: '{"type":"object","value":{}}',
      },
      {
        identifier: 'work.js:get',
        functionType: 'Query',
        visibility: { kind: 'public' },
        args: {
          type: 'object',
          value: {
            workItemId: { fieldType: { type: 'id', tableName: 'workItems' }, optional: false },
          },
        },
      },
      {
        identifier: 'work.js:claimForExecution',
        functionType: 'Mutation',
        visibility: { kind: 'internal' },
      },
      {
        identifier: 'http.js:GET /slack',
        functionType: 'HttpAction',
        visibility: { kind: 'public' },
      },
    ];
    expect(publicFunctionsOf(spec).map((one) => `${one.kind} ${one.path}`)).toEqual([
      'query config:release',
      'query work:get',
    ]);
  });

  it("recognises the guard's refusal in either mode's words, and nothing else", (): void => {
    expect(isGuardRefusalData('not authenticated')).toBe(true);
    expect(isGuardRefusalData('not authenticated: no-auth dev mode accepts only callers')).toBe(
      true,
    );
    expect(isGuardRefusalData('work item not found')).toBe(false);
    expect(isGuardRefusalData(undefined)).toBe(false);
  });

  it('asks with no credential of any kind, and reads the error data the deployment sends', async (): Promise<void> => {
    const sent: RequestInit[] = [];
    const send = (async (_url: string, init: RequestInit): Promise<Response> => {
      sent.push(init);
      return new Response(
        JSON.stringify({
          status: 'error',
          errorMessage: 'not authenticated',
          errorData: 'not authenticated',
        }),
      );
    }) as unknown as typeof fetch;
    const outcome = await askWithNoIdentity(
      'http://127.0.0.1:3971/',
      fn('work:get'),
      { a: 1 },
      send,
    );
    expect(outcome).toEqual(GUARD);
    const headers = new Headers(sent[0]?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(JSON.parse(String(sent[0]?.body))).toEqual({
      path: 'work:get',
      args: { a: 1 },
      format: 'json',
    });
  });

  it('passes a guarded function and a named one, fails one that answers, and says which it could not ask', async (): Promise<void> => {
    const answers: Record<string, CallOutcome> = {
      'work:needsYou': GUARD,
      'config:release': { kind: 'answered', value: { release: '0.16.0', since: 1 } },
      'config:surfaceMode': { kind: 'answered', value: { mode: 'real' } },
    };
    const needsSkill: PublicFunction['args'] = {
      type: 'object',
      value: { skillId: { fieldType: { type: 'id', tableName: 'skills' }, optional: false } },
    };
    const checks = await sweepWithNoIdentity(
      [
        fn('config:release'),
        fn('config:surfaceMode'),
        fn('skills:get', needsSkill),
        fn('work:needsYou'),
      ],
      {
        tables: new Set(['skills']),
        rowOf: (): undefined => undefined,
        ask: async (one): Promise<CallOutcome> => answers[one.path]!,
      },
    );
    expect(checks.map((check) => `${check.status} ${check.path}`)).toEqual([
      'answered as named config:release',
      'BROKE THE RULE config:surfaceMode',
      'not asked skills:get',
      'refused work:needsYou',
    ]);
    expect(anonymousExitCode(checks)).toBe(EXIT_BROKEN);
    // A function it could not ask leaves the run incomplete, never passed.
    expect(anonymousExitCode(checks.filter((check) => check.status !== 'BROKE THE RULE'))).toBe(
      EXIT_INCOMPLETE,
    );
    expect(
      anonymousExitCode(
        checks.filter(
          (check) => check.status.includes('refused') || check.status.includes('answered'),
        ),
      ),
    ).toBe(EXIT_KEPT);
  });

  it("keeps each line to one line when the deployment's refusal spans several", async (): Promise<void> => {
    const checks = await sweepWithNoIdentity(
      [fn('onboarding:synthesiseFromTranscriptForWebhook')],
      {
        tables: new Set(),
        rowOf: (): undefined => undefined,
        ask: async (): Promise<CallOutcome> => ({
          kind: 'refused',
          message: 'Server Error\nUncaught Error: webhook denied\n    at handler (convex/voice.ts)',
          data: undefined,
        }),
      },
    );
    expect(checks.map((check) => check.detail)).toEqual([
      'Server Error Uncaught Error: webhook denied at handler (convex/voice.ts)',
    ]);
  });

  it('says a named function refused when it refused, and answered only when it answered', async (): Promise<void> => {
    const checks = await sweepWithNoIdentity(
      [fn('slackProvisionActions:completeInstall'), fn('config:release')],
      {
        tables: new Set(),
        rowOf: (): undefined => undefined,
        ask: async (one): Promise<CallOutcome> =>
          one.path === 'config:release'
            ? { kind: 'answered', value: null }
            : {
                kind: 'refused',
                message: 'App installation is a local real-mode feature',
                data: undefined,
              },
      },
    );
    expect(checks.map((check) => `${check.status} ${check.path}`)).toEqual([
      'refused as named slackProvisionActions:completeInstall',
      'answered as named config:release',
    ]);
  });

  it('asks every function in both argument shapes, and fails one that answers its emptiest', async (): Promise<void> => {
    const batch: PublicFunction['args'] = {
      type: 'object',
      value: {
        members: {
          fieldType: { type: 'array', value: { type: 'id', tableName: 'workItems' } },
          optional: false,
        },
      },
    };
    const asked: unknown[] = [];
    const checks = await sweepWithNoIdentity([fn('work:approveActionsBatch', batch)], {
      tables: new Set(['workItems']),
      rowOf: (): string => 'item-row',
      ask: async (_one, args): Promise<CallOutcome> => {
        asked.push(args);
        const members = (args as { members: unknown[] }).members;
        return members.length === 0
          ? { kind: 'refused', message: 'a batch approves at least one item', data: undefined }
          : GUARD;
      },
    });
    expect(asked).toEqual([{ members: ['item-row'] }, { members: [] }]);
    expect(checks.map((check) => check.status)).toEqual(['BROKE THE RULE']);
    expect(checks[0]?.detail).toContain('emptiest arguments');
  });

  it('says a function that gave no answer, and calls the run incomplete', async (): Promise<void> => {
    const checks = await sweepWithNoIdentity([fn('work:needsYou')], {
      tables: new Set(),
      rowOf: (): undefined => undefined,
      ask: async (): Promise<CallOutcome> => {
        throw new Error('Unexpected token < in JSON at position 0');
      },
    });
    expect(checks.map((check) => `${check.status} ${check.path}`)).toEqual([
      'no answer work:needsYou',
    ]);
    expect(anonymousExitCode(checks)).toBe(EXIT_INCOMPLETE);
  });
});

describe('running the deployment check', (): void => {
  afterEach((): void => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('asks nothing of any deployment without --yes', async (): Promise<void> => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    vi.spyOn(console, 'error').mockImplementation((): void => undefined);
    expect(await main(['.env.does-not-exist'])).toBe(EXIT_NOT_RUN);
    expect(fetched).not.toHaveBeenCalled();
  });
});
