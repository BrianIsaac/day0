import { describe, expect, it } from 'vitest';
import PeoplePage from '../../../../../app/agent/[agentId]/people/page';
import { PeopleView } from '../../../../../app/agent/[agentId]/people/PeopleView';

describe('the People tab', () => {
  it('renders its view inside the employee page', () => {
    expect(PeoplePage().type).toBe(PeopleView);
  });
});
