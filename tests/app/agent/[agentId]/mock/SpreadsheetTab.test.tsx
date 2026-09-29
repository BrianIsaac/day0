import { renderToStaticMarkup } from 'react-dom/server';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown): unknown => {
    const name = getFunctionName(reference as never);
    if (name === 'mock:listSpreadsheets') return [{ _id: 'sheet-1', slug: 'q4', title: 'Q4' }];
    if (name === 'mock:getSpreadsheet') {
      return {
        sheet: { title: 'Q4 Revenue Tracker', tabs: [{ name: 'Pipeline', headers: ['Deal'] }] },
        rows: [
          { _id: 'row-1', tabName: 'Pipeline', cells: { Deal: 'Northstar' }, addedBy: 'Priya' },
          { _id: 'row-2', tabName: 'Pipeline', cells: { Deal: 'Meridian' } },
        ],
      };
    }
    return undefined;
  },
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import { SpreadsheetTab } from '../../../../../app/agent/[agentId]/mock/SpreadsheetTab';

describe('the spreadsheet rows', (): void => {
  it('leaves the added-by cell empty for a row nobody is recorded as adding, and names whoever did', (): void => {
    const markup = renderToStaticMarkup(<SpreadsheetTab agentId={'agent-1' as Id<'agents'>} />);
    const addedBy = [
      ...markup.matchAll(/<td class="px-3 py-1\.5 text-xs[^"]*">([^<]*)<\/td>/g),
    ].map((match) => match[1]);
    expect(addedBy).toEqual(['Priya', '']);
  });
});
