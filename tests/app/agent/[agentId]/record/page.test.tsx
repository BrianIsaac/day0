import { describe, expect, it } from 'vitest';
import RecordPage from '../../../../../app/agent/[agentId]/record/page';
import { RecordView } from '../../../../../app/agent/[agentId]/record/RecordView';

describe('the Record tab', () => {
  it('renders its view inside the employee page', () => {
    expect(RecordPage().type).toBe(RecordView);
  });
});
