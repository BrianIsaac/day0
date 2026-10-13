/**
 * A documentation library of any size, answered in-process as SharePoint (through Microsoft
 * Graph), Confluence Cloud, Confluence Data Center and Google Drive each answer their reader.
 *
 * The fixtures beside this file are a handful of pages written out by hand; this is a library a
 * test names a size for (a thousand pages), whose pages a test edits, renames or archives between
 * two syncs, and whose requests are counted by what each one is: a token, a lookup, a listing, or
 * a page's body. **Its answers are generated in the shapes each vendor's published reference
 * prints (the same references `provider.json` names); nothing was recorded from a tenant and no
 * vendor host is called** (RM16). A listing answers only the fields it is asked for where the
 * API has a field selection (`$select`, `fields`), so a reader that forgets to ask for a field
 * does not get it. The token, the site, the space and the folder are answered by the provider's
 * own fixtures (`fake.ts`), with the checks they make.
 */
import { providerFake, type ProviderFakeOptions } from './fake';

/** The providers a library is answered as. */
export type LibraryKind = 'sharepoint' | 'confluence-v2' | 'confluence-dc' | 'drive';

/** One page of a library, as a test changes it. */
export interface LibraryPage {
  /** Its place in the library, from 0: the provider's id is made from it. */
  readonly index: number;
  title: string;
  /** The name its address is made from; a rename moves it. */
  slug: string;
  /** Its body: one paragraph. */
  text: string;
  /** How many times its content was edited; the provider's revision is made from it. */
  edits: number;
  /** How many times it was renamed: SharePoint's `eTag` moves with it, its `cTag` does not. */
  renames: number;
  /** When it was last edited, as an ISO time; undefined for a source that gives no date. */
  editedAt: string | undefined;
  /** Archived at its source (Confluence), in the bin (Drive), or checked out (a SharePoint page). */
  archived: boolean;
  /** Whether the listing names a revision for it. */
  listsRevision: boolean;
}

/** What a request to the library was for. */
export type LibraryRequestKind = 'token' | 'lookup' | 'listing' | 'body';

/** One request the library answered. */
export interface LibraryRequest {
  readonly method: string;
  readonly url: URL;
  readonly kind: LibraryRequestKind;
  /** How many pages' bodies the answer carried. */
  readonly bodies: number;
  readonly status: number;
}

/** What a test gives a library. */
export interface LibraryOptions extends Pick<ProviderFakeOptions, 'publicKey'> {
  /** How many pages the library holds. */
  readonly pages: number;
  /**
   * SharePoint only: how many of the library's last pages are site pages; the rest are Markdown
   * files in the document library. None by default.
   */
  readonly sitePages?: number;
  /**
   * SharePoint only: false for a library whose delta sends no `cTag`, as Graph's reference says
   * OneDrive for Business does on a create or a modify. True by default.
   */
  readonly contentTags?: boolean;
  /**
   * Fields every listing leaves out of each entry though it is asked for them, as a service that
   * does not answer a field under a selection would. None by default.
   */
  readonly withheld?: readonly string[];
}

/** What a library counted of the requests it answered. */
export interface LibraryCounts {
  readonly token: number;
  readonly lookup: number;
  readonly listing: number;
  /** Requests for one page's body, or for several pages' bodies by id. */
  readonly body: number;
  /** Pages' bodies carried by every answer, a listing's among them. */
  readonly bodies: number;
}

/** A library and the hands a test changes it with. */
export interface LibraryFake {
  readonly fetch: (input: URL | string | Request, init?: RequestInit) => Promise<Response>;
  readonly requests: LibraryRequest[];
  readonly pages: LibraryPage[];
  /** Edit a page's content: its revision and its edit time move. */
  edit(index: number): void;
  /** Rename a page, its content untouched: its title and address move, its revision does not. */
  rename(index: number, title: string): void;
  /** Archive a page at its source, its content untouched: its revision does not move. */
  archive(index: number): void;
  /** What the requests answered so far were for. */
  counts(): LibraryCounts;
  /** Forget the requests answered so far, so the next sync's are counted alone. */
  reset(): void;
}

