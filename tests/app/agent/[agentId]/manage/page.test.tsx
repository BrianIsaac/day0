import { describe, expect, it } from 'vitest';
import ManagePage from '../../../../../app/agent/[agentId]/manage/page';
import { ManageView } from '../../../../../app/agent/[agentId]/manage/ManageView';

describe('the Manage tab', () => {
  it('renders its view inside the employee page', () => {
    expect(ManagePage().type).toBe(ManageView);
  });
});
