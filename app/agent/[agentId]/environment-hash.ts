/** The work environment's tabs, as a location hash names them. */
export const ENVIRONMENT_TABS = [
  'slack',
  'spreadsheet',
  'docs',
  'tweet',
  'tickets',
  'surfaces',
] as const;

/** One tab of the work environment. */
export type TabKey = (typeof ENVIRONMENT_TABS)[number];

/** Which office the environment shows: the hosted mock's, or the connections of real mode. */
export type EnvironmentMode = 'mock' | 'real';

/** The id the card links and the Slack OAuth redirect name in their hash. */
export const ENVIRONMENT_PANEL_ID = 'surfaces';

const TAB_KEYS: ReadonlySet<string> = new Set(ENVIRONMENT_TABS);

const AVAILABLE_TAB_KEYS: Record<EnvironmentMode, ReadonlySet<TabKey>> = {
  mock: new Set<TabKey>(['slack', 'spreadsheet', 'docs', 'tweet', 'tickets']),
  real: new Set<TabKey>(['docs', 'surfaces']),
};

/**
 * Whether the environment shows a tab in this mode.
 *
 * @param key - The tab.
 * @param isReal - Whether the deployment runs in real mode.
 */
export function tabIsAvailable(key: TabKey, isReal: boolean): boolean {
  return AVAILABLE_TAB_KEYS[isReal ? 'real' : 'mock'].has(key);
}

/** The environment tab a hash spells, in either mode, or undefined when it spells none. */
function environmentTabOf(hash: string): TabKey | undefined {
  let key: string;
  try {
    key = decodeURIComponent(hash.replace(/^#/, '')).trim().toLowerCase();
  } catch {
    // A malformed escape names no tab; the page ignores it as the browser does.
    return undefined;
  }
  return TAB_KEYS.has(key) ? (key as TabKey) : undefined;
}

/**
 * Read the tab a location hash names.
 *
 * A card link such as `#surfaces` (the awaiting-connection deferral on a work
 * item) must switch the tab as well as scroll to the panel that carries the
 * id, so the hash is honoured on mount and on every `hashchange`. The
 * Surfaces tab exists only in real mode; elsewhere its hash names nothing.
 *
 * Args:
 *   hash: `window.location.hash`, with or without the leading `#`.
 *   isReal: Whether the deployment runs in real mode.
 *
 * Returns:
 *   The tab key the hash names, or undefined when it names no tab.
 */
export function tabFromHash(hash: string, isReal: boolean): TabKey | undefined {
  const tabKey = environmentTabOf(hash);
  return tabKey !== undefined && tabIsAvailable(tabKey, isReal) ? tabKey : undefined;
}

/** Keep the selected tab valid as hashes and the resolved deployment mode change. */
export function activeTabForEnvironment(active: TabKey, hash: string, isReal: boolean): TabKey {
  const named = tabFromHash(hash, isReal);
  if (named) return named;
  if (tabIsAvailable(active, isReal)) return active;
  return isReal ? 'docs' : 'slack';
}

/**
 * Whether a hash is addressed to the work environment on the Surfaces tab: the panel's own id
 * (`#surfaces`, which the Slack OAuth redirect and the cards' links carry) or one of its tabs, in
 * either mode. The employee page's shell sends such a hash to the Surfaces tab, where the panel
 * selects the tab and scrolls to itself.
 *
 * @param hash - `window.location.hash`, with or without the leading `#`.
 */
export function addressesEnvironment(hash: string): boolean {
  return environmentTabOf(hash) !== undefined;
}
