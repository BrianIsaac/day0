import { describe, expect, it } from 'vitest';
import {
  anonymousExitCode,
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
    expect(anonymousExitCode(checks)).toBe(1);
    expect(anonymousExitCode(checks.filter((check) => check.status !== 'BROKE THE RULE'))).toBe(0);
  });
});
