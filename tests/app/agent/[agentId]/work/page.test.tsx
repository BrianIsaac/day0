import { describe, expect, it } from 'vitest';
import WorkPage from '../../../../../app/agent/[agentId]/work/page';
import { WorkView } from '../../../../../app/agent/[agentId]/work/WorkView';

describe('the Work tab', () => {
  it('renders its view inside the employee page', () => {
    expect(WorkPage().type).toBe(WorkView);
  });
});
