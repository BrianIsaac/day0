import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { ConfluenceDataCenterReader } from '../../../../src/docs/readers/confluence-dc';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  fixtureJsonWithout,
  providerFake,
  type FakeOverride,
  type FakeRequest,
} from '../../../fixtures/readers/fake';
import { libraryFake, type LibraryFake } from '../../../fixtures/readers/library';
import { readWhole, type StoredMarks } from '../../../fixtures/readers/stored';

const TOKEN = 'fixture-confluence-pat';

const space: DocSourceRecord = {
  _id: 'jd7confluencedc00001' as Id<'docSources'>,
  label: 'Operations wiki',
  kind: 'confluence-dc',
  locator: 'https://wiki.acme.corp/confluence/display/OPS',
};

/** A reader on the fixture server with a clock that moves only when the reader waits. */
function readerOnServer(override?: FakeOverride): {
  reader: ConfluenceDataCenterReader;
  requests: FakeRequest[];
  sleeps: number[];
} {
  let clock = Date.UTC(2026, 9, 10, 9, 0, 0);
  const sleeps: number[] = [];
  const server = providerFake('confluence-dc', { now: (): number => clock, override });
  const reader = new ConfluenceDataCenterReader({
    fetch: server.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reader, requests: server.requests, sleeps };
}

/** Every batch of the space, two pages at a time. */
async function wholeSpace(
  reader: ConfluenceDataCenterReader,
): Promise<{ pages: ReadPageBatch['pages']; unread: ReadPageBatch['unread'][number][] }> {
  const pages: ReadPageBatch['pages'] = [];
  const unread: ReadPageBatch['unread'][number][] = [];
  let cursor: string | undefined;
  do {
    const batch = await reader.listPageBatch(space, TOKEN, cursor, 2);
    pages.push(...batch.pages);
    unread.push(...batch.unread);
    cursor = batch.nextCursor;
  } while (cursor !== undefined);
  return { pages, unread };
}

/** A JSON answer a test puts in place of the fixture's. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The listings a run asked for, as the status and the start it named. */
function listings(requests: readonly FakeRequest[]): string[] {
  return requests
    .filter((request) => request.url.pathname.endsWith('/rest/api/content'))
    .map(
      (request) =>
        `${request.url.searchParams.get('status')}@${request.url.searchParams.get('start')}`,
    );
}

describe('the Confluence Data Center documentation reader', (): void => {
  it('walks the space by start to its end, then asks for its archived pages', async (): Promise<void> => {
    const { reader, requests } = readerOnServer();
    const { pages, unread } = await wholeSpace(reader);
    expect(pages.map((page) => page.ref)).toEqual(['4587521', '4587522', '4587524', '4587530']);
    expect(unread.map((page) => page.ref)).toEqual(['4587523']);
    expect(listings(requests)).toEqual(['current@0', 'current@2', 'archived@0']);
    for (const request of requests) {
      expect(request.url.origin).toBe('https://wiki.acme.corp');
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }
    const [first] = requests.filter((request) => request.url.pathname.endsWith('/content'));
    expect(first.url.pathname).toBe('/confluence/rest/api/content');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      spaceKey: 'OPS',
      type: 'page',
      status: 'current',
      // Re-pinned for wave 17 (17-X): the listing carries no body; a page is read by its id.
      expand: 'version',
      start: '0',
      limit: '2',
    });
    // Each listed page read by its id, under the status of the walk that listed it.
    expect(
      requests
        .filter((request) => /\/rest\/api\/content\/\d+$/.test(request.url.pathname))
        .map(
          (request) =>
            `${request.url.pathname.split('/').pop()} ${request.url.searchParams.get('status')} ${request.url.searchParams.get('expand')}`,
        ),
    ).toEqual([
      '4587521 current body.storage,version',
      '4587522 current body.storage,version',
      '4587523 current body.storage,version',
      '4587524 current body.storage,version',
      '4587530 archived body.storage,version',
    ]);
    // The space is checked once, before the first listing.
    expect(requests.filter((request) => request.url.pathname.endsWith('/space/OPS'))).toHaveLength(
      1,
    );
  });

  it('reads a page through the storage converter, with its revision and its address on the server', async (): Promise<void> => {
    const { reader } = readerOnServer();
    const [close] = (await reader.listPageBatch(space, TOKEN, undefined, 2)).pages;
    expect(close).toMatchObject({
      sourceId: space._id,
      ref: '4587521',
      title: 'Close the quarter',
      url: 'https://wiki.acme.corp/confluence/pages/viewpage.action?pageId=4587521',
      updatedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
      sourceRevision: '7',
    });
    expect(close).not.toHaveProperty('nativeStatus');
    expect(close.markdown).toBe(
      [
        '# Close the quarter',
        '## Steps',
        '| Step | Owner |\n| --- | --- |\n| Lock the ledger | Finance |',
        '```bash\nday0 close --quarter Q3\n```',
      ].join('\n\n'),
    );
  });

  it('says an archived page is archived, where the server lists them', async (): Promise<void> => {
    const { reader } = readerOnServer();
    const { pages } = await wholeSpace(reader);
    expect(pages.find((page) => page.ref === '4587530')).toMatchObject({
      title: 'Escalation paths (2024)',
      nativeStatus: 'archived',
      sourceRevision: '3',
    });
  });

  it('reads the current pages and ends the walk where the server refuses the archived status (V15-1b)', async (): Promise<void> => {
    const { reader, requests } = readerOnServer((request) =>
      request.url.searchParams.get('status') === 'archived'
        ? json(400, { statusCode: 400, message: 'Unknown status: archived' })
        : undefined,
    );
    const { pages, unread } = await wholeSpace(reader);
    expect(pages.map((page) => page.ref)).toEqual(['4587521', '4587522', '4587524']);
    expect(unread.map((page) => page.ref)).toEqual(['4587523']);
    expect(listings(requests)).toEqual(['current@0', 'current@2', 'archived@0']);
  });

  it('marks nothing archived where the server ignores the status and lists its current pages again (second pass)', async (): Promise<void> => {
    // A server that does not know `status=archived` may answer its current pages, not a refusal.
    const fake = providerFake('confluence-dc');
    const reader = new ConfluenceDataCenterReader({
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.searchParams.get('status') === 'archived')
          url.searchParams.set('status', 'current');
        return await fake.fetch(url, init);
      },
    });
    const { pages } = await wholeSpace(reader);
    expect(pages.map((page) => page.ref)).toEqual(['4587521', '4587522', '4587524']);
    expect(pages.every((page) => page.nativeStatus === undefined)).toBe(true);
  });

  it('keeps the current pages where the token is refused the archived pages alone (second pass)', async (): Promise<void> => {
    const { reader } = readerOnServer((request) =>
      request.url.searchParams.get('status') === 'archived'
        ? json(403, { statusCode: 403, message: 'Forbidden' })
        : undefined,
    );
    const { pages } = await wholeSpace(reader);
    expect(pages.map((page) => page.ref)).toEqual(['4587521', '4587522', '4587524']);
  });

  it('says the walk of its archived pages was refused, so the pages an earlier walk archived stand (W15-R30)', async (): Promise<void> => {
    // The review: a 4xx on that walk ended it, and the finish pruned the pages archived before.
    const { reader } = readerOnServer((request) =>
      request.url.searchParams.get('status') === 'archived'
        ? json(403, { statusCode: 403, message: 'Forbidden' })
        : undefined,
    );
    const said: boolean[] = [];
    let cursor: string | undefined;
    do {
      const batch = await reader.listPageBatch(space, TOKEN, cursor, 3);
      said.push(batch.archivedWalkRefused === true);
      cursor = batch.nextCursor;
    } while (cursor !== undefined);
    expect(said.at(-1)).toBe(true);
    expect(said.slice(0, -1).every((each) => !each)).toBe(true);
  });

  it('names a page the server gives no storage body for unread, and keeps two Chinese titles apart', async (): Promise<void> => {
    const { reader } = readerOnServer();
    const { pages, unread } = await wholeSpace(reader);
    expect(unread).toEqual([
      {
        ref: '4587523',
        reason:
          'Confluence gave no body in its storage format for "Quarter board", so Day0 does not read it.',
      },
    ]);
    const chinese = pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['运维手册', '刷新看板']);
    expect(new Set(chinese.map((page) => mirroredDocSlug(space._id, page.ref))).size).toBe(2);
  });

  it('waits the seconds Retry-After names on a 429 and on a 503, then reads on', async (): Promise<void> => {
    const answered = new Set<string>();
    const { reader, sleeps } = readerOnServer((request) => {
      const which = request.url.pathname.endsWith('/space/OPS') ? 'space' : 'content';
      if (answered.has(which)) return undefined;
      answered.add(which);
      return which === 'space'
        ? json(429, { statusCode: 429, message: 'Rate limit exceeded' }, { 'retry-after': '5' })
        : new Response('', { status: 503, headers: { 'retry-after': '2' } });
    });
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 2);
    expect(sleeps).toEqual([5_000, 2_000]);
    expect(batch.pages).toHaveLength(2);
  });

  it('says who makes a new token when the server refuses this one, and never repeats it', async (): Promise<void> => {
    const { reader } = readerOnServer();
    let message = '';
    try {
      await reader.listPageBatch(space, 'not-the-fixture-pat', undefined, 2);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Confluence refused the personal access token this source uses (HTTP 401): it may have expired or been revoked. Ask the person it belongs to to create a new one in Confluence (their profile picture, Settings, Personal access tokens), then use Rotate on the source's row to enter it.",
    );
    expect(message).not.toContain('not-the-fixture-pat');
  });

  it('says what IT checks for a sign-in redirect, a space the token may not view, and a wrong address', async (): Promise<void> => {
    const redirected = readerOnServer(
      () => new Response(null, { status: 302, headers: { location: 'https://sso.acme.corp/' } }),
    );
    await expect(redirected.reader.listPageBatch(space, TOKEN, undefined, 2)).rejects.toThrow(
      'wiki.acme.corp answered with a redirect (HTTP 302) where its REST API should answer, which is what a sign-in page in front of Confluence does: ask IT to let personal access tokens reach /confluence/rest/api without the sign-in redirect.',
    );
    const forbidden = readerOnServer(() => json(403, { statusCode: 403, message: 'Forbidden' }));
    await expect(forbidden.reader.listPageBatch(space, TOKEN, undefined, 2)).rejects.toThrow(
      "Confluence refused this request for the token's owner (HTTP 403): ask a space administrator to give that person View permission in the space OPS.",
    );
    const { reader } = readerOnServer();
    await expect(
      reader.listPageBatch(
        { ...space, locator: 'https://wiki.acme.corp/confluence/display/NONE' },
        TOKEN,
        undefined,
        2,
      ),
    ).rejects.toThrow(
      "Confluence found no space with the key \"NONE\" at https://wiki.acme.corp/confluence that the token's owner may view (HTTP 404): check the space's address, with the server's context path if it has one. To change it, unlink the source and link it again.",
    );
  });

  it("reads a proxy's page as something in between, never as the token's refusal", async (): Promise<void> => {
    const { reader } = readerOnServer(
      () => new Response('<html><body>Blocked by policy</body></html>', { status: 401 }),
    );
    await expect(reader.listPageBatch(space, TOKEN, undefined, 2)).rejects.toThrow(
      "wiki.acme.corp answered HTTP 401 with a page that is not Confluence's own answer",
    );
  });

  it('refuses a server inside the network that DAY0_PRIVATE_HOSTS does not list, before any request', async (): Promise<void> => {
    // The reader's own fetch: the address is checked first, and nothing is dialled.
    const reader = new ConfluenceDataCenterReader();
    await expect(
      reader.listPageBatch(
        { ...space, locator: 'https://10.20.0.5/display/OPS' },
        TOKEN,
        undefined,
        2,
      ),
    ).rejects.toThrow(
      'names a host inside a private network that DAY0_PRIVATE_HOSTS does not list, so Day0 does not read it.',
    );
  });

  it('starts the space again from a cursor that is not its own', async (): Promise<void> => {
    const { reader } = readerOnServer();
    await expect(reader.listPageBatch(space, TOKEN, 'v2|1048578|abc', 2)).rejects.toThrow(
      ListingChangedError,
    );
  });

  it('refuses to read without its token', async (): Promise<void> => {
    const { reader, requests } = readerOnServer();
    await expect(reader.listPageBatch(space, undefined, undefined, 2)).rejects.toThrow(
      'A Confluence Data Center source reads with a personal access token, and this one has none',
    );
    expect(requests).toEqual([]);
  });

  it('names a single page past what it reads of one answer unread, and reads the pages beside it (W15-R11)', async (): Promise<void> => {
    // Re-taken for wave 17 (17-X): a page's body comes in its own answer, so no window of pages
    // can be too large together and none is asked for again narrower; the one page past the
    // bound is still named unread, and the pages before and after it are still read.
    const huge = 'z'.repeat(49 * 1024 * 1024);
    const all = [
      { id: '1', title: 'Small', storage: '<p>fine</p>' },
      { id: '2', title: 'Everything we ever wrote', storage: huge },
      { id: '3', title: 'After it', storage: '<p>fine</p>' },
    ];
    const answerOf = (page: (typeof all)[number], withBody: boolean): unknown => ({
      id: page.id,
      title: page.title,
      status: 'current',
      ...(withBody ? { body: { storage: { value: page.storage } } } : {}),
      version: { number: 1 },
    });
    const { reader, requests } = readerOnServer((request) => {
      const one = /\/rest\/api\/content\/(\d+)$/.exec(request.url.pathname);
      if (one !== null) {
        const page = all.find((each) => each.id === one[1]);
        return page === undefined ? undefined : json(200, answerOf(page, true));
      }
      if (!request.url.pathname.endsWith('/rest/api/content')) return undefined;
      if (request.url.searchParams.get('status') !== 'current') return json(200, { results: [] });
      const start = Number(request.url.searchParams.get('start'));
      const limit = Number(request.url.searchParams.get('limit'));
      const results = all.slice(start, start + limit).map((page) => answerOf(page, false));
      return json(200, {
        results,
        _links: start + results.length < all.length ? { next: '/rest/api/content?next' } : {},
      });
    });
    const first = await reader.listPageBatch(space, TOKEN, undefined, 2);
    expect(first.pages.map((page) => page.ref)).toEqual(['1']);
    expect(first.unread).toEqual([
      {
        ref: '2',
        reason:
          '"Everything we ever wrote" is larger than the 4 MiB Day0 converts of one Confluence page.',
      },
    ]);
    expect(first.nextCursor).toBe('dc|current|2');
    const second = await reader.listPageBatch(space, TOKEN, first.nextCursor, 2);
    expect(second.pages.map((page) => page.ref)).toEqual(['3']);
    expect(
      requests
        .filter((request) => request.url.pathname.includes('/rest/api/content'))
        .map((request) =>
          request.url.pathname.endsWith('/content')
            ? `${request.url.searchParams.get('start')}+${request.url.searchParams.get('limit')} ${request.url.searchParams.get('expand')}`
            : `page ${request.url.pathname.split('/').pop()}`,
        ),
    ).toEqual(['0+2 version', 'page 1', 'page 2', '2+2 version', 'page 3']);
  }, 60_000);
});

