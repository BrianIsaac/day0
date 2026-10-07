'use client';

import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { MOCK_OFFICE_SYSTEMS, mockActsAsWords } from '@/surfaces/mock-office';
import type { SurfaceMode } from '@/surfaces/types';
import { DocsTab } from './mock/DocsTab';
import { SpreadsheetTab } from './mock/SpreadsheetTab';
import { SlackTab } from './mock/SlackTab';
import { TwitterTab } from './mock/TwitterTab';
import { TicketsTab } from './mock/TicketsTab';
import { SurfaceCards } from './surfaces/SurfaceCards';
import { PermissionsCard } from './surfaces/PermissionsCard';
import { Card } from '../../components/Card';
import { Columns } from '../../components/Columns';
import { RollingCount } from '../../components/RollingCount';
import { nextTabIndex, tabId } from '../../components/Tabs';
import { ENVIRONMENT_FRAME, PanelLoading } from './PanelLoading';
import {
  activeTabForEnvironment,
  ENVIRONMENT_PANEL_ID,
  tabFromHash,
  type TabKey,
} from './environment-hash';

/** The office's surfaces, one tab each, in the order the office draws them. */
const OFFICE_TABS: ReadonlyArray<{ readonly key: TabKey; readonly label: string }> =
  MOCK_OFFICE_SYSTEMS;

/** What the mock office says of itself beside its title. */
export const OFFICE_CAPTION = 'the seeded workplace this employee works in';

/** The id of the real-mode documentation card, which a `#docs` hash scrolls to. */
const DOCS_CARD_ID = 'docs';

/**
 * The work environment on the Surfaces tab. In mock mode, the seeded office the employee works in
 * (round two section 3.9 and UX 8 (a)): its five surfaces as tabs, opening on Slack, whose count
 * rolls when it changes. In real mode, the cards of the systems it reads and writes, then the
 * documentation it reads and the permissions it holds. A location hash naming a tab (the Slack
 * OAuth redirect's `#surfaces`, a card's link) selects it and scrolls here once.
 *
 * @param agentId - The employee.
 * @param employeeName - The employee's name, which says whom it acts as in each system.
 * @param mode - The deployment's surface mode, as the page read it; undefined while it loads.
 * @param arriving - Whether the page's cards are still arriving (`Columns`).
 */
export function MockEnvironment({
  agentId,
  employeeName,
  mode,
  arriving = false,
}: {
  agentId: Id<'agents'>;
  employeeName: string;
  mode: SurfaceMode | undefined;
  arriving?: boolean;
}) {
  const [active, setActive] = useState<TabKey>('slack');
  const scrolledToHash = useRef(false);

  useEffect(() => {
    // The mode decides which tabs a hash can name; until it resolves, no hash names one.
    if (mode === undefined) return;
    const isReal = mode === 'real';
    const follow = (): void => {
      setActive(
        (current): TabKey => activeTabForEnvironment(current, window.location.hash, isReal),
      );
    };
    follow();
    // A cold load (the Slack OAuth redirect's `#surfaces`) performs its one fragment scroll
    // before this chunk exists, so the first time the hash names a tab, scroll here once; a
    // later hash change finds the panel present and the browser scrolls.
    const named = tabFromHash(window.location.hash, isReal);
    if (!scrolledToHash.current && named) {
      scrolledToHash.current = true;
      document
        .getElementById(isReal && named === 'docs' ? DOCS_CARD_ID : ENVIRONMENT_PANEL_ID)
        ?.scrollIntoView();
    }
    window.addEventListener('hashchange', follow);
    return (): void => window.removeEventListener('hashchange', follow);
  }, [mode]);

  if (mode === undefined) {
    return <PanelLoading label="the work environment" frame={ENVIRONMENT_FRAME} />;
  }
  if (mode === 'real') {
    return (
      <SurfaceCards agentId={agentId} employeeName={employeeName} arriving={arriving}>
        <div id={DOCS_CARD_ID} className="scroll-mt-24">
          <Card title="Documentation it reads">
            <div
              tabIndex={0}
              role="region"
              aria-label="Linked documentation"
              className="@container max-h-[32rem] overflow-y-auto"
            >
              <DocsTab agentId={agentId} mode="real" />
            </div>
          </Card>
        </div>
        <PermissionsCard agentId={agentId} />
      </SurfaceCards>
    );
  }
  return (
    <Columns arriving={arriving}>
      <MockOffice
        agentId={agentId}
        employeeName={employeeName}
        active={active}
        onPick={setActive}
      />
    </Columns>
  );
}

