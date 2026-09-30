import { describe, expect, it } from 'vitest';
import type { Id } from '../../../convex/_generated/dataModel';
import { agentReadsSource } from '../../../src/docs/agent-sources';

describe('agentReadsSource', (): void => {
  const first = 'source-first' as Id<'docSources'>;
  const second = 'source-second' as Id<'docSources'>;

  it('reads every owner source except the ones the employee was deployed without', (): void => {
    expect({
      all: agentReadsSource({}, second),
      excludedSecond: agentReadsSource({ excludedDocSourceIds: [second] }, second),
      keptFirst: agentReadsSource({ excludedDocSourceIds: [second] }, first),
    }).toEqual({ all: true, excludedSecond: false, keptFirst: true });
  });
});
