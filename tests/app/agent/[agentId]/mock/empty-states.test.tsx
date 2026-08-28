import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ loading: false }));

vi.mock('convex/react', () => ({
  useQuery: (): unknown[] | undefined => (state.loading ? undefined : []),
}));

import type { Id } from '../../../../../convex/_generated/dataModel';
import { DocsTab, EMPTY_DOCS, LOADING_DOCS } from '../../../../../app/agent/[agentId]/mock/DocsTab';
import { EMPTY_CHANNELS, SlackTab } from '../../../../../app/agent/[agentId]/mock/SlackTab';
import {
  EMPTY_SPREADSHEETS,
  SpreadsheetTab,
} from '../../../../../app/agent/[agentId]/mock/SpreadsheetTab';
import { EMPTY_TICKETS, TicketsTab } from '../../../../../app/agent/[agentId]/mock/TicketsTab';
import { EMPTY_TWEETS, TwitterTab } from '../../../../../app/agent/[agentId]/mock/TwitterTab';

const agentId = 'agent-1' as Id<'agents'>;

/** The tabs real mode does not render, so their copy has one form. */
const MOCK_ONLY_TABS = [
  { name: 'Slack', Tab: SlackTab, copy: EMPTY_CHANNELS },
  { name: 'Spreadsheet', Tab: SpreadsheetTab, copy: EMPTY_SPREADSHEETS },
  { name: 'Tickets', Tab: TicketsTab, copy: EMPTY_TICKETS },
  { name: 'Twitter', Tab: TwitterTab, copy: EMPTY_TWEETS },
] as const;

describe('mock tab empty states', (): void => {
  beforeEach((): void => {
    state.loading = false;
  });

  for (const { name, Tab, copy } of MOCK_ONLY_TABS) {
    it(`${name}: says what an empty mock-only tab means`, (): void => {
      expect(renderToStaticMarkup(<Tab agentId={agentId} />)).toContain(copy);
    });
  }

  it('Docs says what an empty tab means in each mode and defaults to mock', (): void => {
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      EMPTY_DOCS.real,
    );
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="mock" />)).toContain(
      EMPTY_DOCS.mock,
    );
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} />)).toContain(EMPTY_DOCS.mock);
    expect(EMPTY_DOCS.real).not.toContain('seed');
  });

  it('Docs says what is loading in each mode', (): void => {
    state.loading = true;
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="real" />)).toContain(
      LOADING_DOCS.real,
    );
    expect(renderToStaticMarkup(<DocsTab agentId={agentId} mode="mock" />)).toContain(
      LOADING_DOCS.mock,
    );
  });
});
