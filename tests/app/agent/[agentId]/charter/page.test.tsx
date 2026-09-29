import { describe, expect, it } from 'vitest';
import CharterPage from '../../../../../app/agent/[agentId]/charter/page';
import { CharterView } from '../../../../../app/agent/[agentId]/charter/CharterView';

describe('the Charter tab', () => {
  it('renders its view inside the employee page', () => {
    expect(CharterPage().type).toBe(CharterView);
  });
});
