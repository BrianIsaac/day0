import { describe, expect, it } from 'vitest';
import { loadEvaluationTasks } from '../../../evaluation/graders';
import { EVALUATION_SCOPES, MOCK_OFFICE_SYSTEMS } from '../../../src/evaluation/scopes';

const systems = new Set<string>(MOCK_OFFICE_SYSTEMS);

describe('benchmark permission scopes', (): void => {
  it('grants only the systems the mock office actually has', (): void => {
    for (const scope of EVALUATION_SCOPES) {
      const [system] = scope.split(':');
      expect(systems.has(system!)).toBe(true);
    }
    expect(EVALUATION_SCOPES).toContain('boss:message');
    expect(EVALUATION_SCOPES).toContain('ticket:write');
  });

  it('leaves the out-of-scope tasks that name an absent system without a grant', async (): Promise<void> => {
    const tasks = await loadEvaluationTasks();
    const absent = tasks
      .filter((task) => task.category === 'out-of-scope')
      .map((task) => task.seed.sourceSystem)
      .filter((system) => !systems.has(system));
    expect(absent.length).toBeGreaterThanOrEqual(3);
    for (const system of absent) {
      expect(EVALUATION_SCOPES.some((scope) => scope.startsWith(`${system}:`))).toBe(false);
    }
  });
});
