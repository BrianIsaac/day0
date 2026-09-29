import { describe, expect, it } from 'vitest';
import SkillsPage from '../../../../../app/agent/[agentId]/skills/page';
import { SkillsView } from '../../../../../app/agent/[agentId]/skills/SkillsView';

describe('the Skills tab', () => {
  it('renders its view inside the employee page', () => {
    expect(SkillsPage().type).toBe(SkillsView);
  });
});