/** What one route answers, and what the request was for. */
interface Answer {
  readonly kind: LibraryRequestKind;
  readonly bodies: number;
  readonly response: Response;
}

/** A request as a route reads it. */
interface Asked {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
}

/** A provider's routes over a library: an answer, or undefined for the fixtures to answer. */
type Routes = (asked: Asked) => Answer | undefined;

const SITE_ID =
  'acme.sharepoint.com,2c712604-1370-44e7-a1f5-426573fda7bb,2d2244c3-251a-49ea-93c8-39e1c3a060fe';
const DRIVE_ID = 'b!BCZxLHATNESh9UJlc_2nu8NEIi0aJepJk8g54cOgYP5';
const GRAPH = 'https://graph.microsoft.com';
const SHAREPOINT = 'https://acme.sharepoint.com';
const CLOUD_ID = '1a11d016-8984-4c3e-b9ab-142dd06acb1b';
const CLOUD_SPACE_ID = '1048578';
const CLOUD_BASE = 'https://acme.atlassian.net/wiki';
const SERVER_BASE = 'https://wiki.acme.corp/confluence';
const DRIVE_ROOT = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

/** The first edit time of the library's first page; each page after it is a minute later. */
const FIRST_EDIT = Date.UTC(2026, 8, 1, 0, 0, 0);

/** When an edit a test makes is dated: after every page's first edit. */
const LATER_EDIT = Date.UTC(2026, 9, 12, 0, 0, 0);

/** A JSON answer. */
function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

/** A refusal in a provider's own error shape, close enough for a reader's wording. */
function refused(status: number, message: string): Response {
  return json({ error: { code: String(status), message }, message }, status);
}

/** The pages a library starts with. */
function newPages(count: number): LibraryPage[] {
  return Array.from(
    { length: count },
    (_unused, index): LibraryPage => ({
      index,
      title: `Runbook ${index}`,
      slug: `runbook-${String(index).padStart(5, '0')}`,
      text: `Step ${index}: refresh the pipeline tile, then tell the channel.`,
      edits: 0,
      renames: 0,
      editedAt: new Date(FIRST_EDIT + index * 60_000).toISOString(),
      archived: false,
      listsRevision: true,
    }),
  );
}

/** A slice of a listing and where the next begins, or undefined at its end. */
function window<Item>(
  items: readonly Item[],
  offset: number,
  size: number,
): { readonly taken: readonly Item[]; readonly next: number | undefined } {
  const taken = items.slice(offset, offset + size);
  const end = offset + taken.length;
  return { taken, next: end < items.length ? end : undefined };
}

/**
 * A listed entry with only the fields a selection names, and its id, as Graph answers a
 * `$select`, less the fields the library withholds from every listing.
 */
function selected(
  item: Record<string, unknown>,
  select: string | null,
  withheld: readonly string[] = [],
): Record<string, unknown> {
  const names = select === null ? undefined : new Set(['id', ...select.split(',')]);
  return Object.fromEntries(
    Object.entries(item).filter(
      ([name]) => (names === undefined || names.has(name)) && !withheld.includes(name),
    ),
  );
}

