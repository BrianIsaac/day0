'use client';

import { useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DocsTab } from './mock/DocsTab';
import { SpreadsheetTab } from './mock/SpreadsheetTab';
import { SlackTab } from './mock/SlackTab';
import { TwitterTab } from './mock/TwitterTab';
import { TicketsTab } from './mock/TicketsTab';

type TabKey = 'slack' | 'spreadsheet' | 'docs' | 'tweet' | 'tickets';

const TABS: Array<{ key: TabKey; label: string; sublabel: string }> = [
  { key: 'slack', label: 'Slack', sublabel: 'channels + DMs' },
  { key: 'spreadsheet', label: 'Spreadsheet', sublabel: 'Q4 Revenue Tracker' },
  { key: 'docs', label: 'Docs', sublabel: 'team wiki + how-tos' },
  { key: 'tweet', label: 'Twitter', sublabel: 'mentions + drafts' },
  { key: 'tickets', label: 'Tickets', sublabel: 'Linear-style queue' },
];

export function MockEnvironment({ agentId }: { agentId: Id<'agents'> }) {
  const [active, setActive] = useState<TabKey>('slack');

  // Pre-fetch counts for tab badges
  const docs = useQuery(api.mock.listDocs, { agentId });
  const channels = useQuery(api.mock.listChannels, { agentId });
  const tweets = useQuery(api.mock.listTweets, { agentId });
  const tickets = useQuery(api.mock.listTickets, { agentId });
  const spreadsheets = useQuery(api.mock.listSpreadsheets, { agentId });

  const counts: Record<TabKey, number | undefined> = {
    slack: channels?.length,
    spreadsheet: spreadsheets?.length,
    docs: docs?.length,
    tweet: tweets?.length,
    tickets: tickets?.length,
  };

  return (
    <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">Mock work environment</h2>
          <p className="text-[10px] text-[var(--color-muted)]">
            Live surfaces — when the agent runs a skill, edits land here in real time
          </p>
        </div>
      </div>

      <nav className="flex gap-0 px-2 pt-2 border-b border-[var(--color-border)] overflow-x-auto">
        {TABS.map((t) => {
          const isActive = active === t.key;
          const count = counts[t.key];
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`px-4 py-2 mr-1 rounded-t-md text-xs flex items-center gap-2 transition border-b-2 ${
                isActive
                  ? 'border-[var(--color-accent)] text-[var(--color-fg)] bg-[var(--color-bg)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              <span className="font-medium">{t.label}</span>
              {count !== undefined ? (
                <span
                  className={`text-[9px] px-1.5 py-0.5 rounded-full font-mono ${
                    isActive
                      ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                      : 'bg-[var(--color-border)]/40 text-[var(--color-muted)]'
                  }`}
                >
                  {count}
                </span>
              ) : null}
              <span className="hidden lg:inline xl:hidden 2xl:inline text-[10px] text-[var(--color-muted)]">{t.sublabel}</span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 min-h-[24rem] max-h-[40rem] overflow-y-auto">
        {active === 'docs' ? <DocsTab agentId={agentId} /> : null}
        {active === 'spreadsheet' ? <SpreadsheetTab agentId={agentId} /> : null}
        {active === 'slack' ? <SlackTab agentId={agentId} /> : null}
        {active === 'tweet' ? <TwitterTab agentId={agentId} /> : null}
        {active === 'tickets' ? <TicketsTab agentId={agentId} /> : null}
      </div>
    </section>
  );
}
