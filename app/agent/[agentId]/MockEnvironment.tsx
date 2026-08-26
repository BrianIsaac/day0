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
import { SurfacesTab } from './mock/SurfacesTab';

type TabKey = 'slack' | 'spreadsheet' | 'docs' | 'tweet' | 'tickets' | 'surfaces';

export type EnvironmentMode = 'mock' | 'real';

const CAPTIONS: Record<EnvironmentMode, string> = {
  mock: 'Mock surfaces - when the agent runs a skill, edits land here in real time',
  real: 'Real surfaces - the Docs tab mirrors the linked documentation; Slack, Spreadsheet, Twitter and Tickets are mock-only and stay empty; the agent acts through the connections on the Surfaces tab',
};

const TABS: Array<{ key: TabKey; label: string; sublabel: string }> = [
  { key: 'slack', label: 'Slack', sublabel: 'channels + DMs' },
  { key: 'spreadsheet', label: 'Spreadsheet', sublabel: 'Q4 Revenue Tracker' },
  { key: 'docs', label: 'Docs', sublabel: 'team wiki + how-tos' },
  { key: 'tweet', label: 'Twitter', sublabel: 'mentions + drafts' },
  { key: 'tickets', label: 'Tickets', sublabel: 'Linear-style queue' },
  { key: 'surfaces', label: 'Surfaces', sublabel: 'connections + evidence' },
];

export function MockEnvironment({ agentId }: { agentId: Id<'agents'> }) {
  const [active, setActive] = useState<TabKey>('slack');

  // Pre-fetch counts for tab badges
  const docs = useQuery(api.mock.listDocs, { agentId });
  const channels = useQuery(api.mock.listChannels, { agentId });
  const tweets = useQuery(api.mock.listTweets, { agentId });
  const tickets = useQuery(api.mock.listTickets, { agentId });
  const spreadsheets = useQuery(api.mock.listSpreadsheets, { agentId });
  const config = useQuery(api.config.surfaceMode);
  // The Surfaces tab exists only in real mode; the hosted mock keeps its
  // five synthetic surfaces and never asks for connection verdicts.
  const isReal = config?.mode === 'real';
  const mode: EnvironmentMode = isReal ? 'real' : 'mock';
  const surfaces = useQuery(api.surfaces.listForAgent, isReal ? { agentId } : 'skip');
  const tabs = isReal ? TABS : TABS.filter((tab) => tab.key !== 'surfaces');

  const counts: Record<TabKey, number | undefined> = {
    slack: channels?.length,
    spreadsheet: spreadsheets?.length,
    docs: docs?.length,
    tweet: tweets?.length,
    tickets: tickets?.length,
    surfaces: surfaces?.length,
  };

  return (
    /* Every width question in this panel is about the panel, not the window:
       it sits in a column whose width the viewport does not predict. Hence a
       container, and `@` variants below rather than `lg:`/`xl:`. */
    <section className="@container bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl overflow-hidden">
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)]">
        <div>
          <h2 className="text-sm font-semibold tracking-tight">
            {isReal ? 'Work environment' : 'Mock work environment'}
          </h2>
          <p className="text-[10px] text-[var(--color-muted)]">{CAPTIONS[mode]}</p>
        </div>
      </div>

      {/* Wraps rather than scrolls. A tab strip that overflows hides whole
          surfaces behind a gesture nothing on the page suggests, and the two
          it hid here — Twitter and Tickets — are two fifths of the environment
          the agent works in. */}
      <nav className="flex flex-wrap gap-1 px-2 pt-2 border-b border-[var(--color-border)]">
        {tabs.map((t) => {
          const isActive = active === t.key;
          const count = counts[t.key];
          return (
            <button
              key={t.key}
              onClick={() => setActive(t.key)}
              className={`px-3 py-2 rounded-t-md text-xs flex items-center gap-1.5 transition border-b-2 ${
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
              <span className="hidden @3xl:inline text-[10px] text-[var(--color-muted)]">
                {t.sublabel}
              </span>
            </button>
          );
        })}
      </nav>

      <div className="p-4 min-h-[24rem] max-h-[40rem] overflow-y-auto">
        {active === 'docs' ? <DocsTab agentId={agentId} mode={mode} /> : null}
        {active === 'spreadsheet' ? <SpreadsheetTab agentId={agentId} mode={mode} /> : null}
        {active === 'slack' ? <SlackTab agentId={agentId} mode={mode} /> : null}
        {active === 'tweet' ? <TwitterTab agentId={agentId} mode={mode} /> : null}
        {active === 'tickets' ? <TicketsTab agentId={agentId} mode={mode} /> : null}
        {active === 'surfaces' && isReal ? <SurfacesTab agentId={agentId} /> : null}
      </div>
    </section>
  );
}
