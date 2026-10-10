import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { YuqueReader } from '../../../../src/docs/readers/yuque';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import { providerFake, type FakeOverride, type FakeRequest } from '../../../fixtures/readers/fake';

/** 10 October 2026, 09:00 UTC: the clock every test starts at. */
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

const TOKEN = 'fixture-yuque-token';

const repository: DocSourceRecord = {
  _id: 'jd7yuquerepository01' as Id<'docSources'>,
  label: 'RevOps runbooks',
  kind: 'yuque',
  locator: 'https://acme.yuque.com/revops/runbooks',
};

/** A reader on the fixture space with a clock that moves only when the reader waits. */
function readerOnSpace(override?: FakeOverride): {
  reader: YuqueReader;
  requests: FakeRequest[];
  sleeps: number[];
} {
  let clock = T0;
  const sleeps: number[] = [];
  const space = providerFake('yuque', { now: (): number => clock, override });
  const reader = new YuqueReader({
    fetch: space.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reader, requests: space.requests, sleeps };
}

/** Every batch of the repository, three entries at a time. */
async function wholeRepository(
  reader: YuqueReader,
): Promise<{ pages: ReadPageBatch['pages']; unread: ReadPageBatch['unread'][number][] }> {
  const pages: ReadPageBatch['pages'] = [];
  const unread: ReadPageBatch['unread'][number][] = [];
  let cursor: string | undefined;
  do {
    const batch = await reader.listPageBatch(repository, TOKEN, cursor, 3);
    expect(batch.pages.length + batch.unread.length).toBeLessThanOrEqual(3);
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

/** The listings a run asked for, as the view and the offset each named. */
function listings(requests: readonly FakeRequest[]): string[] {
  return requests
    .filter((request) => request.url.pathname.endsWith('/docs'))
    .map(
      (request) =>
        `${request.url.searchParams.get('deleted') === 'true' ? 'deleted' : 'live'}@${request.url.searchParams.get('offset')}`,
    );
}

describe('the Yuque documentation reader', (): void => {
  it('walks the repository by offset to its end, then its deleted documents', async (): Promise<void> => {
    const { reader, requests } = readerOnSpace();
    const { pages, unread } = await wholeRepository(reader);
    expect(pages.map((page) => page.ref)).toEqual([
      '210000001',
      '210000002',
      '210000004',
      '210000005',
      '210000009',
    ]);
    expect(unread.map((page) => page.ref)).toEqual(['210000003', '210000006']);
    expect(listings(requests)).toEqual(['live@0', 'live@3', 'deleted@0']);
    for (const request of requests) {
      expect(request.url.origin).toBe('https://acme.yuque.com');
      expect(request.headers.get('x-auth-token')).toBe(TOKEN);
      expect(request.authorization).toBeUndefined();
    }
    const [first] = requests;
    expect(first.url.pathname).toBe('/api/v2/repos/revops/runbooks/docs');
    expect(Object.fromEntries(first.url.searchParams)).toEqual({
      offset: '0',
      limit: '3',
      deleted: 'false',
    });
  });

  it('reads on while the total says more follows, though a page came back shorter than asked', async (): Promise<void> => {
    // The sync asks for 25 at a time; a space that answers three and a total of six has three more.
    const { reader, requests } = readerOnSpace();
    const first = await reader.listPageBatch(repository, TOKEN, undefined, 25);
    expect(first.pages.map((page) => page.ref)).toEqual(['210000001', '210000002']);
    const second = await reader.listPageBatch(repository, TOKEN, first.nextCursor, 25);
    expect(second.pages.map((page) => page.ref)).toEqual(['210000004', '210000005']);
    expect(listings(requests)).toEqual(['live@0', 'live@3']);
  });

  it("reads a Markdown document's body as it is and any other through its HTML, each under its title", async (): Promise<void> => {
    const { reader } = readerOnSpace();
    const { pages } = await wholeRepository(reader);
    expect(pages[0]).toEqual({
      sourceId: repository._id,
      ref: '210000001',
      title: 'Close the quarter',
      url: 'https://acme.yuque.com/revops/runbooks/close-the-quarter',
      markdown:
        '# Close the quarter\n\n## Steps\n\n1. Lock the ledger.\n2. Refresh the pipeline tile.',
      updatedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
      sourceRevision: '2026-10-01T09:30:00.000Z',
    });
    expect(pages[1].markdown).toBe(
      '# 刷新看板\n\n每周一上午刷新**管道看板**。\n\n|  |  |\n| --- | --- |\n| 步骤 | 负责人 |\n| 刷新 | RevOps |',
    );
    const chinese = pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['刷新看板', '运维手册']);
    expect(new Set(chinese.map((page) => mirroredDocSlug(repository._id, page.ref))).size).toBe(2);
  });

  it("captures content_updated_at as each document's revision", async (): Promise<void> => {
    const { reader } = readerOnSpace();
    const { pages } = await wholeRepository(reader);
    expect(pages.map((page) => page.sourceRevision)).toEqual([
      '2026-10-01T09:30:00.000Z',
      '2026-09-21T02:00:00.000Z',
      '2026-10-05T07:00:00.000Z',
      '2026-09-20T02:00:00.000Z',
      undefined,
    ]);
  });

  it('says a document of status 0 is a draft and a deleted one is archived, and nothing of a published one', async (): Promise<void> => {
    const { reader } = readerOnSpace();
    const { pages } = await wholeRepository(reader);
    expect(pages.find((page) => page.ref === '210000004')?.nativeStatus).toBe('draft');
    expect(pages.find((page) => page.ref === '210000009')).toEqual({
      sourceId: repository._id,
      ref: '210000009',
      title: 'Old close process',
      markdown: '# Old close process\n\nThis document was deleted in Yuque.',
      updatedAt: Date.UTC(2026, 8, 30, 10, 0, 0),
      nativeStatus: 'archived',
    });
    for (const ref of ['210000001', '210000002', '210000005']) {
      expect(pages.find((page) => page.ref === ref)).not.toHaveProperty('nativeStatus');
    }
  });

  it('archives nothing where Yuque ignores the deleted view and lists the live documents again (second pass)', async (): Promise<void> => {
    const fake = providerFake('yuque');
    const reader = new YuqueReader({
      fetch: async (input, init) => {
        const url = new URL(input);
        if (url.searchParams.get('deleted') === 'true') url.searchParams.set('deleted', 'false');
        return await fake.fetch(url, init);
      },
      sleep: async (): Promise<void> => undefined,
    });
    const { pages } = await wholeRepository(reader);
    expect(pages.map((page) => page.ref)).toEqual([
      '210000001',
      '210000002',
      '210000004',
      '210000005',
    ]);
    expect(pages.some((page) => page.nativeStatus === 'archived')).toBe(false);
  });

  it('keeps the live documents where the token is refused the deleted view alone (second pass)', async (): Promise<void> => {
    const { reader } = readerOnSpace((request) =>
      request.url.searchParams.get('deleted') === 'true'
        ? json(403, { status: 403, message: 'Forbidden' })
        : undefined,
    );
    const { pages } = await wholeRepository(reader);
    expect(pages.map((page) => page.ref)).toEqual([
      '210000001',
      '210000002',
      '210000004',
      '210000005',
    ]);
  });

  it('names a sheet and a board unread with the reason, and asks nothing more of them', async (): Promise<void> => {
    const { reader, requests } = readerOnSpace();
    const { unread } = await wholeRepository(reader);
    expect(unread).toEqual([
      {
        ref: '210000003',
        reason: '"Q3 numbers" is a Yuque sheet, which Day0 does not read: only documents are read.',
      },
      {
        ref: '210000006',
        reason:
          '"Pipeline map" is a Yuque board, which Day0 does not read: only documents are read.',
      },
    ]);
    for (const id of ['210000003', '210000006', '210000009']) {
      expect(requests.some((request) => request.url.pathname.endsWith(`/docs/${id}`))).toBe(false);
    }
  });

  it('names a document whose body is a sheet (lakesheet) unread, though it is listed as a document', async (): Promise<void> => {
    const { reader } = readerOnSpace((request) =>
      request.url.pathname.endsWith('/docs/210000001')
        ? json(200, {
            data: { id: 210000001, type: 'Doc', title: 'Close the quarter', format: 'lakesheet' },
          })
        : undefined,
    );
    const batch = await reader.listPageBatch(repository, TOKEN, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '210000001',
      reason:
        '"Close the quarter" is a Yuque sheet, which Day0 does not read: only documents are read.',
    });
  });

  it('spaces its requests inside the hourly limit, and waits out a 429 before reading on', async (): Promise<void> => {
    let limited = false;
    const { reader, requests, sleeps } = readerOnSpace((request) => {
      if (limited || !request.url.pathname.endsWith('/docs/210000002')) return undefined;
      limited = true;
      return json(429, { status: 429, message: 'Too Many Requests' }, { 'retry-after': '8' });
    });
    const batch = await reader.listPageBatch(repository, TOKEN, undefined, 3);
    expect(batch.pages).toHaveLength(2);
    expect(sleeps).toContain(8_000);
    // 5,000 requests an hour is one every 720 ms.
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index].at - requests[index - 1].at).toBeGreaterThanOrEqual(720);
    }
  });

  it('says what the token needs when Yuque refuses it, and never repeats it', async (): Promise<void> => {
    const { reader } = readerOnSpace();
    let message = '';
    try {
      await reader.listPageBatch(repository, 'not-the-fixture-token', undefined, 3);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Yuque refused the token this source uses (HTTP 401): it may have been revoked, or the paid plan that gives API tokens may have lapsed. Ask the token's owner to create a new one in Yuque's account settings, with read access to repositories and documents, then use Rotate on the source's row to enter it.",
    );
    expect(message).not.toContain('not-the-fixture-token');
  });

  it("says who gives access when the token's owner may not read the repository, and checks the address when Yuque finds none", async (): Promise<void> => {
    const forbidden = readerOnSpace(() => json(403, { status: 403, message: 'Forbidden' }));
    await expect(forbidden.reader.listPageBatch(repository, TOKEN, undefined, 3)).rejects.toThrow(
      "Yuque refused this request for the token's owner (HTTP 403): ask a repository administrator to give that account read access to revops/runbooks, and check the token's scope lets it read repositories and documents.",
    );
    const { reader } = readerOnSpace();
    await expect(
      reader.listPageBatch(
        { ...repository, locator: 'https://acme.yuque.com/revops/nowhere' },
        TOKEN,
        undefined,
        3,
      ),
    ).rejects.toThrow(
      "Yuque found no repository at acme.yuque.com/revops/nowhere that the token's owner may read (HTTP 404): check the address. To change it, unlink the source and link it again.",
    );
  });

  it('names a document deleted after it was listed unread, and reads the rest', async (): Promise<void> => {
    const { reader } = readerOnSpace((request) =>
      request.url.pathname.endsWith('/docs/210000001')
        ? json(404, { status: 404, message: 'Not Found' })
        : undefined,
    );
    const batch = await reader.listPageBatch(repository, TOKEN, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '210000001',
      reason: '"Close the quarter" was deleted or moved in Yuque after it was listed.',
    });
    expect(batch.pages.map((page) => page.ref)).toEqual(['210000002']);
  });

  it('starts the repository again from a cursor that is not its own, and refuses to read without its token', async (): Promise<void> => {
    const { reader, requests } = readerOnSpace();
    await expect(reader.listPageBatch(repository, TOKEN, 'dc|current|2', 3)).rejects.toThrow(
      ListingChangedError,
    );
    await expect(reader.listPageBatch(repository, undefined, undefined, 3)).rejects.toThrow(
      "A Yuque source reads with a token, and this one has none: use Rotate on the source's row to give one.",
    );
    expect(requests).toEqual([]);
  });

  it('names a document nested too deeply to convert unread, and reads the one beside it (W15-R9)', async (): Promise<void> => {
    // Reader 3's poison.mts: a body of 3,000 nested divs.
    const deep = `${'<div>'.repeat(3_000)}x${'</div>'.repeat(3_000)}`;
    const { reader } = readerOnSpace((request) =>
      request.url.pathname.endsWith('/docs/210000001')
        ? json(200, { data: { id: 210000001, format: 'lake', body_html: deep, slug: 'close' } })
        : undefined,
    );
    const batch = await reader.listPageBatch(repository, TOKEN, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '210000001',
      reason:
        '"Close the quarter" is not read: it is laid out too deeply for Day0 to convert: lists, tables or quotations inside one another, many levels down.',
    });
    expect(batch.pages.map((page) => page.ref)).toEqual(['210000002']);
  });

  it('names a document larger than it reads of one answer unread, and reads the one beside it (W15-R11)', async (): Promise<void> => {
    // Reader 3's big.mts: a Markdown body of 17 MiB.
    const big = 'x'.repeat(17 * 1024 * 1024);
    const { reader } = readerOnSpace((request) =>
      request.url.pathname.endsWith('/docs/210000001')
        ? json(200, { data: { id: 210000001, format: 'markdown', body: big, slug: 'close' } })
        : undefined,
    );
    const batch = await reader.listPageBatch(repository, TOKEN, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '210000001',
      reason: '"Close the quarter" is larger than the 16 MiB Day0 reads of one Yuque document.',
    });
    expect(batch.pages.map((page) => page.ref)).toEqual(['210000002']);
  });
});
