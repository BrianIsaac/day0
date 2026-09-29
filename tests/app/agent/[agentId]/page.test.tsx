import { describe, expect, it } from 'vitest';
import NeedsYouPage from '../../../../app/agent/[agentId]/page';
import { NeedsYouView } from '../../../../app/agent/[agentId]/NeedsYouView';

describe('the employee page itself', () => {
  it('opens on Needs you', () => {
    expect(NeedsYouPage().type).toBe(NeedsYouView);
  });
});
