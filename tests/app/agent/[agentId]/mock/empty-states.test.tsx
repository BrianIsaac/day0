import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('convex/react', () => ({
  useQuery: (): unknown[] => [],
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import { DocsTab, EMPTY_DOCS } from '../../../../../app/agent/[agentId]/mock/DocsTab';
import { EMPTY_CHANNELS, SlackTab } from '../../../../../app/agent/[agentId]/mock/SlackTab';
import {
  EMPTY_SPREADSHEETS,
  SpreadsheetTab,
} from '../../../../../app/agent/[agentId]/mock/SpreadsheetTab';
import { EMPTY_TICKETS, TicketsTab } from '../../../../../app/agent/[agentId]/mock/TicketsTab';
import { EMPTY_TWEETS, TwitterTab } from '../../../../../app/agent/[agentId]/mock/TwitterTab';

const agentId = 'agent-1' as Id<'agents'>;

const TABS = [
  { name: 'Docs', Tab: DocsTab, copy: EMPTY_DOCS },
  { name: 'Slack', Tab: SlackTab, copy: EMPTY_CHANNELS },
  { name: 'Spreadsheet', Tab: SpreadsheetTab, copy: EMPTY_SPREADSHEETS },
  { name: 'Tickets', Tab: TicketsTab, copy: EMPTY_TICKETS },
  { name: 'Twitter', Tab: TwitterTab, copy: EMPTY_TWEETS },
] as const;

describe('mock tab empty states', (): void => {
  for (const { name, Tab, copy } of TABS) {
    it(`${name}: says what an empty tab means in each mode and defaults to mock`, (): void => {
      expect(renderToStaticMarkup(<Tab agentId={agentId} mode="real" />)).toContain(copy.real);
      expect(renderToStaticMarkup(<Tab agentId={agentId} mode="mock" />)).toContain(copy.mock);
      expect(renderToStaticMarkup(<Tab agentId={agentId} />)).toContain(copy.mock);
      expect(copy.real).toContain('real mode');
      expect(copy.real).not.toContain('seed');
    });
  }
});
