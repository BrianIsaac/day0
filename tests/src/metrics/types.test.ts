import { describe, expectTypeOf, it } from 'vitest';
import type {
  AgentMetrics,
  CompanyMetrics,
  EmployeeMetrics,
  OwnerMetrics,
  PilotFigures,
} from '../../../src/metrics/types';

describe('the supervision figure types the dashboard and the backend share', (): void => {
  it('give the owner every employee beside the company, each carrying the same pilot figures', (): void => {
    expectTypeOf<OwnerMetrics['employees'][number]>().toEqualTypeOf<EmployeeMetrics>();
    expectTypeOf<OwnerMetrics['company']>().toEqualTypeOf<CompanyMetrics>();
    expectTypeOf<EmployeeMetrics['metrics']>().toEqualTypeOf<AgentMetrics>();
    expectTypeOf<AgentMetrics['pilot']>().toEqualTypeOf<PilotFigures>();
    expectTypeOf<CompanyMetrics['pilot']>().toEqualTypeOf<PilotFigures>();
  });

  it('pool the company decisions and actions as one distribution of the agent shape, never a median of medians', (): void => {
    expectTypeOf<CompanyMetrics['decisions']>().toEqualTypeOf<AgentMetrics['decisions']>();
    expectTypeOf<CompanyMetrics['actions']>().toEqualTypeOf<AgentMetrics['actions']>();
  });
});
