import { describe, expect, it } from 'vitest';
import type { Id } from '../../convex/_generated/dataModel';
import * as companyFiguresModule from '../../convex/companyFigures';
import {
  companyMetricsOf,
  summariseDecisions,
  type DecisionTotals,
  type EmployeeFigures,
} from '../../convex/companyFigures';
import { employeeFiguresOf } from '../../convex/metrics';
import { convexRuntimeImports, reachedFrom } from '../fixtures/import-graph';
import { registeredIn } from './registered-functions';

/*
 * The company's pooling (wave 18, 18-s), read directly: `companyMetricsOf` and the summaries
 * moved out of `convex/metrics.ts` as they stood. The figures' behaviour through the registered
 * reads and the recompute is `tests/convex/metrics.test.ts`'s, which did not move: its describes
 * drive `metrics.forOwner`, `computeCompanyMetrics` and the paged read, all still in `metrics.ts`.
 */

/** An employee's figures from no records, with the decisions' raw lists a test gives. */
function figuresWith(name: string, decisions: Partial<DecisionTotals>): EmployeeFigures {
  const empty = employeeFiguresOf({
    agent: { _id: `agent-${name}` as Id<'agents'>, name, createdAt: 1 },
    events: [],
    workItems: [],
    charters: [],
  });
  return { ...empty, decisions: { ...empty.decisions, ...decisions } };
}

describe('convex/companyFigures.ts', (): void => {
  it('registers no function: the figures’ four stay registered in convex/metrics.ts', (): void => {
    expect(registeredIn(companyFiguresModule)).toEqual([]);
  });

  it('sits below convex/metrics.ts, which imports it and which no chain of its imports reaches', (): void => {
    const graph = convexRuntimeImports();
    expect(graph.get('metrics')).toContain('companyFigures');
    expect(reachedFrom(graph, 'companyFigures').has('metrics')).toBe(false);
  });
});

describe('the company row pooled from each employee’s figures', (): void => {
  it('takes the decisions’ median over every employee’s latencies, not the employees’ medians', (): void => {
    const owner = companyMetricsOf(
      [
        figuresWith('Priya', {
          requested: 2,
          approved: 2,
          latencies: [1_000, 3_000],
          byVia: { dashboard: [1_000, 3_000], channel: [] },
        }),
        figuresWith('Mateo', {
          requested: 1,
          approved: 1,
          latencies: [10_000],
          byVia: { dashboard: [], channel: [10_000] },
        }),
      ],
      { excludedAgents: 0, omittedEmployees: 0 },
    );
    expect(owner.company.decisions).toMatchObject({
      requested: 3,
      approved: 3,
      medianLatencyMs: 3_000,
      byVia: { dashboard: { decided: 2 }, channel: { decided: 1, medianLatencyMs: 10_000 } },
    });
  });

  it('lists each employee’s own figures in the order given and carries what was set aside', (): void => {
    const owner = companyMetricsOf([figuresWith('Priya', {}), figuresWith('Mateo', {})], {
      excludedAgents: 1,
      omittedEmployees: 2,
    });
    expect(owner.employees.map((employee) => employee.name)).toEqual(['Priya', 'Mateo']);
    expect(owner.company.employees).toBe(2);
    expect(owner).toMatchObject({ excludedAgents: 1, omittedEmployees: 2 });
  });
});

describe('the decision figures from their raw lists', (): void => {
  it('have no median and no 90th when nothing was decided', (): void => {
    expect(
      summariseDecisions({
        requested: 1,
        approved: 0,
        rejected: 0,
        partiallyApproved: 0,
        cancelled: 0,
        latencies: [],
        byVia: { dashboard: [], channel: [] },
      }),
    ).toMatchObject({ requested: 1, medianLatencyMs: null, p90LatencyMs: null });
  });
});
