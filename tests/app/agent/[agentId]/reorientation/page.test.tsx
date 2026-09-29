import { describe, expect, it } from 'vitest';
import ReorientationPage from '../../../../../app/agent/[agentId]/reorientation/page';
import { ReorientationView } from '../../../../../app/agent/[agentId]/reorientation/ReorientationView';

describe('the reorientation page', () => {
  it('renders its view inside the employee page', () => {
    expect(ReorientationPage().type).toBe(ReorientationView);
  });
});
