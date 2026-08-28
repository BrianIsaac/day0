'use client';

import { useEffect, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DocsTab } from './mock/DocsTab';
import { SpreadsheetTab } from './mock/SpreadsheetTab';
import { SlackTab } from './mock/SlackTab';
import { TwitterTab } from './mock/TwitterTab';
import { TicketsTab } from './mock/TicketsTab';
import { SurfacesTab } from './mock/SurfacesTab';

export type TabKey = 'slack' | 'spreadsheet' | 'docs' | 'tweet' | 'tickets' | 'surfaces';

export type EnvironmentMode = 'mock' | 'real';

const CAPTIONS: Record<EnvironmentMode, string> = {
  mock: 'Mock surfaces - when the agent runs a skill, edits land here in real time',
  real: 'Documentation day0 can read, and the connection status of every system it has discovered',
};

/** Tab strip; each sublabel names the content available in that mode. */
const TABS: Array<{
  key: TabKey;
  label: string;
  sublabel: Partial<Record<EnvironmentMode, string>>;
}> = [
  { key: 'slack', label: 'Slack', sublabel: { mock: 'channels + DMs' } },
  { key: 'spreadsheet', label: 'Spreadsheet', sublabel: { mock: 'Q4 Revenue Tracker' } },
  {
    key: 'docs',
    label: 'Docs',
    sublabel: { mock: 'team wiki + how-tos', real: 'linked documentation' },
  },
  { key: 'tweet', label: 'Twitter', sublabel: { mock: 'mentions + drafts' } },
  { key: 'tickets', label: 'Tickets', sublabel: { mock: 'Linear-style queue' } },
  { key: 'surfaces', label: 'Surfaces', sublabel: { real: 'connections + evidence' } },
];

const TAB_KEYS = new Set<string>(TABS.map((tab): TabKey => tab.key));
const AVAILABLE_TAB_KEYS: Record<EnvironmentMode, ReadonlySet<TabKey>> = {
  mock: new Set<TabKey>(['slack', 'spreadsheet', 'docs', 'tweet', 'tickets']),
  real: new Set<TabKey>(['docs', 'surfaces']),
};

function tabIsAvailable(key: TabKey, isReal: boolean): boolean {
  return AVAILABLE_TAB_KEYS[isReal ? 'real' : 'mock'].has(key);
}

/**
 * Read the tab a location hash names.
 *
 * A card link such as `#surfaces` (the awaiting-connection deferral on a work
 * item) must switch the tab, not only scroll, so the hash is honoured on
 * mount and on every `hashchange`. The Surfaces tab exists only in real mode;
 * elsewhere its hash names nothing.
 *
 * Args:
 *   hash: `window.location.hash`, with or without the leading `#`.
 *   isReal: Whether the deployment runs in real mode.
 *
 * Returns:
 *   The tab key the hash names, or undefined when it names no tab.
 */
export function tabFromHash(hash: string, isReal: boolean): TabKey | undefined {
  let key: string;
  try {
    key = decodeURIComponent(hash.replace(/^#/, '')).trim().toLowerCase();
  } catch {
    return undefined;
  }
  if (!TAB_KEYS.has(key)) return undefined;
  const tabKey = key as TabKey;
  return tabIsAvailable(tabKey, isReal) ? tabKey : undefined;
}

/** Keep the selected tab valid as hashes and the resolved deployment mode change. */
export function activeTabForEnvironment(active: TabKey, hash: string, isReal: boolean): TabKey {
  const named = tabFromHash(hash, isReal);
  if (named) return named;
  if (tabIsAvailable(active, isReal)) return active;
  return isReal ? 'docs' : 'slack';
}

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
  const tabs = TABS.filter((tab) => tabIsAvailable(tab.key, isReal));
  const displayedActive = activeTabForEnvironment(active, '', isReal);

  useEffect(() => {
    const follow = (): void => {
      setActive(
        (current): TabKey => activeTabForEnvironment(current, window.location.hash, isReal),
      );
    };
    follow();
    window.addEventListener('hashchange', follow);
    return (): void => window.removeEventListener('hashchange', follow);
  }, [isReal]);

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
            {isReal ? 'Enterprise context' : 'Mock work environment'}
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
          const isActive = displayedActive === t.key;
          const count = counts[t.key];
          const sublabel = t.sublabel[mode];
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
              {sublabel ? (
                <span className="hidden @3xl:inline text-[10px] text-[var(--color-muted)]">
                  {sublabel}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="p-4 min-h-[24rem] max-h-[40rem] overflow-y-auto">
        {displayedActive === 'docs' ? <DocsTab agentId={agentId} mode={mode} /> : null}
        {/* The four below are mock-only, so they are never reached with a real
            deployment mode and take none. */}
        {displayedActive === 'spreadsheet' ? <SpreadsheetTab agentId={agentId} /> : null}
        {displayedActive === 'slack' ? <SlackTab agentId={agentId} /> : null}
        {displayedActive === 'tweet' ? <TwitterTab agentId={agentId} /> : null}
        {displayedActive === 'tickets' ? <TicketsTab agentId={agentId} /> : null}
        {displayedActive === 'surfaces' && isReal ? <SurfacesTab agentId={agentId} /> : null}
      </div>
    </section>
  );
}
