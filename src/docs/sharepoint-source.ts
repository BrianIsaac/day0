/**
 * A SharePoint documentation source's location and reader secret, as the link form, the link's
 * validators and the reader all read them (wave 15, 15-X).
 *
 * The location is one site's address (`https://<tenant>.sharepoint.com/sites/<site>`), and the
 * site's host names the Microsoft cloud it is in: `sharepoint.com` is the global service,
 * `sharepoint.cn` the one 21Vianet operates in China, each with its own Graph and sign-in hosts
 * (Microsoft's national cloud deployments page; the 21Vianet hosts are a documented option no
 * tenant has checked, V15-2). The reader secret is the app registration IT made, as its tenant
 * ID, its client ID and a client secret joined by colons, stored as one credential.
 */

/** A Microsoft cloud a site can be in. */
export type MicrosoftCloud = 'global' | 'china';

/** Where each cloud's Graph and sign-in answer, and the suffix of its SharePoint hosts. */
export const MICROSOFT_CLOUDS: Readonly<
  Record<MicrosoftCloud, { readonly graph: string; readonly login: string; readonly sites: string }>
> = {
  global: {
    graph: 'graph.microsoft.com',
    login: 'login.microsoftonline.com',
    sites: '.sharepoint.com',
  },
  china: {
    graph: 'microsoftgraph.chinacloudapi.cn',
    login: 'login.chinacloudapi.cn',
    sites: '.sharepoint.cn',
  },
};

/** One SharePoint site, as Graph looks it up: its host and its path on that host. */
export interface SharePointLocator {
  readonly cloud: MicrosoftCloud;
  /** The site's host, `<tenant>.sharepoint.com`. */
  readonly host: string;
  /** The site's path, `/sites/<site>` or `/teams/<site>`; empty for the tenant's root site. */
  readonly path: string;
}

/** The app registration a source reads as. */
export interface SharePointApp {
  readonly tenantId: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

const LOCATOR_REFUSAL =
  "A SharePoint location is a site's address as the browser shows it: " +
  'https://<your tenant>.sharepoint.com/sites/<site>, or the same on sharepoint.cn for the cloud ' +
  '21Vianet operates. The address of a single file or page does not work on its own: use the ' +
  "site's.";

/** The cloud whose SharePoint hosts end as this one does. */
function cloudOfHost(hostname: string): MicrosoftCloud | undefined {
  const host = hostname.toLowerCase();
  return (Object.keys(MICROSOFT_CLOUDS) as MicrosoftCloud[]).find(
    (cloud): boolean =>
      host.endsWith(MICROSOFT_CLOUDS[cloud].sites) &&
      /^[a-z0-9-]+$/.test(host.slice(0, -MICROSOFT_CLOUDS[cloud].sites.length)),
  );
}

/** The site a path is under: `/sites/<site>`, `/teams/<site>`, or the root site for neither. */
function sitePath(pathname: string): string {
  const [, collection, site] = pathname.split('/');
  if ((collection === 'sites' || collection === 'teams') && site) return `/${collection}/${site}`;
  return '';
}

/**
 * Parse a SharePoint source's stored locator.
 *
 * @param locator - `https://<tenant>.sharepoint.com[/sites/<site>]`, or the same on `sharepoint.cn`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseSharePointLocator(locator: string): SharePointLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(LOCATOR_REFUSAL);
  }
  const cloud = cloudOfHost(url.hostname);
  if (
    url.protocol !== 'https:' ||
    cloud === undefined ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname.replace(/\/$/, '') !== sitePath(url.pathname)
  ) {
    throw new Error(LOCATOR_REFUSAL);
  }
  return { cloud, host: url.hostname.toLowerCase(), path: sitePath(url.pathname) };
}

/**
 * The stored locator for an address copied from anywhere in a SharePoint site: a library, a
 * folder, a page.
 *
 * @param typed - What the manager pasted.
 * @returns The site's own address, which `parseSharePointLocator` reads, or the text as typed
 *   when it is not an address on a SharePoint host, for the link to refuse.
 */
export function sharePointLocator(typed: string): string {
  const text = typed.trim();
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  if (cloudOfHost(url.hostname) === undefined || url.username !== '' || url.password !== '') {
    return text;
  }
  return `https://${url.hostname.toLowerCase()}${sitePath(url.pathname)}`;
}

const SECRET_REFUSAL =
  "A SharePoint secret is the app registration's tenant ID, client ID and client secret joined " +
  'by colons, as tenant ID:client ID:client secret, with no spaces.';

/**
 * Join an app registration's values into the source's one reader secret.
 *
 * @param app - The tenant ID, the client ID and the client secret, as IT gave them.
 */
export function sharePointReaderSecret(app: SharePointApp): string {
  return `${app.tenantId.trim()}:${app.clientId.trim()}:${app.clientSecret.trim()}`;
}

/**
 * Split a SharePoint source's reader secret into the app registration's values.
 *
 * @throws Error when it is not three values joined by colons; the message never repeats it.
 */
export function parseSharePointSecret(secret: string): SharePointApp {
  const match = /^([A-Za-z0-9.-]+):([A-Za-z0-9-]+):(\S+)$/.exec(secret);
  if (match === null) throw new Error(SECRET_REFUSAL);
  return { tenantId: match[1], clientId: match[2], clientSecret: match[3] };
}
