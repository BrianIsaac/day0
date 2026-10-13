import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError } from '../../../../src/docs/readers/batch';
import { ConfluenceCloudReader } from '../../../../src/docs/readers/confluence-v2';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  fixtureJsonWithout,
  providerFake,
  type FakeOverride,
  type FakeRequest,
} from '../../../fixtures/readers/fake';
import { libraryFake, type LibraryFake } from '../../../fixtures/readers/library';
import { readWhole, storedIn, type StoredMarks } from '../../../fixtures/readers/stored';

/** 10 October 2026, 09:00 UTC: the clock every test starts at. */
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

const TOKEN = 'fixture-confluence-token';
const CLOUD_ID = '1a11d016-8984-4c3e-b9ab-142dd06acb1b';

const space: DocSourceRecord = {
  _id: 'jd7confluencecloud01' as Id<'docSources'>,
  label: 'Operations wiki',
  kind: 'confluence-v2',
  locator: `https://api.atlassian.com/ex/confluence/${CLOUD_ID}/wiki/spaces/OPS`,
};

/** A reader on the fixture site with a clock that moves only when the reader waits. */
function readerOnSite(override?: FakeOverride): {
  reader: ConfluenceCloudReader;
  requests: FakeRequest[];
  sleeps: number[];
} {
  let clock = T0;
  const sleeps: number[] = [];
  const site = providerFake('confluence-v2', { now: (): number => clock, override });
  const reader = new ConfluenceCloudReader({
    fetch: site.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reader, requests: site.requests, sleeps };
}

/** Every batch of the space, three pages at a time. */
async function wholeSpace(reader: ConfluenceCloudReader): Promise<{
  pages: Awaited<ReturnType<ConfluenceCloudReader['listPageBatch']>>['pages'];
  unread: Awaited<ReturnType<ConfluenceCloudReader['listPageBatch']>>['unread'];
  batches: number;
}> {
  const pages = [];
  const unread = [];
  let cursor: string | undefined;
  let batches = 0;
  do {
    const batch = await reader.listPageBatch(space, TOKEN, cursor, 3);
    pages.push(...batch.pages);
    unread.push(...batch.unread);
    cursor = batch.nextCursor;
    batches += 1;
  } while (cursor !== undefined);
  return { pages, unread, batches };
}

/** A JSON answer a test puts in place of the fixture's. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

describe('the Confluence Cloud documentation reader', (): void => {
  it("follows the Link header's cursor to the end of the space, asking for current and archived pages", async (): Promise<void> => {
    const { reader, requests } = readerOnSite();
    const { pages, unread, batches } = await wholeSpace(reader);
    expect(batches).toBe(2);
    expect(pages.map((page) => page.ref)).toEqual(['98311', '98312', '98313', '98314', '98316']);
    expect(unread.map((page) => page.ref)).toEqual(['98315']);
    const listings = requests.filter((request) =>
      request.url.pathname.endsWith('/spaces/1048578/pages'),
    );
    expect(listings.map((request) => request.url.searchParams.get('cursor'))).toEqual([
      null,
      'fixture-cursor-2',
    ]);
    for (const listing of listings) {
      expect(listing.url.host).toBe('api.atlassian.com');
      expect(listing.url.pathname).toBe(
        `/ex/confluence/${CLOUD_ID}/wiki/api/v2/spaces/1048578/pages`,
      );
      expect(listing.url.searchParams.getAll('status')).toEqual(['current', 'archived']);
      // Re-pinned for wave 17 (X-2): the listing carries no body; the pages are asked for by id.
      expect(listing.url.searchParams.has('body-format')).toBe(false);
      expect(listing.url.searchParams.get('sort')).toBe('id');
      expect(listing.url.searchParams.get('limit')).toBe('3');
      expect(listing.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const byId = requests.filter((request) =>
      request.url.pathname.endsWith(`/ex/confluence/${CLOUD_ID}/wiki/api/v2/pages`),
    );
    expect(byId.map((request) => Object.fromEntries(request.url.searchParams))).toEqual([
      { id: '98311,98312,98313', status: 'archived', 'body-format': 'storage', limit: '3' },
      { id: '98314,98315,98316', status: 'archived', 'body-format': 'storage', limit: '3' },
    ]);
    expect(byId.every((request) => request.authorization === `Bearer ${TOKEN}`)).toBe(true);
    // The space's id is looked up once, and carried in the cursor after that.
    expect(requests.filter((request) => request.url.pathname.endsWith('/spaces'))).toHaveLength(1);
  });

  it('reads a page as Markdown under its title, with its table, its code and its address', async (): Promise<void> => {
    const { reader } = readerOnSite();
    const [close] = (await reader.listPageBatch(space, TOKEN, undefined, 3)).pages;
    expect(close).toMatchObject({
      sourceId: space._id,
      ref: '98311',
      title: 'Close the quarter',
      url: 'https://acme.atlassian.net/wiki/spaces/OPS/pages/98311',
      updatedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
    });
    expect(close.markdown).toBe(
      [
        '# Close the quarter',
        '## Before you start',
        '> **Warning: Tell finance**\n> \n> Post in **#finance-close** before step 1.',
        '## Steps',
        '| Step | Owner |\n| --- | --- |\n| Lock the ledger | Finance |\n| Refresh the pipeline tile | RevOps |',
        '```bash\nday0 close --quarter Q3\n# then check the tile\n```',
        'See Escalation paths when a step fails.',
      ].join('\n\n'),
    );
  });

  it("captures each page's version number as its revision", async (): Promise<void> => {
    const { reader } = readerOnSite();
    const { pages } = await wholeSpace(reader);
    expect(pages.map((page) => [page.ref, page.sourceRevision])).toEqual([
      ['98311', '7'],
      ['98312', '3'],
      ['98313', '2'],
      ['98314', '1'],
      ['98316', '12'],
    ]);
  });

  it('says an archived page is archived, and says nothing of a current one', async (): Promise<void> => {
    const { reader } = readerOnSite();
    const { pages } = await wholeSpace(reader);
    expect(pages.find((page) => page.ref === '98312')?.nativeStatus).toBe('archived');
    for (const page of pages.filter((each) => each.ref !== '98312')) {
      expect(page).not.toHaveProperty('nativeStatus');
    }
  });

  it('names a page Confluence gives no storage body for unread, with its reason', async (): Promise<void> => {
    const { reader } = readerOnSite();
    const { unread } = await wholeSpace(reader);
    expect(unread).toEqual([
      {
        ref: '98315',
        reason:
          'Confluence gave no body in its storage format for "Quarter board", so Day0 does not read it.',
      },
    ]);
  });

  it('keeps two pages titled with no Latin character distinct', async (): Promise<void> => {
    const { reader } = readerOnSite();
    const { pages } = await wholeSpace(reader);
    const chinese = pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['运维手册', '刷新看板']);
    expect(chinese[1].markdown).toBe('# 刷新看板\n\n每周一上午刷新管道看板。');
    expect(new Set(chinese.map((page) => mirroredDocSlug(space._id, page.ref))).size).toBe(2);
  });

  it('waits the seconds Retry-After names on a 429 and on a 503, then reads on', async (): Promise<void> => {
    const answered = new Set<string>();
    const { reader, sleeps } = readerOnSite((request) => {
      const which = request.url.pathname.endsWith('/spaces') ? 'spaces' : 'pages';
      if (answered.has(which)) return undefined;
      answered.add(which);
      return which === 'spaces'
        ? json(429, { code: 429, message: 'Rate limit exceeded' }, { 'retry-after': '7' })
        : new Response('Service Unavailable', { status: 503, headers: { 'retry-after': '3' } });
    });
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 3);
    expect(sleeps).toEqual([7_000, 3_000]);
    expect(batch.pages).toHaveLength(3);
  });

  it('fails the batch on a limit that outlasts its waits, rather than any page', async (): Promise<void> => {
    const { reader } = readerOnSite((request) =>
      request.url.pathname.endsWith('/pages')
        ? json(429, { code: 429, message: 'Rate limit exceeded' }, { 'retry-after': '1' })
        : undefined,
    );
    await expect(reader.listPageBatch(space, TOKEN, undefined, 3)).rejects.toThrow(
      'Confluence was rate limited (HTTP 429).',
    );
  });

  it('says what IT does when the token is refused, and never repeats the token', async (): Promise<void> => {
    const { reader } = readerOnSite();
    let message = '';
    try {
      await reader.listPageBatch(space, 'not-the-fixture-token', undefined, 3);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Confluence refused the API token this source uses (HTTP 401): it may have expired (a token lasts a year at most) or been revoked. Ask IT to create a new API token for the service account with the scopes reader-confluence.md lists, then use Rotate on the source's row to enter it.",
    );
    expect(message).not.toContain('not-the-fixture-token');
  });

  it('says what IT checks when the service account may not view the space', async (): Promise<void> => {
    const { reader } = readerOnSite((request) =>
      request.url.pathname.endsWith('/pages')
        ? json(403, { code: 403, message: 'Forbidden' })
        : undefined,
    );
    await expect(reader.listPageBatch(space, TOKEN, undefined, 3)).rejects.toThrow(
      'Confluence refused this request for the service account (HTTP 403): ask IT to check that its API token has the scopes reader-confluence.md lists (read:space:confluence and read:page:confluence), that the service account has access to Confluence, and that it may view the space.',
    );
  });

  it('names the cloud ID when the gateway finds no site, and the key when the site has no such space', async (): Promise<void> => {
    const wrongSite = readerOnSite((request) =>
      request.url.pathname.endsWith('/spaces') ? json(404, { code: 404 }) : undefined,
    );
    await expect(wrongSite.reader.listPageBatch(space, TOKEN, undefined, 3)).rejects.toThrow(
      'Atlassian found no Confluence site with this cloud ID (HTTP 404)',
    );
    const { reader } = readerOnSite();
    await expect(
      reader.listPageBatch(
        { ...space, locator: space.locator.replace(/OPS$/, 'NONE') },
        TOKEN,
        undefined,
        3,
      ),
    ).rejects.toThrow(
      'Confluence found no space with the key "NONE" that the service account may view: check the key, and ask IT to give the service account View permission in the space.',
    );
  });

  it("reads a proxy's page as something in between, never as a page's refusal", async (): Promise<void> => {
    const { reader } = readerOnSite(
      () => new Response('<html><body>Blocked by policy</body></html>', { status: 403 }),
    );
    await expect(reader.listPageBatch(space, TOKEN, undefined, 3)).rejects.toThrow(
      "api.atlassian.com answered HTTP 403 with a page that is not Confluence's own answer, so something between Day0 and Confluence (a proxy or a firewall) may be stopping the request: ask IT whether the machine Day0 runs on reaches api.atlassian.com directly.",
    );
  });

  it('says the host could not be reached when nothing answers, with what IT allows', async (): Promise<void> => {
    const reader = new ConfluenceCloudReader({
      fetch: async (): Promise<Response> => {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.atlassian.com'), {
            code: 'ENOTFOUND',
          }),
        });
      },
    });
    await expect(reader.listPageBatch(space, TOKEN, undefined, 3)).rejects.toThrow(
      "Day0 could not reach api.atlassian.com: getaddrinfo ENOTFOUND api.atlassian.com. The machine Day0's backend runs on must reach api.atlassian.com directly over HTTPS, with no proxy in between: ask IT to allow it.",
    );
  });

  it('starts the space again when Confluence no longer honours a cursor an earlier batch kept', async (): Promise<void> => {
    const { reader } = readerOnSite((request) =>
      request.url.searchParams.get('cursor') === 'fixture-cursor-2'
        ? json(400, { errors: [{ status: 400, title: 'Invalid cursor' }] })
        : undefined,
    );
    const first = await reader.listPageBatch(space, TOKEN, undefined, 3);
    await expect(reader.listPageBatch(space, TOKEN, first.nextCursor, 3)).rejects.toThrow(
      ListingChangedError,
    );
    await expect(reader.listPageBatch(space, TOKEN, '25@abc1234', 3)).rejects.toThrow(
      ListingChangedError,
    );
  });

  it('refuses to read without its token', async (): Promise<void> => {
    const { reader, requests } = readerOnSite();
    await expect(reader.listPageBatch(space, undefined, undefined, 3)).rejects.toThrow(
      "A Confluence Cloud source reads with a service account's API token, and this one has none",
    );
    expect(requests).toEqual([]);
  });

  it('names a page nested too deeply to convert unread, and reads the pages beside it (W15-R9)', async (): Promise<void> => {
    // Reader 3's poison.mts: two good pages and one of 3,000 nested divs in one window.
    const good = (id: string): unknown => ({
      id,
      title: `Good ${id}`,
      status: 'current',
      body: { storage: { value: '<p>fine</p>' } },
      version: { number: 1 },
    });
    const deep = `${'<div>'.repeat(3_000)}x${'</div>'.repeat(3_000)}`;
    const { reader } = readerOnSite((request) =>
      request.url.pathname.endsWith('/pages')
        ? json(200, {
            results: [
              good('1'),
              { ...(good('2') as object), title: 'Poison', body: { storage: { value: deep } } },
              good('3'),
            ],
          })
        : undefined,
    );
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual(['1', '3']);
    expect(batch.unread).toEqual([
      {
        ref: '2',
        reason:
          '"Poison" is not read: it is laid out too deeply for Day0 to convert: lists, tables or quotations inside one another, many levels down.',
      },
    ]);
  });

  it('asks for fewer pages when a window of them is more than it reads of one answer, and loses none (W15-R11)', async (): Promise<void> => {
    // Reader 3's big.mts: 13 pages of 3.9 MiB in one 25-page window are past the 48 MiB bound.
    const body = `<p>${'y'.repeat(Math.floor(3.9 * 1024 * 1024))}</p>`;
    const { reader, requests } = readerOnSite((request) => {
      if (!request.url.pathname.endsWith('/pages')) return undefined;
      const page = (id: string, withBody: boolean): unknown => ({
        id,
        title: `P${id}`,
        status: 'current',
        ...(withBody ? { body: { storage: { value: body } } } : {}),
        version: { number: 1 },
      });
      // Wave 17 (X-2): the pages asked for by id come with their bodies; the listing has none.
      const ids = request.url.searchParams.get('id');
      if (ids !== null) return json(200, { results: ids.split(',').map((id) => page(id, true)) });
      const limit = Number(request.url.searchParams.get('limit'));
      const from = Number(request.url.searchParams.get('cursor') ?? 0);
      const results = Array.from({ length: Math.min(limit, 13 - from) }, (_unused, index) =>
        page(String(from + index + 1), false),
      );
      const next = from + results.length;
      return json(
        200,
        { results },
        next < 13 ? { link: `</wiki/api/v2/spaces/1048578/pages?cursor=${next}>; rel="next"` } : {},
      );
    });
    const first = await reader.listPageBatch(space, TOKEN, undefined, 25);
    expect(first.pages.map((page) => page.ref)).toEqual(
      Array.from({ length: 12 }, (_unused, index) => String(index + 1)),
    );
    expect(first.unread).toEqual([]);
    expect(first.nextCursor).toBe('v2|1048578|12');
    const second = await reader.listPageBatch(space, TOKEN, first.nextCursor, 25);
    expect(second.pages.map((page) => page.ref)).toEqual(['13']);
    expect(second.nextCursor).toBeUndefined();
    const asked = requests
      .filter((request) => request.url.pathname.endsWith('/spaces/1048578/pages'))
      .map((request) => request.url.searchParams.get('limit'));
    expect(asked).toEqual(['25', '12', '25']);
    // Each window's pages are asked for by id once: the thirteen that were too many, then twelve.
    const byId = requests
      .filter((request) => request.url.searchParams.has('id'))
      .map((request) => request.url.searchParams.get('limit'));
    expect(byId).toEqual(['13', '12', '1']);
  }, 60_000);

  it('names a single page past what it reads of one answer unread, from a listing without its body (W15-R11)', async (): Promise<void> => {
    const huge = 'z'.repeat(49 * 1024 * 1024);
    const { reader, requests } = readerOnSite((request) => {
      if (!request.url.pathname.endsWith('/pages')) return undefined;
      const seven = (withBody: boolean): unknown => ({
        id: '7',
        title: 'Everything we ever wrote',
        status: 'current',
        ...(withBody ? { body: { storage: { value: huge } } } : {}),
        version: { number: 4 },
      });
      const eight = (withBody: boolean): unknown => ({
        id: '8',
        title: 'After it',
        status: 'current',
        ...(withBody ? { body: { storage: { value: '<p>fine</p>' } } } : {}),
        version: { number: 1 },
      });
      // Wave 17 (X-2): a page asked for by id comes with its body; the listing has none.
      const id = request.url.searchParams.get('id');
      if (id !== null) return json(200, { results: [id === '7' ? seven(true) : eight(true)] });
      const from = request.url.searchParams.get('cursor');
      return json(
        200,
        { results: [from === null ? seven(false) : eight(false)] },
        from === null
          ? { link: '</wiki/api/v2/spaces/1048578/pages?cursor=after-7>; rel="next"' }
          : {},
      );
    });
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 1);
    expect(batch.pages).toEqual([]);
    expect(batch.unread).toEqual([
      {
        ref: '7',
        reason:
          '"Everything we ever wrote" is larger than the 4 MiB Day0 converts of one Confluence page.',
      },
    ]);
    expect(batch.nextCursor).toBe('v2|1048578|after-7');
    // Re-pinned for wave 17 (X-2): the listing has no body to be too large; the page asked for by
    // id is, and being one page it is named unread there.
    const asked = requests.filter((request) => request.url.pathname.endsWith('/pages'));
    expect(asked.map((request) => request.url.searchParams.get('body-format'))).toEqual([
      null,
      'storage',
    ]);
    const after = await reader.listPageBatch(space, TOKEN, batch.nextCursor, 1);
    expect(after.pages.map((page) => page.ref)).toEqual(['8']);
  }, 60_000);
});

describe("a Confluence Cloud page's date (wave 17, D-8)", (): void => {
  it("says a page is dated by its source when Confluence gives its version's time", async (): Promise<void> => {
    const { reader } = readerOnSite();
    const { pages } = await wholeSpace(reader);
    expect(pages.map((page) => page.datedBySource)).toEqual([true, true, true, true, true]);
  });

  it('says a page with no date from its source is dated by the read: datedBySource false', async (): Promise<void> => {
    const { reader } = readerOnSite((request) => {
      if (request.url.searchParams.has('cursor')) return undefined;
      return request.url.searchParams.has('id')
        ? json(200, fixtureJsonWithout('confluence-v2', 'pages-by-id.json', 'createdAt'))
        : json(200, fixtureJsonWithout('confluence-v2', 'pages-1.json', 'createdAt'));
    });
    const { pages } = await reader.listPageBatch(space, TOKEN, undefined, 3);
    expect(pages.map((page) => [page.ref, page.updatedAt, page.datedBySource])).toEqual([
      ['98311', T0, false],
      ['98312', T0, false],
      ['98313', T0, false],
    ]);
  });
});

/** A reader on a generated library, its clock still. */
function readerOnLibrary(library: LibraryFake): ConfluenceCloudReader {
  return new ConfluenceCloudReader({
    fetch: library.fetch,
    now: (): number => T0,
    sleep: async (): Promise<void> => undefined,
  });
}

/** The ref of a library's page by its place in the library. */
const libraryRef = (index: number): string => String(100_000 + index);

/** The requests that asked for pages by id, as the ids each named. */
function askedById(library: LibraryFake): string[][] {
  return library.requests
    .filter((request) => request.url.pathname.endsWith('/wiki/api/v2/pages'))
    .map((request) => (request.url.searchParams.get('id') ?? '').split(','));
}

describe('the Confluence Cloud reader contract by revision (wave 17, 17-X)', (): void => {
  it("reads a thousand unchanged pages for the listing's requests and no body request, and one changed page alone", async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 1_000 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, space, TOKEN, marks);
    expect(first.read).toHaveLength(1_000);
    expect(library.counts().bodies).toBe(1_000);

    library.reset();
    const unchanged = await readWhole(reader, space, TOKEN, marks);
    expect(unchanged.read).toEqual([]);
    expect(unchanged.kept).toHaveLength(1_000);
    // Forty listing pages of 25, none with a body, and the space looked up once.
    expect(library.counts()).toEqual({ token: 0, lookup: 1, listing: 40, body: 0, bodies: 0 });

    library.edit(500);
    library.reset();
    const edited = await readWhole(reader, space, TOKEN, marks);
    expect(edited.read.map((page) => [page.ref, page.sourceRevision])).toEqual([
      [libraryRef(500), '2'],
    ]);
    expect(edited.read[0].markdown).toContain('Edited 1.');
    expect(edited.kept).toHaveLength(999);
    expect(library.counts()).toEqual({ token: 0, lookup: 1, listing: 40, body: 1, bodies: 1 });
    expect(askedById(library)).toEqual([[libraryRef(500)]]);
  });

  it('lists without bodies, and asks the changed ids of a listing page in one request (X-2)', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 60 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    for (const listing of library.requests.filter((request) => request.kind === 'listing')) {
      expect(listing.url.searchParams.has('body-format')).toBe(false);
      expect(listing.bodies).toBe(0);
    }
    // Nothing stored: each listing page's 25 ids, then the last ten, one request each.
    expect(askedById(library).map((ids) => ids.length)).toEqual([25, 25, 10]);

    // Three pages of the first listing page and one of the third changed: two requests.
    for (const index of [2, 9, 24, 55]) library.edit(index);
    library.reset();
    const edited = await readWhole(reader, space, TOKEN, marks);
    expect(edited.read.map((page) => page.ref)).toEqual([2, 9, 24, 55].map(libraryRef));
    expect(askedById(library)).toEqual([[2, 9, 24].map(libraryRef), [libraryRef(55)]]);
    const [byId] = library.requests.filter((request) => request.kind === 'body');
    expect(byId.url.searchParams.get('body-format')).toBe('storage');
    expect(byId.url.searchParams.getAll('status')).toEqual(['current', 'archived']);
    expect(byId.url.searchParams.get('limit')).toBe('3');
    // The contract is asked once a listing page, by every page it lists.
    expect(edited.asked.map((refs) => refs.length)).toEqual([25, 25, 10]);
  });

  it('reads a page the listing gives no revision for as before, at every sync', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 30 });
    library.pages[3].listsRevision = false;
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    for (const sync of [2, 3]) {
      const again = await readWhole(reader, space, TOKEN, marks);
      expect(
        again.read.map((page) => page.ref),
        `sync ${sync}`,
      ).toEqual([libraryRef(3)]);
      expect(again.kept).toHaveLength(29);
    }
  });

  it('reads a renamed page, though its revision is the stored one', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 30 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    library.rename(7, 'Close the quarter');
    const renamed = await readWhole(reader, space, TOKEN, marks);
    expect(renamed.read.map((page) => [page.ref, page.title, page.sourceRevision])).toEqual([
      [libraryRef(7), 'Close the quarter', '1'],
    ]);
    expect(renamed.kept).toHaveLength(29);
    // Once stored under its new title and address, it is kept again.
    expect((await readWhole(reader, space, TOKEN, marks)).read).toEqual([]);
  });

  it('keeps a page archived at its source and unchanged, and marks it archived', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 30 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    library.archive(12);
    library.reset();
    const after = await readWhole(reader, space, TOKEN, marks);
    expect(after.read).toEqual([]);
    expect(library.counts().body).toBe(0);
    expect(after.kept.find((page) => page.ref === libraryRef(12))).toEqual({
      ref: libraryRef(12),
      nativeStatus: 'archived',
      datedBySource: true,
    });
    expect(after.kept.find((page) => page.ref === libraryRef(11))).toEqual({
      ref: libraryRef(11),
      datedBySource: true,
    });
  });

  it('reads a page whose listing says no status, since a kept page takes its status from the listing', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 4, withheld: ['status'] });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    const again = await readWhole(reader, space, TOKEN, marks);
    expect(again.read).toHaveLength(4);
    expect(again.kept).toEqual([]);
  });

  it('names a changed page that is gone when its body is asked for unread, and reads the rest', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 5 });
    // Listed, then deleted before its body was asked for: the answer by id leaves it out.
    const reader = new ConfluenceCloudReader({
      fetch: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input);
        const ids = url.searchParams.get('id');
        if (ids !== null) {
          url.searchParams.set(
            'id',
            ids
              .split(',')
              .filter((id) => id !== libraryRef(1))
              .join(','),
          );
        }
        return await library.fetch(url, init);
      },
      now: (): number => T0,
      sleep: async (): Promise<void> => undefined,
    });
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 25, storedIn(new Map()));
    expect(batch.pages.map((page) => page.ref)).toEqual([0, 2, 3, 4].map(libraryRef));
    expect(batch.unread).toEqual([
      {
        ref: libraryRef(1),
        reason: '"Runbook 1" was deleted or moved in Confluence after it was listed.',
      },
    ]);
  });

  it('says a kept page with no date from its source was dated by the read, and reads as before with no contract to ask', async (): Promise<void> => {
    const library = libraryFake('confluence-v2', { pages: 3 });
    library.pages[1].editedAt = undefined;
    const reader = readerOnLibrary(library);
    const plain = await reader.listPageBatch(space, TOKEN, undefined, 25);
    expect(plain.pages).toHaveLength(3);
    expect(plain).not.toHaveProperty('kept');
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    const kept = (await readWhole(reader, space, TOKEN, marks)).kept;
    expect(kept.map((page) => page.datedBySource)).toEqual([true, false, true]);
  });
});
