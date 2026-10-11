import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError } from '../../../../src/docs/readers/batch';
import { ConfluenceCloudReader } from '../../../../src/docs/readers/confluence-v2';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import { providerFake, type FakeOverride, type FakeRequest } from '../../../fixtures/readers/fake';

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
    const listings = requests.filter((request) => request.url.pathname.endsWith('/pages'));
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
      expect(listing.url.searchParams.get('body-format')).toBe('storage');
      expect(listing.url.searchParams.get('sort')).toBe('id');
      expect(listing.url.searchParams.get('limit')).toBe('3');
      expect(listing.authorization).toBe(`Bearer ${TOKEN}`);
    }
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
      const limit = Number(request.url.searchParams.get('limit'));
      const from = Number(request.url.searchParams.get('cursor') ?? 0);
      const results = Array.from({ length: Math.min(limit, 13 - from) }, (_unused, index) => ({
        id: String(from + index + 1),
        title: `P${from + index + 1}`,
        status: 'current',
        body: { storage: { value: body } },
        version: { number: 1 },
      }));
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
      .filter((request) => request.url.pathname.endsWith('/pages'))
      .map((request) => request.url.searchParams.get('limit'));
    expect(asked).toEqual(['25', '12', '25']);
  }, 60_000);

  it('names a single page past what it reads of one answer unread, from a listing without its body (W15-R11)', async (): Promise<void> => {
    const huge = 'z'.repeat(49 * 1024 * 1024);
    const { reader, requests } = readerOnSite((request) => {
      if (!request.url.pathname.endsWith('/pages')) return undefined;
      const withBody = request.url.searchParams.get('body-format') === 'storage';
      const from = request.url.searchParams.get('cursor');
      const results =
        from === null
          ? [
              {
                id: '7',
                title: 'Everything we ever wrote',
                status: 'current',
                ...(withBody ? { body: { storage: { value: huge } } } : {}),
                version: { number: 4 },
              },
            ]
          : [
              {
                id: '8',
                title: 'After it',
                status: 'current',
                body: { storage: { value: '<p>fine</p>' } },
                version: { number: 1 },
              },
            ];
      return json(
        200,
        { results },
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
    const listings = requests.filter((request) => request.url.pathname.endsWith('/pages'));
    expect(listings.map((request) => request.url.searchParams.get('body-format'))).toEqual([
      'storage',
      null,
    ]);
    const after = await reader.listPageBatch(space, TOKEN, batch.nextCursor, 1);
    expect(after.pages.map((page) => page.ref)).toEqual(['8']);
  }, 60_000);
});
