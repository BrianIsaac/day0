import { describe, expect, it } from 'vitest';
import {
  MOCK_OFFICE_SYSTEMS,
  mockActsAsWords,
  mockOfficeSystemsPhrase,
} from '../../../src/surfaces/mock-office';

describe('the mock office as the screens name it', (): void => {
  it("says the hosted office's words on every mock surface", (): void => {
    expect(mockActsAsWords('Maya')).toBe('Maya, its own app in this office');
  });

  it('lists its five systems in the order the office draws them', (): void => {
    expect(MOCK_OFFICE_SYSTEMS.map((system) => system.label)).toEqual([
      'Slack',
      'Spreadsheet',
      'Docs',
      'Tickets',
      'Social',
    ]);
    expect(mockOfficeSystemsPhrase()).toBe('Slack, Spreadsheet, Docs, Tickets and Social');
  });
});