/** A whole number a query names, or the fallback. */
function numberOf(value: string | null, fallback: number): number {
  const parsed = Number(value);
  return value !== null && Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

/** The offset a continuation this library made stands for, or undefined for any other. */
function offsetOf(token: string | null): number | undefined {
  const match = /^lib\.(\d+)$/.exec(token ?? '');
  return match === null ? undefined : Number(match[1]);
}

/** The SharePoint routes: the library's delta and its downloads, the site's pages and each page. */
function sharePointRoutes(pages: readonly LibraryPage[], options: LibraryOptions): Routes {
  const sitePages = Math.min(options.sitePages ?? 0, pages.length);
  const files = pages.slice(0, pages.length - sitePages);
  const sitePageList = pages.slice(pages.length - sitePages);
  const guid = (page: LibraryPage): string =>
    `0a1b2c3d-0000-4000-8000-${String(page.index).padStart(12, '0')}`;
  const fileId = (page: LibraryPage): string => `01LIB${String(page.index).padStart(6, '0')}`;
  const parent = { driveId: DRIVE_ID, driveType: 'documentLibrary' };
  const fileItem = (page: LibraryPage): Record<string, unknown> => ({
    id: fileId(page),
    name: `${page.slug}.md`,
    webUrl: `${SHAREPOINT}/sites/Runbooks/Shared%20Documents/${page.slug}.md`,
    ...(options.contentTags !== false && page.listsRevision
      ? { cTag: `"c:{${guid(page).toUpperCase()}},${page.edits}"` }
      : {}),
    // The item's own tag moves with a rename too, as the reference says an eTag does.
    ...(page.listsRevision
      ? { eTag: `"{${guid(page).toUpperCase()}},${page.edits + page.renames}"` }
      : {}),
    size: page.text.length + 1,
    createdDateTime: '2026-06-02T08:00:00Z',
    ...(page.editedAt === undefined ? {} : { lastModifiedDateTime: page.editedAt }),
    parentReference: { ...parent, id: '01ROOT', path: '/drive/root:' },
    file: { mimeType: 'text/markdown' },
  });
  const root = {
    id: '01ROOT',
    name: 'root',
    folder: { childCount: files.length },
    root: {},
    webUrl: `${SHAREPOINT}/sites/Runbooks/Shared%20Documents`,
    parentReference: parent,
  };
  const pageItem = (page: LibraryPage): Record<string, unknown> => ({
    id: guid(page),
    name: `${page.slug}.aspx`,
    webUrl: `${SHAREPOINT}/sites/Runbooks/SitePages/${page.slug}.aspx`,
    title: page.title,
    pageLayout: 'article',
    createdDateTime: '2026-06-02T08:00:00Z',
    ...(page.editedAt === undefined ? {} : { lastModifiedDateTime: page.editedAt }),
    ...(page.listsRevision ? { eTag: `"{${guid(page).toUpperCase()}},${page.edits}"` } : {}),
    publishingState: {
      level: page.archived ? 'checkout' : 'published',
      versionId: `${page.edits + 1}.0`,
    },
  });
  const sitePath = `/v1.0/sites/${SITE_ID}`;
  return (asked): Answer | undefined => {
    const { url } = asked;
    const path = decodeURIComponent(url.pathname);
    const query = url.searchParams;
    if (url.origin === SHAREPOINT && path === '/sites/Runbooks/_layouts/15/download.aspx') {
      const page = files.find((file) => fileId(file) === query.get('UniqueId'));
      if (page === undefined) return { kind: 'body', bodies: 0, response: refused(404, 'gone') };
      return {
        kind: 'body',
        bodies: 1,
        // No heading: the file is titled by its name, so a rename moves its title and address.
        response: new Response(`${page.text}\n`, {
          status: 200,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      };
    }
    if (url.origin !== GRAPH) return undefined;
    if (asked.authorization !== 'Bearer fixture-graph-token') return undefined;
    if (path === `${sitePath}/drive/root/delta`) {
      const select = query.get('$select');
      const size = numberOf(query.get('$top'), 200);
      const { taken, next } = window([root, ...files], offsetOf(query.get('token')) ?? 0, size);
      const link = new URL(`${GRAPH}${sitePath}/drive/root/delta`);
      link.searchParams.set('$top', String(size));
      if (select !== null) link.searchParams.set('$select', select);
      link.searchParams.set('token', `lib.${next ?? 'end'}`);
      return {
        kind: 'listing',
        bodies: 0,
        response: json({
          value: taken.map((item) =>
            'folder' in item ? item : selected(fileItem(item), select, options.withheld),
          ),
          [next === undefined ? '@odata.deltaLink' : '@odata.nextLink']: link.href,
        }),
      };
    }
    const content = new RegExp(`^/v1\\.0/drives/${DRIVE_ID}/items/([^/]+)/content$`).exec(path);
    if (content !== null) {
      const location = new URL(`${SHAREPOINT}/sites/Runbooks/_layouts/15/download.aspx`);
      location.searchParams.set('UniqueId', content[1]);
      location.searchParams.set('tempauth', 'fixture-preauthenticated');
      return {
        kind: 'body',
        bodies: 0,
        response: new Response(null, { status: 302, headers: { location: location.href } }),
      };
    }
    if (path === `${sitePath}/pages/microsoft.graph.sitePage`) {
      const select = query.get('$select');
      const size = numberOf(query.get('$top'), 200);
      const { taken, next } = window(sitePageList, offsetOf(query.get('$skiptoken')) ?? 0, size);
      const link = new URL(`${GRAPH}${sitePath}/pages/microsoft.graph.sitePage`);
      link.searchParams.set('$top', String(size));
      if (select !== null) link.searchParams.set('$select', select);
      link.searchParams.set('$skiptoken', `lib.${next ?? 'end'}`);
      return {
        kind: 'listing',
        bodies: 0,
        response: json({
          value: taken.map((page) => selected(pageItem(page), select, options.withheld)),
          ...(next === undefined ? {} : { '@odata.nextLink': link.href }),
        }),
      };
    }
    const detail = /\/pages\/([^/]+)\/microsoft\.graph\.sitePage$/.exec(path);
    if (detail !== null && path.startsWith(sitePath)) {
      const page = sitePageList.find((each) => guid(each) === detail[1]);
      if (page === undefined) return { kind: 'body', bodies: 0, response: refused(404, 'gone') };
      return {
        kind: 'body',
        bodies: 1,
        response: json({
          ...pageItem(page),
          canvasLayout: {
            horizontalSections: [
              {
                columns: [
                  {
                    webparts: [
                      {
                        '@odata.type': '#microsoft.graph.textWebPart',
                        innerHtml: `<p>${page.text}</p>`,
                      },
                    ],
                  },
                ],
              },
            ],
          },
        }),
      };
    }
    return undefined;
  };
}

/** The Confluence Cloud routes: the space's listing, and pages asked for by id. */
function confluenceCloudRoutes(pages: readonly LibraryPage[]): Routes {
  const idOf = (page: LibraryPage): string => String(100_000 + page.index);
  const item = (page: LibraryPage, body: boolean): Record<string, unknown> => ({
    id: idOf(page),
    status: page.archived ? 'archived' : 'current',
    title: page.title,
    spaceId: CLOUD_SPACE_ID,
    ...(page.listsRevision || body
      ? {
          version: {
            number: page.edits + 1,
            ...(page.editedAt === undefined ? {} : { createdAt: page.editedAt }),
          },
        }
      : {}),
    ...(body
      ? { body: { storage: { representation: 'storage', value: `<p>${page.text}</p>` } } }
      : {}),
    _links: { webui: `/spaces/OPS/pages/${idOf(page)}/${page.slug}` },
  });
  const api = `/ex/confluence/${CLOUD_ID}/wiki/api/v2`;
  return (asked): Answer | undefined => {
    const { url } = asked;
    if (url.origin !== 'https://api.atlassian.com') return undefined;
    if (asked.authorization !== 'Bearer fixture-confluence-token') return undefined;
    const query = url.searchParams;
    const bodies = query.get('body-format') === 'storage';
    if (url.pathname === `${api}/spaces/${CLOUD_SPACE_ID}/pages`) {
      const size = Math.min(numberOf(query.get('limit'), 25), 250);
      const { taken, next } = window(pages, offsetOf(query.get('cursor')) ?? 0, size);
      const link = new URL(`https://api.atlassian.com${url.pathname}`);
      for (const [name, value] of query) {
        if (name !== 'cursor') link.searchParams.append(name, value);
      }
      link.searchParams.set('cursor', `lib.${next ?? 'end'}`);
      const links = [`<${CLOUD_BASE}>; rel="base"`];
      if (next !== undefined) links.unshift(`<${link.pathname}${link.search}>; rel="next"`);
      return {
        kind: 'listing',
        bodies: bodies ? taken.length : 0,
        response: json(
          { results: taken.map((page) => item(page, bodies)), _links: { base: CLOUD_BASE } },
          200,
          { link: links.join(', ') },
        ),
      };
    }
    if (url.pathname === `${api}/pages`) {
      const ids = new Set((query.get('id') ?? '').split(',').filter((id) => id !== ''));
      if (ids.size === 0 || ids.size > 250) {
        return { kind: 'body', bodies: 0, response: refused(400, 'id names 1 to 250 pages') };
      }
      const size = Math.min(numberOf(query.get('limit'), 25), 250);
      const found = pages.filter((page) => ids.has(idOf(page))).slice(0, size);
      return {
        kind: 'body',
        bodies: bodies ? found.length : 0,
        response: json({
          results: found.map((page) => item(page, bodies)),
          _links: { base: CLOUD_BASE },
        }),
      };
    }
    return undefined;
  };
}

/** The Confluence Data Center routes: the two walks of the space, and one page by id. */
function confluenceServerRoutes(pages: readonly LibraryPage[]): Routes {
  const idOf = (page: LibraryPage): string => String(4_600_000 + page.index);
  const item = (page: LibraryPage, expand: readonly string[]): Record<string, unknown> => ({
    id: idOf(page),
    type: 'page',
    status: page.archived ? 'archived' : 'current',
    title: page.title,
    ...(expand.includes('version') && (page.listsRevision || expand.includes('body.storage'))
      ? {
          version: {
            number: page.edits + 1,
            ...(page.editedAt === undefined ? {} : { when: page.editedAt }),
          },
        }
      : {}),
    ...(expand.includes('body.storage')
      ? { body: { storage: { representation: 'storage', value: `<p>${page.text}</p>` } } }
      : {}),
    _links: { webui: `/display/OPS/${page.slug}` },
  });
  return (asked): Answer | undefined => {
    const { url } = asked;
    if (url.origin !== 'https://wiki.acme.corp') return undefined;
    if (asked.authorization !== 'Bearer fixture-confluence-pat') return undefined;
    const query = url.searchParams;
    const expand = (query.get('expand') ?? '').split(',');
    const status = query.get('status') ?? 'current';
    if (url.pathname === '/confluence/rest/api/content') {
      if (query.get('spaceKey') !== 'OPS' || query.get('type') !== 'page') return undefined;
      const walked = pages.filter((page) => page.archived === (status === 'archived'));
      const start = numberOf(query.get('start'), 0);
      const size = numberOf(query.get('limit'), 25);
      const { taken, next } = window(walked, start, size);
      const carried = expand.includes('body.storage');
      return {
        kind: 'listing',
        bodies: carried ? taken.length : 0,
        response: json({
          results: taken.map((page) => item(page, expand)),
          start,
          limit: size,
          size: taken.length,
          _links: {
            base: SERVER_BASE,
            context: '/confluence',
            ...(next === undefined
              ? {}
              : { next: `/rest/api/content?spaceKey=OPS&start=${next}&limit=${size}` }),
          },
        }),
      };
    }
    const one = /^\/confluence\/rest\/api\/content\/(\d+)$/.exec(url.pathname);
    if (one !== null) {
      // A page is found under the status it has, as the reference's `status` filter reads.
      const page = pages.find(
        (each) => idOf(each) === one[1] && each.archived === (status === 'archived'),
      );
      if (page === undefined) return { kind: 'body', bodies: 0, response: refused(404, 'gone') };
      return {
        kind: 'body',
        bodies: expand.includes('body.storage') ? 1 : 0,
        response: json(item(page, expand)),
      };
    }
    return undefined;
  };
}

/** The Google Drive routes: the folder's listing and each document's export. */
function driveRoutes(pages: readonly LibraryPage[]): Routes {
  const idOf = (page: LibraryPage): string => `1LibDoc${String(page.index).padStart(26, '0')}`;
  const file = (page: LibraryPage): Record<string, unknown> => ({
    id: idOf(page),
    name: page.title,
    mimeType: 'application/vnd.google-apps.document',
    trashed: page.archived,
    ...(page.listsRevision ? { version: String(page.edits + 1) } : {}),
    ...(page.editedAt === undefined ? {} : { modifiedTime: page.editedAt }),
    webViewLink: `https://docs.google.com/document/d/${idOf(page)}/edit?usp=drivesdk`,
  });
  return (asked): Answer | undefined => {
    const { url } = asked;
    if (url.origin !== 'https://www.googleapis.com') return undefined;
    if (asked.authorization !== 'Bearer fixture-google-token') return undefined;
    const query = url.searchParams;
    if (url.pathname === '/drive/v3/files') {
      if (!(query.get('q') ?? '').startsWith(`'${DRIVE_ROOT}' in parents`)) return undefined;
      const wanted = /files\(([^)]*)\)/.exec(query.get('fields') ?? '')?.[1] ?? null;
      const size = numberOf(query.get('pageSize'), 100);
      const { taken, next } = window(pages, offsetOf(query.get('pageToken')) ?? 0, size);
      return {
        kind: 'listing',
        bodies: 0,
        response: json({
          kind: 'drive#fileList',
          incompleteSearch: false,
          ...(next === undefined ? {} : { nextPageToken: `lib.${next}` }),
          files: taken.map((page) => selected(file(page), wanted)),
        }),
      };
    }
    const exported = /^\/drive\/v3\/files\/([^/]+)\/export$/.exec(url.pathname);
    if (exported !== null) {
      const page = pages.find((each) => idOf(each) === exported[1]);
      if (page === undefined) return { kind: 'body', bodies: 0, response: refused(404, 'gone') };
      return {
        kind: 'body',
        bodies: 1,
        response: new Response(`${page.text}\n`, {
          status: 200,
          headers: { 'content-type': 'text/markdown' },
        }),
      };
    }
    return undefined;
  };
}

/** The routes of each provider over a library. */
function routesFor(kind: LibraryKind, pages: LibraryPage[], options: LibraryOptions): Routes {
  switch (kind) {
    case 'sharepoint':
      return sharePointRoutes(pages, options);
    case 'confluence-v2':
      return confluenceCloudRoutes(pages);
    case 'confluence-dc':
      return confluenceServerRoutes(pages);
    case 'drive':
      return driveRoutes(pages);
  }
}

/**
 * A fetch that answers as one provider does for a library of the size named.
 *
 * @param kind - The provider the library is answered as.
 * @param options - Its size, and for SharePoint its site pages and whether its delta sends `cTag`.
 * @returns The fetch, the requests it answered by what each was for, and the hands to change a
 *   page between two syncs.
 */
export function libraryFake(kind: LibraryKind, options: LibraryOptions): LibraryFake {
  const pages = newPages(options.pages);
  const routes = routesFor(kind, pages, options);
  const fixtures = providerFake(kind, { publicKey: options.publicKey });
  const requests: LibraryRequest[] = [];
  const fetch = async (input: URL | string | Request, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET';
    const url = new URL(input instanceof Request ? input.url : input);
    const authorization = new Headers(init.headers).get('authorization') ?? undefined;
    const answered = method === 'GET' ? routes({ method, url, authorization }) : undefined;
    if (answered !== undefined) {
      requests.push({
        method,
        url,
        kind: answered.kind,
        bodies: answered.bodies,
        status: answered.response.status,
      });
      return answered.response;
    }
    // The token, the site, the space and the folder: the provider's own fixtures, with their checks.
    const response = await fixtures.fetch(input, init);
    requests.push({
      method,
      url,
      kind: method === 'POST' ? 'token' : 'lookup',
      bodies: 0,
      status: response.status,
    });
    return response;
  };
  const page = (index: number): LibraryPage => {
    const found = pages[index];
    if (found === undefined) throw new Error(`the library has no page ${index}`);
    return found;
  };
  return {
    fetch,
    requests,
    pages,
    edit: (index: number): void => {
      const edited = page(index);
      edited.edits += 1;
      edited.text = `${edited.text} Edited ${edited.edits}.`;
      if (edited.editedAt !== undefined) {
        edited.editedAt = new Date(LATER_EDIT + edited.edits * 3_600_000).toISOString();
      }
    },
    rename: (index: number, title: string): void => {
      const renamed = page(index);
      renamed.renames += 1;
      renamed.title = title;
      renamed.slug = title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
    },
    archive: (index: number): void => {
      page(index).archived = true;
    },
    counts: (): LibraryCounts => {
      const of = (wanted: LibraryRequestKind): number =>
        requests.filter((request) => request.kind === wanted).length;
      return {
        token: of('token'),
        lookup: of('lookup'),
        listing: of('listing'),
        body: of('body'),
        bodies: requests.reduce((total, request) => total + request.bodies, 0),
      };
    },
    reset: (): void => {
      requests.length = 0;
    },
  };
}
