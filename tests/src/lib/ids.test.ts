import { describe, expect, expectTypeOf, it } from 'vitest';
import { asAgentId, type AgentId } from '../../../src/lib/ids';

describe('the branded agent id', (): void => {
  it('is the same string at runtime', (): void => {
    expect(asAgentId('agent-1')).toBe('agent-1');
  });

  it('cannot be satisfied by a plain string at compile time', (): void => {
    expectTypeOf<string>().not.toMatchTypeOf<AgentId>();
    expectTypeOf(asAgentId('agent-1')).toMatchTypeOf<string>();
  });
});
