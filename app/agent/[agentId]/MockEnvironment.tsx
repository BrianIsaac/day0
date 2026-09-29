'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DocsTab } from './mock/DocsTab';
import { SpreadsheetTab } from './mock/SpreadsheetTab';
import { SlackTab } from './mock/SlackTab';
import { TwitterTab } from './mock/TwitterTab';
import { TicketsTab } from './mock/TicketsTab';
import { SurfaceCards } from './surfaces/SurfaceCards';
import { RollingCount } from '../../components/RollingCount';
import {
  activeTabForEnvironment,
  ENVIRONMENT_PANEL_ID,
  tabFromHash,
  tabIsAvailable,
  type EnvironmentMode,
  type TabKey,
} from './environment-hash';

const CAPTIONS: Record<EnvironmentMode, string> = {
  mock: 'Mock surfaces - when the employee runs a skill, edits land here in real time',
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

/**
 * The office the employee works in, on the Surfaces tab: the hosted mock's five surfaces, or in
 * real mode the documentation it reads and its connections, one tab each, with a count that rolls
 * when it changes. A location hash naming a tab selects it and scrolls here once.
 */
export function MockEnvironment({ agentId }: { agentId: Id<'agents'> }) {
  const [active, setActive] = useState<TabKey>('slack');
  const scrolledToHash = useRef(false);

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
    // A cold load (the Slack OAuth redirect's `#surfaces`) performs its one
    // fragment scroll while the dashboard still reads "loading employee", before
    // this panel exists, and the Surfaces tab is named only once the mode has
    // resolved. So the first time the hash names a tab, scroll here once; a
    // later hash change finds the panel present and the browser scrolls.
    if (!scrolledToHash.current && tabFromHash(window.location.hash, isReal)) {
      scrolledToHash.current = true;
      document.getElementById(ENVIRONMENT_PANEL_ID)?.scrollIntoView();
    }
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
          it hid here - Twitter and Tickets - are two fifths of the environment
          the agent works in. */}
      <nav
        aria-label="Work environment"
        className="flex flex-wrap gap-1 px-2 pt-2 border-b border-[var(--color-border)]"
      >
        {tabs.map((t) => {
          const isActive = displayedActive === t.key;
          const count = counts[t.key];
          const sublabel = t.sublabel[mode];
          return (
            <button
              key={t.key}
              type="button"
              aria-pressed={isActive}
              onClick={() => setActive(t.key)}
              className={`min-h-11 px-3 py-2 rounded-t-md text-xs flex items-center gap-1.5 transition border-b-2 ${
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
                  <RollingCount value={count} />
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

      {/* The panel carries the id the card links name, so `#surfaces` scrolls
          here as well as selecting the tab above. */}
      <div
        id={ENVIRONMENT_PANEL_ID}
        tabIndex={0}
        role="region"
        aria-label={`${tabs.find((tab) => tab.key === displayedActive)?.label ?? 'Environment'} tab`}
        className="p-4 min-h-[24rem] max-h-[40rem] overflow-y-auto"
      >
        {displayedActive === 'docs' ? <DocsTab agentId={agentId} mode={mode} /> : null}
        {/* The four below are mock-only, so they are never reached with a real
            deployment mode and take none. */}
        {displayedActive === 'spreadsheet' ? <SpreadsheetTab agentId={agentId} /> : null}
        {displayedActive === 'slack' ? <SlackTab agentId={agentId} /> : null}
        {displayedActive === 'tweet' ? <TwitterTab agentId={agentId} /> : null}
        {displayedActive === 'tickets' ? <TicketsTab agentId={agentId} /> : null}
        {displayedActive === 'surfaces' && isReal ? <SurfaceCards agentId={agentId} /> : null}
      </div>
    </section>
  );
}