describe("a Confluence Data Center page's date (wave 17, D-8)", (): void => {
  it("says a page is dated by its source when the server gives its version's time", async (): Promise<void> => {
    const { reader } = readerOnServer();
    const { pages } = await wholeSpace(reader);
    expect(pages.map((page) => page.datedBySource)).toEqual([true, true, true, true]);
  });

  it('says a page with no date from its source is dated by the read: datedBySource false', async (): Promise<void> => {
    const { reader } = readerOnServer((request) => {
      const one = /\/rest\/api\/content\/(\d+)$/.exec(request.url.pathname);
      if (one !== null) {
        return json(200, fixtureJsonWithout('confluence-dc', `page-${one[1]}.json`, 'when'));
      }
      return request.url.pathname.endsWith('/rest/api/content') &&
        request.url.searchParams.get('status') === 'current' &&
        request.url.searchParams.get('start') === '0'
        ? json(200, fixtureJsonWithout('confluence-dc', 'content-current-0.json', 'when'))
        : undefined;
    });
    const { pages } = await reader.listPageBatch(space, TOKEN, undefined, 2);
    expect(pages.map((page) => [page.ref, page.updatedAt, page.datedBySource])).toEqual([
      ['4587521', Date.UTC(2026, 9, 10, 9, 0, 0), false],
      ['4587522', Date.UTC(2026, 9, 10, 9, 0, 0), false],
    ]);
  });
});

