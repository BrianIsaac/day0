/**
 * A Feishu documentation source's location and reader secret, as the link form,
 * the link's validators and the reader all read them.
 *
 * The region is the locator's host (`open.feishu.cn` for Feishu,
 * `open.larksuite.com` for Lark), and what the source reads is its path: a
 * wiki space by its numeric ID or a Drive folder by its token. The reader
 * secret is the app's ID and secret joined by a colon, stored as one
 * credential (`docSources.credentialId`).
 */

/** The open platform's host in each region. */
export const FEISHU_REGIONS = {
  feishu: 'open.feishu.cn',
  lark: 'open.larksuite.com',
} as const;

/** Feishu (mainland China) or Lark (everywhere else). */
export type FeishuRegion = keyof typeof FEISHU_REGIONS;

/** Where a page opens in a browser, by region: the tenant's own site redirects from here. */
export const BROWSER_HOSTS: Readonly<Record<FeishuRegion, string>> = {
  feishu: 'feishu.cn',
  lark: 'larksuite.com',
};

/** A wiki space, by its numeric ID. */
export interface FeishuWikiScope {
  readonly kind: 'wiki';
  readonly spaceId: string;
}

/** A Drive folder, by its token, read with the folders under it. */
export interface FeishuFolderScope {
  readonly kind: 'folder';
  readonly folderToken: string;
}

/** A Feishu source's stored location: its region, that region's host, and what it reads. */
export interface FeishuLocator {
  readonly region: FeishuRegion;
  readonly host: string;
  readonly scope: FeishuWikiScope | FeishuFolderScope;
}

/** The app a source reads as. */
export interface FeishuApp {
  readonly appId: string;
  readonly appSecret: string;
}

const SPACE_ID = /^\d{1,32}$/;
const FOLDER_TOKEN = /^[A-Za-z0-9]{8,64}$/;

const LOCATOR_REFUSAL =
  "A Feishu location is a wiki space's ID (the number at the end of the address of the " +
  "space's Settings page) or a Drive folder's address as the browser shows it; the address of " +
  'a single wiki page does not work.';

/** The region whose open platform host this is. */
function regionOfHost(host: string): FeishuRegion | undefined {
  return (Object.keys(FEISHU_REGIONS) as FeishuRegion[]).find(
    (region) => FEISHU_REGIONS[region] === host,
  );
}

/**
 * Parse a Feishu source's stored locator.
 *
 * @param locator - `https://<region host>/wiki/spaces/<space ID>` or
 *   `https://<region host>/drive/folders/<folder token>`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseFeishuLocator(locator: string): FeishuLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(LOCATOR_REFUSAL);
  }
  const region = regionOfHost(url.hostname);
  if (
    url.protocol !== 'https:' ||
    region === undefined ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== ''
  ) {
    throw new Error(LOCATOR_REFUSAL);
  }
  const [, area, kind, id, ...rest] = url.pathname.split('/');
  if (rest.length === 0 && area === 'wiki' && kind === 'spaces' && SPACE_ID.test(id ?? '')) {
    return { region, host: url.hostname, scope: { kind: 'wiki', spaceId: id } };
  }
  if (rest.length === 0 && area === 'drive' && kind === 'folders' && FOLDER_TOKEN.test(id ?? '')) {
    return { region, host: url.hostname, scope: { kind: 'folder', folderToken: id } };
  }
  throw new Error(LOCATOR_REFUSAL);
}

/** The region a tenant site's host is in, or undefined for a host of neither. */
function linkRegion(hostname: string): FeishuRegion | undefined {
  const host = hostname.toLowerCase();
  if (host === 'feishu.cn' || host.endsWith('.feishu.cn')) return 'feishu';
  if (host === 'larksuite.com' || host.endsWith('.larksuite.com')) return 'lark';
  return undefined;
}

/**
 * The stored locator for what the link form was given: a space ID, a folder
 * token, or a link copied from the tenant's site to a wiki space (its page or
 * its settings) or a Drive folder. A copied link's own host names its region
 * (`*.feishu.cn` or `*.larksuite.com`), whatever the form's choice; a bare ID
 * or token takes the form's.
 *
 * @param region - The region the form names.
 * @param typed - What the manager typed.
 * @returns The locator `parseFeishuLocator` reads, or the text as typed when it is none of those,
 *   for the link to refuse.
 */
export function feishuLocator(region: FeishuRegion, typed: string): string {
  const text = typed.trim();
  const space = (host: string, id: string): string => `https://${host}/wiki/spaces/${id}`;
  const folder = (host: string, token: string): string => `https://${host}/drive/folders/${token}`;
  if (SPACE_ID.test(text)) return space(FEISHU_REGIONS[region], text);
  if (FOLDER_TOKEN.test(text)) return folder(FEISHU_REGIONS[region], text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const host = FEISHU_REGIONS[linkRegion(url.hostname) ?? region];
  const [, area, kind, id = '', ...rest] = url.pathname.replace(/\/$/, '').split('/');
  if (rest.length > 0) return text;
  if (area === 'wiki' && ['space', 'spaces', 'settings'].includes(kind) && SPACE_ID.test(id)) {
    return space(host, id);
  }
  if (area === 'drive' && ['folder', 'folders'].includes(kind) && FOLDER_TOKEN.test(id)) {
    return folder(host, id);
  }
  return text;
}

const SECRET_REFUSAL =
  'A Feishu secret is the app ID and the app secret joined by a colon, as app ID:app secret, ' +
  'with no spaces.';

/**
 * Join an app's ID and secret into the source's one reader secret.
 *
 * @param appId - The app's ID, `cli_...`.
 * @param appSecret - The app's secret.
 */
export function feishuReaderSecret(appId: string, appSecret: string): string {
  return `${appId.trim()}:${appSecret.trim()}`;
}

/**
 * Split a Feishu source's reader secret into the app's ID and secret.
 *
 * @throws Error when it is not an ID and a secret joined by a colon; the message never repeats it.
 */
export function parseFeishuSecret(secret: string): FeishuApp {
  const match = /^([^:\s]+):(\S+)$/.exec(secret);
  if (match === null) throw new Error(SECRET_REFUSAL);
  return { appId: match[1], appSecret: match[2] };
}
