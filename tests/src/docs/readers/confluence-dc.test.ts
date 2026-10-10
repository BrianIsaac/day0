import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { ConfluenceDataCenterReader } from '../../../../src/docs/readers/confluence-dc';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import { providerFake, type FakeOverride, type FakeRequest } from '../../../fixtures/readers/fake';

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
      expand: 'body.storage,version',
      start: '0',
      limit: '2',
    });
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
});
