/**
 * A Confluence documentation source's location and reader secret, as the link form, the link's
 * validators and the two readers all read them (wave 15, 15-X).
 *
 * Confluence Cloud is read through Atlassian's gateway as a service account
 * (`https://api.atlassian.com/ex/confluence/<cloud ID>`, decision X-1), so its stored locator is
 * the gateway's address of one space: the cloud ID and the space key, and nothing else. Confluence
 * Data Center is the customer's own server, so its locator is that server's address of one space
 * (`https://<host>[/context]/display/<space key>`), which also opens the space in a browser. Each
 * reads with one token: a service account's scoped API token, or a personal access token.
 */

/** The gateway every Confluence Cloud request goes through. */
export const ATLASSIAN_GATEWAY_HOST = 'api.atlassian.com';

/** One space of a Confluence Cloud site, as the gateway names it. */
export interface ConfluenceCloudLocator {
  readonly cloudId: string;
  readonly spaceKey: string;
}

/** One space of a Confluence Data Center server. */
export interface ConfluenceDataCenterLocator {
  /** The server's address with its context path, no trailing slash: REST paths go under it. */
  readonly base: string;
  readonly spaceKey: string;
}

const CLOUD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A space key: letters and digits alone, or a personal space's `~` and its user's name or id.
 * No dot in a plain key, so a page action (`viewspace.action`) is never read as one.
 */
const SPACE_KEY = /^(?:[A-Za-z0-9]{1,255}|~[A-Za-z0-9][A-Za-z0-9._:@-]{0,253})$/;

const CLOUD_LOCATOR_REFUSAL =
  "A Confluence Cloud location is the site's cloud ID and a space: the space's key, or its " +
  'address as the browser shows it. The cloud ID is the string after /s/ in the address of ' +
  'admin.atlassian.com, not the organisation ID.';

const DATA_CENTER_LOCATOR_REFUSAL =
  "A Confluence Data Center location is a space's address as the browser shows it, over https: " +
  'https://<your server>/display/<space key> or https://<your server>/spaces/<space key>. The ' +
  'address of a single page by its ID does not work.';

/**
 * Parse a Confluence Cloud source's stored locator.
 *
 * @param locator - `https://api.atlassian.com/ex/confluence/<cloud ID>/wiki/spaces/<space key>`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseConfluenceCloudLocator(locator: string): ConfluenceCloudLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(CLOUD_LOCATOR_REFUSAL);
  }
  const [, ex, product, cloudId, wiki, spaces, spaceKey, ...rest] = url.pathname.split('/');
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ATLASSIAN_GATEWAY_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    rest.length > 0 ||
    ex !== 'ex' ||
    product !== 'confluence' ||
    wiki !== 'wiki' ||
    spaces !== 'spaces' ||
    !CLOUD_ID.test(cloudId ?? '') ||
    !SPACE_KEY.test(decodeSegment(spaceKey))
  ) {
    throw new Error(CLOUD_LOCATOR_REFUSAL);
  }
  return { cloudId: cloudId.toLowerCase(), spaceKey: decodeSegment(spaceKey) };
}

/** A path segment decoded, or empty when it is absent or not decodable. */
function decodeSegment(segment: string | undefined): string {
  try {
    return decodeURIComponent(segment ?? '');
  } catch {
    // Not a percent-encoding: no space key spells that, so the caller refuses it.
    return '';
  }
}

/** The space key a site address names: `/wiki/spaces/<key>/...` or `/spaces/<key>/...`. */
function spaceKeyInPath(pathname: string): { key: string; before: string } | undefined {
  const segments = pathname.split('/');
  for (const marker of ['spaces', 'display']) {
    const index = segments.indexOf(marker);
    const key = decodeSegment(segments[index + 1]);
    if (index !== -1 && SPACE_KEY.test(key)) {
      return { key, before: segments.slice(0, index).join('/') };
    }
  }
  return undefined;
}

/**
 * The stored locator for what the link form was given for a Confluence Cloud space.
 *
 * @param cloudId - The site's cloud ID, as IT read it from admin.atlassian.com.
 * @param typed - The space's key, or its address copied from the browser.
 * @returns The locator `parseConfluenceCloudLocator` reads, or the text as typed when it names
 *   no space, for the link to refuse.
 */
export function confluenceCloudLocator(cloudId: string, typed: string): string {
  const text = typed.trim();
  let key: string | undefined = SPACE_KEY.test(text) ? text : undefined;
  if (key === undefined) {
    try {
      key = spaceKeyInPath(new URL(text).pathname)?.key;
    } catch {
      // Neither a key nor an address: the link refuses the text as typed.
    }
  }
  if (key === undefined) return text;
  return `https://${ATLASSIAN_GATEWAY_HOST}/ex/confluence/${cloudId.trim().toLowerCase()}/wiki/spaces/${encodeURIComponent(key)}`;
}

/**
 * Parse a Confluence Data Center source's stored locator.
 *
 * @param locator - `https://<host>[:port][/context]/display/<space key>`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseConfluenceDataCenterLocator(locator: string): ConfluenceDataCenterLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(DATA_CENTER_LOCATOR_REFUSAL);
  }
  const segments = url.pathname.split('/');
  const spaceKey = decodeSegment(segments.at(-1));
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    segments.at(-2) !== 'display' ||
    !SPACE_KEY.test(spaceKey)
  ) {
    throw new Error(DATA_CENTER_LOCATOR_REFUSAL);
  }
  return { base: `${url.origin}${segments.slice(0, -2).join('/')}`, spaceKey };
}

/**
 * The stored locator for a Confluence Data Center space's address as the browser shows it.
 *
 * @param typed - The space's address: `.../display/<key>/...` or `.../spaces/<key>/...`.
 * @returns The locator `parseConfluenceDataCenterLocator` reads, or the text as typed when it
 *   names no space, for the link to refuse.
 */
export function confluenceDataCenterLocator(typed: string): string {
  const text = typed.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const space = spaceKeyInPath(url.pathname);
  if (space === undefined || url.username !== '' || url.password !== '') return text;
  return `${url.origin}${space.before}/display/${encodeURIComponent(space.key)}`;
}

const TOKEN_REFUSAL = 'A Confluence token is one line with no spaces, as Confluence showed it.';

/**
 * Check a Confluence source's reader secret: a service account's API token, or a personal access
 * token.
 *
 * @throws Error when it holds a space; the message never repeats it.
 */
export function checkConfluenceToken(secret: string): void {
  if (!/^\S+$/.test(secret)) throw new Error(TOKEN_REFUSAL);
}