/**
 * The mock office as a card: the product's own Slack shape and the office's other surfaces, a
 * strip of tabs over one panel, the ARIA tabs pattern with the strip one tab stop. Over each
 * surface it says whom the employee acts as there, the same in every one: its own app in this
 * office (the access plan, section 8, the hosted walk's words).
 */
function MockOffice({
  agentId,
  employeeName,
  active,
  onPick,
}: {
  agentId: Id<'agents'>;
  employeeName: string;
  active: TabKey;
  onPick: (key: TabKey) => void;
}) {
  const strip = useRef<HTMLDivElement>(null);
  const docs = useQuery(api.mock.listDocs, { agentId });
  const channels = useQuery(api.mock.listChannels, { agentId });
  const tweets = useQuery(api.mock.listTweets, { agentId });
  const tickets = useQuery(api.mock.listTickets, { agentId });
  const spreadsheets = useQuery(api.mock.listSpreadsheets, { agentId });
  const counts: Partial<Record<TabKey, number>> = {
    slack: channels?.length,
    spreadsheet: spreadsheets?.length,
    docs: docs?.length,
    tweet: tweets?.length,
    tickets: tickets?.length,
  };
  const selected = OFFICE_TABS.find((tab) => tab.key === active) ?? OFFICE_TABS[0];

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number): void {
    const next = nextTabIndex(event.key, index, OFFICE_TABS.length);
    if (next === undefined) return;
    event.preventDefault();
    const tab = OFFICE_TABS[next];
    onPick(tab.key);
    strip.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  }

  return (
    <Card title="Hosted office" meta={OFFICE_CAPTION}>
      {/* The same in every one of the office's systems, so above the strip, not in a tab. */}
      <dl className="mb-4 grid gap-1 text-sm sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4">
        <dt className="text-[13px] text-[var(--color-muted)]">Acts as</dt>
        <dd className="min-w-0 text-[var(--color-fg-2)]">{mockActsAsWords(employeeName)}</dd>
      </dl>
      {/* Wraps rather than scrolls: a strip that overflows hides whole surfaces behind a gesture
          nothing on the page suggests. */}
      <div
        ref={strip}
        role="tablist"
        aria-label="Hosted office"
        className="-mt-1 flex flex-wrap gap-0.5 border-b border-[var(--color-border)]"
      >
        {OFFICE_TABS.map((tab, index) => {
          const current = tab.key === selected.key;
          const count = counts[tab.key];
          return (
            <button
              key={tab.key}
              id={tabId(ENVIRONMENT_PANEL_ID, tab.key)}
              type="button"
              role="tab"
              aria-selected={current}
              aria-controls={current ? ENVIRONMENT_PANEL_ID : undefined}
              tabIndex={current ? 0 : -1}
              onClick={() => onPick(tab.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`-mb-px inline-flex h-11 items-center gap-2 border-b-2 px-3 text-sm font-medium ${
                current
                  ? 'border-[var(--color-accent)] text-[var(--color-fg)]'
                  : 'border-transparent text-[var(--color-muted)] hover:text-[var(--color-fg)]'
              }`}
            >
              {tab.label}
              {count !== undefined ? ' ' : null}
              {count !== undefined ? (
                <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full border border-[var(--color-border)] bg-[var(--color-card)] px-1.5 text-xs font-semibold text-[var(--color-muted)] tabular-nums">
                  <RollingCount value={count} />
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      {/* The panel carries the id the card links name, so `#surfaces` scrolls here as well as
          selecting the tab above. */}
      <div
        id={ENVIRONMENT_PANEL_ID}
        role="tabpanel"
        tabIndex={0}
        aria-labelledby={tabId(ENVIRONMENT_PANEL_ID, selected.key)}
        className="@container mt-4 h-[36rem] scroll-mt-24 overflow-y-auto"
      >
        {selected.key === 'slack' ? <SlackTab agentId={agentId} /> : null}
        {selected.key === 'spreadsheet' ? <SpreadsheetTab agentId={agentId} /> : null}
        {selected.key === 'docs' ? <DocsTab agentId={agentId} mode="mock" /> : null}
        {selected.key === 'tickets' ? <TicketsTab agentId={agentId} /> : null}
        {selected.key === 'tweet' ? <TwitterTab agentId={agentId} /> : null}
      </div>
    </Card>
  );
}