/** A reader on a generated library, its clock still. */
function readerOnLibrary(library: LibraryFake): ConfluenceDataCenterReader {
  return new ConfluenceDataCenterReader({
    fetch: library.fetch,
    now: (): number => Date.UTC(2026, 9, 10, 9, 0, 0),
    sleep: async (): Promise<void> => undefined,
  });
}

/** The ref of a library's page by its place in the library. */
const libraryRef = (index: number): string => String(4_600_000 + index);

/** The pages a run asked for one at a time, as the id and the status each named. */
function askedOne(library: LibraryFake): string[] {
  return library.requests
    .filter((request) => request.kind === 'body')
    .map(
      (request) =>
        `${request.url.pathname.split('/').pop()} ${request.url.searchParams.get('status')} ${request.url.searchParams.get('expand')}`,
    );
}

describe('the Confluence Data Center reader contract by revision (wave 17, 17-X)', (): void => {
  it("reads a thousand unchanged pages for the listing's requests and no body request, and one changed page alone", async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 1_000 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, space, TOKEN, marks);
    expect(first.read).toHaveLength(1_000);
    expect(library.counts().bodies).toBe(1_000);

    library.reset();
    const unchanged = await readWhole(reader, space, TOKEN, marks);
    expect(unchanged.read).toEqual([]);
    expect(unchanged.kept).toHaveLength(1_000);
    // Forty listing pages of 25 and the one that asks for archived pages, none with a body; the
    // space is checked once.
    expect(library.counts()).toEqual({ token: 0, lookup: 1, listing: 41, body: 0, bodies: 0 });
    for (const listing of library.requests.filter((request) => request.kind === 'listing')) {
      expect(listing.url.searchParams.get('expand')).toBe('version');
    }

    library.edit(500);
    library.reset();
    const edited = await readWhole(reader, space, TOKEN, marks);
    expect(edited.read.map((page) => [page.ref, page.sourceRevision])).toEqual([
      [libraryRef(500), '2'],
    ]);
    expect(edited.read[0].markdown).toContain('Edited 1.');
    expect(edited.kept).toHaveLength(999);
    expect(library.counts()).toEqual({ token: 0, lookup: 1, listing: 41, body: 1, bodies: 1 });
    expect(askedOne(library)).toEqual([`${libraryRef(500)} current body.storage,version`]);
  });

  it('reads a page the listing gives no revision for as before, at every sync', async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 30 });
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
    const library = libraryFake('confluence-dc', { pages: 30 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    library.rename(7, 'Close the quarter');
    const renamed = await readWhole(reader, space, TOKEN, marks);
    expect(renamed.read.map((page) => [page.ref, page.title, page.sourceRevision])).toEqual([
      [libraryRef(7), 'Close the quarter', '1'],
    ]);
    expect(renamed.read[0].url).toBe(
      'https://wiki.acme.corp/confluence/display/OPS/close-the-quarter',
    );
    expect(renamed.kept).toHaveLength(29);
    expect((await readWhole(reader, space, TOKEN, marks)).read).toEqual([]);
  });

  it('keeps a page archived at its source and unchanged, from the walk of archived pages, and marks it archived', async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 30 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    library.archive(12);
    library.reset();
    const after = await readWhole(reader, space, TOKEN, marks);
    expect(after.read).toEqual([]);
    expect(library.counts().body).toBe(0);
    expect(after.kept).toHaveLength(30);
    // Listed last, by the walk that asks for archived pages.
    expect(after.kept.at(-1)).toEqual({
      ref: libraryRef(12),
      nativeStatus: 'archived',
      datedBySource: true,
    });
    expect(after.kept[0]).toEqual({ ref: libraryRef(0), datedBySource: true });
  });

  it('reads an archived page that changed under the status it is listed with', async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 5 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    library.archive(2);
    library.edit(2);
    library.reset();
    const after = await readWhole(reader, space, TOKEN, marks);
    expect(after.read.map((page) => [page.ref, page.nativeStatus, page.sourceRevision])).toEqual([
      [libraryRef(2), 'archived', '2'],
    ]);
    expect(askedOne(library)).toEqual([`${libraryRef(2)} archived body.storage,version`]);
  });

  it('names a changed page that is gone when its body is asked for unread, and reads the rest', async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 4 });
    const reader = new ConfluenceDataCenterReader({
      // Listed, then deleted before its body was asked for.
      fetch: async (input, init) =>
        new URL(input).pathname.endsWith(`/content/${libraryRef(1)}`)
          ? json(404, { statusCode: 404, message: 'No content found' })
          : await library.fetch(input, init),
      now: (): number => Date.UTC(2026, 9, 10, 9, 0, 0),
      sleep: async (): Promise<void> => undefined,
    });
    const batch = await reader.listPageBatch(space, TOKEN, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual([0, 2, 3].map(libraryRef));
    expect(batch.unread).toEqual([
      {
        ref: libraryRef(1),
        reason: '"Runbook 1" was deleted or moved in Confluence after it was listed.',
      },
    ]);
    expect(batch).not.toHaveProperty('kept');
  });

  it('says a kept page with no date from its source was dated by the read', async (): Promise<void> => {
    const library = libraryFake('confluence-dc', { pages: 3 });
    library.pages[1].editedAt = undefined;
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, space, TOKEN, marks);
    const kept = (await readWhole(reader, space, TOKEN, marks)).kept;
    expect(kept.map((page) => page.datedBySource)).toEqual([true, false, true]);
  });
});
