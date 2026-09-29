/** @vitest-environment jsdom */

import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { AgentMetrics } from '../../../../../src/metrics/types';
import { dashboardMetrics } from '../../../../fixtures/dashboard/metrics';
import { MetricsCard } from '../../../../../app/agent/[agentId]/record/MetricsCard';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('dashboard decisions on the supervision card (P6-9)', (): void => {
  const metrics = dashboardMetrics;

  it('counts decisions made on the dashboard when nothing was asked on a chat surface', (): void => {
    const markup = renderToStaticMarkup(<MetricsCard metrics={metrics()} />);
    expect(markup).toContain('2 / 1');
    expect(markup).toContain('3 / 0');
    expect(markup).toContain('0 asked on a chat surface');
    // Only the revocation row has no evidence yet.
    expect(markup.match(/not yet/g)).toHaveLength(1);
  });

  it('counts writes as automatic changes, with the reads and the manager message on their own line, and shows the pilot figures (U12 D4, N11)', (): void => {
    const recorded = {
      ...metrics(),
      actions: {
        ...metrics().actions,
        autoApplied: 25,
        automatic: { reads: 12, managerMessages: 1, writes: 12 },
      },
      pilot: {
        ...metrics().pilot,
        hoursSaved: { estimatedItems: 2, hours: 1.25 },
      },
    } as AgentMetrics;
    const markup = renderToStaticMarkup(<MetricsCard metrics={recorded} />).replace(/\s+/g, ' ');
    expect(markup).toContain('12 automatic changes');
    expect(markup).not.toContain('25 actions automatic');
    expect(markup).toContain('Also applied on their own: 12 reads, 1 manager message.');
    // A heading above the list, not a row inside it: a dl holds only dt and dd groups.
    expect(markup).toMatch(/<h3[^>]*>Pilot figures<\/h3><dl/);
    expect(markup).toContain('1 of 3 (33%)');
    expect(markup).toContain('2 min / 3 min (2 done)');
    expect(markup).toContain('1 of 1 answer');
    expect(markup).toMatch(/hours saved<span[^>]*>your estimates, internal gauge<\/span>/);
    expect(markup).toContain('1.3 h over 2 items');
    expect(markup).toContain('not measured yet');
  });
});
