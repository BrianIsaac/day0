import { describe, expect, it } from 'vitest';
import { CALLERLESS_FUNCTIONS } from '../../../src/lib/anonymous-access';
import {
  argumentsFor,
  callerlessFunction,
  judgeUnadmittedCall,
  tableOfStringId,
  tablesNamedBy,
  type CallOutcome,
  type IsGuardRefusal,
  type ValidatorJson,
} from '../../../src/lib/anonymous-sweep';

const TABLES: ReadonlySet<string> = new Set(['agents', 'workItems', 'managerTransfers']);

const ROWS: Readonly<Record<string, string>> = {
  agents: 'agent-row',
  workItems: 'item-row',
  managerTransfers: 'transfer-row',
};

const rowOf = (table: string): string | undefined => ROWS[table];

const GUARD = 'not authenticated';
const isGuard: IsGuardRefusal = (refusal) => refusal.data === GUARD;

const guardRefusal: CallOutcome = { kind: 'refused', message: GUARD, data: GUARD };

function answered(value: unknown): CallOutcome {
  return { kind: 'answered', value };
}

describe('the arguments the sweep asks a function with', (): void => {
  it('names a real row for every id and for every string named after a table', (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: {
        workItemId: { fieldType: { type: 'id', tableName: 'workItems' }, optional: false },
        agentId: { fieldType: { type: 'string' }, optional: false },
        transferId: { fieldType: { type: 'string' }, optional: false },
        note: { fieldType: { type: 'string' }, optional: false },
      },
    };
    expect(argumentsFor(validator, rowOf, TABLES)).toEqual({
      workItemId: 'item-row',
      agentId: 'agent-row',
      transferId: 'transfer-row',
      note: 'anonymous-sweep',
    });
  });

  it('fills an optional id and leaves every other optional field out', (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: {
        agentId: { fieldType: { type: 'id', tableName: 'agents' }, optional: true },
        limit: { fieldType: { type: 'number' }, optional: true },
      },
    };
    expect(argumentsFor(validator, rowOf, TABLES)).toEqual({ agentId: 'agent-row' });
  });

  it('gives an array one element, so a batch reaches its handler', (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: {
        items: {
          fieldType: { type: 'array', value: { type: 'id', tableName: 'workItems' } },
          optional: false,
        },
      },
    };
    expect(argumentsFor(validator, rowOf, TABLES)).toEqual({ items: ['item-row'] });
  });

  it("takes a union's first member and a literal's own value", (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: {
        decision: {
          fieldType: {
            type: 'union',
            value: [
              { type: 'literal', value: 'approve' },
              { type: 'literal', value: 'reject' },
            ],
          },
          optional: false,
        },
      },
    };
    expect(argumentsFor(validator, rowOf, TABLES)).toEqual({ decision: 'approve' });
  });

  it('refuses to make up an id for a table with no row, since the validator would refuse it first', (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: { skillId: { fieldType: { type: 'id', tableName: 'skills' }, optional: false } },
    };
    expect(() => argumentsFor(validator, rowOf, TABLES)).toThrow('no row of skills to name');
  });

  it('reads a string id only from a field named after a table the deployment has', (): void => {
    expect(tableOfStringId('agentId', TABLES)).toBe('agents');
    expect(tableOfStringId('transferId', TABLES)).toBe('managerTransfers');
    expect(tableOfStringId('skillId', TABLES)).toBeUndefined();
    expect(tableOfStringId('agent', TABLES)).toBeUndefined();
  });

  it('lists every table the ids of a validator point into, however deep', (): void => {
    const validator: ValidatorJson = {
      type: 'object',
      value: {
        items: {
          fieldType: {
            type: 'array',
            value: {
              type: 'union',
              value: [{ type: 'id', tableName: 'workItems' }, { type: 'null' }],
            },
          },
          optional: false,
        },
        agentId: { fieldType: { type: 'id', tableName: 'agents' }, optional: true },
      },
    };
    expect(tablesNamedBy(validator).sort()).toEqual(['agents', 'workItems']);
  });
});

describe('the judgement of a call by a caller the deployment does not admit', (): void => {
  it("keeps the rule for an unnamed function only with the guard's own refusal", (): void => {
    expect(judgeUnadmittedCall('work:get', 'no-identity', guardRefusal, isGuard).kept).toBe(true);
    const otherRefusal: CallOutcome = {
      kind: 'refused',
      message: 'work item not found',
      data: undefined,
    };
    expect(judgeUnadmittedCall('work:get', 'no-identity', otherRefusal, isGuard).kept).toBe(false);
    expect(judgeUnadmittedCall('work:needsYou', 'no-identity', answered([]), isGuard).kept).toBe(
      false,
    );
  });

  it('lets the release answer its stamp or null, and nothing more', (): void => {
    const stamp = answered({ release: '0.16.0', since: 1 });
    expect(judgeUnadmittedCall('config:release', 'no-identity', stamp, isGuard).kept).toBe(true);
    expect(judgeUnadmittedCall('config:release', 'no-identity', answered(null), isGuard).kept).toBe(
      true,
    );
    const more = answered({ release: '0.16.0', since: 1, commit: 'abc' });
    expect(judgeUnadmittedCall('config:release', 'no-identity', more, isGuard).kept).toBe(false);
  });

  it('lets whoAmI tell a refused token which rule refused it, and refuses a request with no token', (): void => {
    const refusal = answered({ refused: 'unverified-address' });
    expect(judgeUnadmittedCall('config:whoAmI', 'refused-token', refusal, isGuard).kept).toBe(true);
    expect(judgeUnadmittedCall('config:whoAmI', 'no-identity', refusal, isGuard).kept).toBe(false);
    expect(judgeUnadmittedCall('config:whoAmI', 'no-identity', guardRefusal, isGuard).kept).toBe(
      true,
    );
    const token = answered({ refused: 'outside-domains', subject: 'x' });
    expect(judgeUnadmittedCall('config:whoAmI', 'refused-token', token, isGuard).kept).toBe(false);
  });

  it('lets a secret-authorised function refuse in words or by throwing, and answer nothing else', (): void => {
    const path = 'slackProvisionActions:completeInstall';
    const words = answered({
      ok: false,
      reason: 'That install link is not one this deployment issued.',
    });
    expect(judgeUnadmittedCall(path, 'no-identity', words, isGuard).kept).toBe(true);
    const thrown: CallOutcome = { kind: 'refused', message: 'denied', data: undefined };
    expect(judgeUnadmittedCall(path, 'no-identity', thrown, isGuard).kept).toBe(true);
    const done = answered({ ok: true, agentId: 'agent-row' });
    expect(judgeUnadmittedCall(path, 'no-identity', done, isGuard).kept).toBe(false);
  });

  it('reads the entry of a named function, and none for any other', (): void => {
    for (const entry of CALLERLESS_FUNCTIONS) expect(callerlessFunction(entry.path)).toBe(entry);
    expect(callerlessFunction('work:get')).toBeUndefined();
  });
});
