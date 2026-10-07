import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { feishuReaderSecret } from '../../../../src/docs/feishu-source';
import { FeishuReader } from '../../../../src/docs/readers/feishu';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  feishuTenant,
  feishuTenantFetch,
  type RecordedRequest,
  type RequestOverride,
} from '../../../fixtures/feishu/tenant';

/** 8 October 2026, 09:00 UTC: the clock every test starts at. */
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const MINUTE = 60_000;

const SECRET = feishuReaderSecret(feishuTenant.app.appId, feishuTenant.app.appSecret);
const NODES = feishuTenant.nodes;

const wiki: DocSourceRecord = {
  _id: 'jd7feishusource0001' as Id<'docSources'>,
  label: 'RevOps wiki',
  kind: 'feishu',
  locator: `https://open.feishu.cn/wiki/spaces/${feishuTenant.spaceId}`,
};

/** A reader on the recorded tenant with a clock that moves only when the reader waits. */
function readerOnTenant(
  options: { readonly tokens?: readonly string[]; readonly override?: RequestOverride } = {},
): {
  reader: FeishuReader;
  requests: RecordedRequest[];
  sleeps: number[];
  advance: (ms: number) => void;
} {
  let clock = T0;
  const sleeps: number[] = [];
  const tenant = feishuTenantFetch({ ...options, now: (): number => clock });
  const reader = new FeishuReader({
    fetch: tenant.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return {
    reader,
    requests: tenant.requests,
    sleeps,
    advance: (ms: number): void => {
      clock += ms;
    },
  };
}

/** The node listings a run asked for, as `parent` (or `top`) and the page token. */
function listings(requests: readonly RecordedRequest[]): string[] {
  return requests
    .filter((request) => request.url.pathname.endsWith('/nodes'))
    .map(
      (request) =>
        `${request.url.searchParams.get('parent_node_token') ?? 'top'}|${request.url.searchParams.get('page_token') ?? ''}`,
    );
}

describe('the Feishu documentation reader', (): void => {
  it("reads a wiki space's documents as Markdown, one parent at a time, across pages", async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(batch.pages.map((page) => page.ref)).toEqual([
      NODES.handbook.node,
      NODES.zh1.node,
      NODES.zh2.node,
      NODES.refresh.node,
    ]);
    const refresh = batch.pages.find((page) => page.ref === NODES.refresh.node);
    expect(refresh).toMatchObject({
      sourceId: wiki._id,
      title: 'How to refresh the Looker pipeline tile',
      updatedAt: 1_759_327_200_000,
      url: `https://feishu.cn/wiki/${NODES.refresh.node}`,
    });
    expect(refresh?.markdown).toContain('2. Select the pipeline tile and choose **Refresh**.');
    expect(batch.nextCursor).toBeUndefined();
    // The top level's two pages, then the handbook's children: an empty page that still says
    // there is more, then the page that has them.
    expect(listings(requests)).toEqual([
      'top|',
      'top|fixture-root-page-2',
      `${NODES.handbook.node}|`,
      `${NODES.handbook.node}|fixture-handbook-page-2`,
    ]);
    for (const request of requests.filter((each) => each.url.pathname.endsWith('/nodes'))) {
      expect(request.url.searchParams.get('page_size')).toBe('50');
    }
  });

  it('continues the listing in later batches from its cursor', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const seen: string[] = [];
    let cursor: string | undefined;
    let batches = 0;
    do {
      const batch = await reader.listPageBatch(wiki, SECRET, cursor, 3);
      expect(batch.pages.length + batch.unread.length).toBeLessThanOrEqual(3);
      seen.push(...batch.pages.map((page) => page.ref), ...batch.unread.map((page) => page.ref));
      cursor = batch.nextCursor;
      batches += 1;
    } while (cursor !== undefined);
    expect(batches).toBe(3);
    expect(seen.sort()).toEqual(
      Object.values(NODES)
        .map((each) => each.node)
        .sort(),
    );
  });

  it('asks for the wiki listing at most 100 times a minute', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    await reader.listPageBatch(wiki, SECRET, undefined, 25);
    const times = requests
      .filter((request) => request.url.pathname.endsWith('/nodes'))
      .map((request) => request.at);
    for (let index = 1; index < times.length; index += 1) {
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(MINUTE / 100);
    }
  });

  it('keeps two pages titled with no Latin character distinct', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    const chinese = batch.pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['刷新看板', '运维规则']);
    expect(chinese[0].markdown).toContain('每周一上午刷新管道看板。');
    const slugs = chinese.map((page) => mirroredDocSlug(wiki._id, page.ref));
    expect(new Set(slugs).size).toBe(2);
  });

  it('names a sheet node unread with its reason', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(batch.unread).toContainEqual({
      ref: NODES.sheet.node,
      reason:
        '"Q3 numbers" is a Feishu sheet, which Day0 does not read: only documents (docx) are read, as Markdown.',
    });
    expect(batch.unread).toContainEqual({
      ref: NODES.map.node,
      reason:
        '"Pipeline map" is a Feishu mind note, which Day0 does not read: only documents (docx) are read, as Markdown.',
    });
    // Nothing is asked of a node the reader does not read.
    expect(requests.some((request) => request.url.href.includes(NODES.sheet.obj))).toBe(false);
  });

  it('a page over 10 MB is unread', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(batch.unread).toContainEqual({
      ref: NODES.export.node,
      reason:
        '"Full CRM export" is larger than the 10 MB Feishu exports as Markdown, so it is not read.',
    });
  });

  it('names a document the app cannot read unread, with what to do', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    const restricted = batch.unread.find((page) => page.ref === NODES.restricted.node);
    expect(restricted?.reason).toBe(
      'The Feishu app cannot read "Payroll" (Feishu code 1770032): add the app to the document, or to its wiki space as a member.',
    );
  });

  it('names a document deleted after the listing as deleted, though Feishu answers it with 403', async (): Promise<void> => {
    const { reader } = readerOnTenant({
      override: (request) =>
        request.url.pathname === '/open-apis/docs/v1/content' &&
        request.url.searchParams.get('doc_token') === NODES.zh2.obj
          ? new Response(JSON.stringify({ code: 2889906, msg: 'docs deleted' }), { status: 403 })
          : undefined,
    });
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(batch.unread).toContainEqual({
      ref: NODES.zh2.node,
      reason: '"运维规则" was deleted or moved in Feishu after it was listed (Feishu code 2889906).',
    });
  });

  it('honours the rate-limit reset', async (): Promise<void> => {
    const limited = new Set<string>();
    const { reader, sleeps } = readerOnTenant({
      override: (request) => {
        const content =
          request.url.pathname === '/open-apis/docs/v1/content' &&
          request.url.searchParams.get('doc_token') === NODES.refresh.obj;
        const document = request.url.pathname.endsWith(`/documents/${NODES.zh2.obj}`);
        if ((!content && !document) || limited.has(request.url.pathname)) return undefined;
        limited.add(request.url.pathname);
        // Most APIs say 429; the document read says 400, with the same code (C5, re-read).
        return new Response(
          JSON.stringify({ code: 99991400, msg: 'request trigger frequency limit' }),
          {
            status: document ? 400 : 429,
            headers: {
              'x-ogw-ratelimit-limit': '100',
              'x-ogw-ratelimit-reset': content ? '7' : '3',
            },
          },
        );
      },
    });
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(limited.size).toBe(2);
    expect(sleeps).toContain(7_000);
    expect(sleeps).toContain(3_000);
    expect(batch.pages.map((page) => page.ref)).toContain(NODES.refresh.node);
    expect(batch.pages.map((page) => page.ref)).toContain(NODES.zh2.node);
  });

  it('fails the batch on a limit that outlasts its waits, rather than one page', async (): Promise<void> => {
    const { reader } = readerOnTenant({
      override: (request) =>
        request.url.pathname === '/open-apis/docs/v1/content'
          ? new Response(
              JSON.stringify({ code: 99991400, msg: 'request trigger frequency limit' }),
              {
                status: 429,
                headers: { 'x-ogw-ratelimit-reset': '1' },
              },
            )
          : undefined,
    });
    await expect(reader.listPageBatch(wiki, SECRET, undefined, 25)).rejects.toThrow(
      'Feishu was rate limited',
    );
  });

  it('refreshes the tenant token before it lapses', async (): Promise<void> => {
    const { reader, requests, advance } = readerOnTenant({
      tokens: ['t-fixture-token-one', 't-fixture-token-two'],
    });
    const tokenRequests = (): number =>
      requests.filter((request) => request.url.pathname.endsWith('/tenant_access_token/internal'))
        .length;
    const lastAuthorization = (): string | undefined => requests.at(-1)?.authorization;
    await reader.listPageBatch(wiki, SECRET, undefined, 2);
    expect([tokenRequests(), lastAuthorization()]).toEqual([1, 'Bearer t-fixture-token-one']);
    // One hundred minutes into its two hours the token is still used as it is.
    advance(100 * MINUTE);
    await reader.listPageBatch(wiki, SECRET, undefined, 2);
    expect([tokenRequests(), lastAuthorization()]).toEqual([1, 'Bearer t-fixture-token-one']);
    // With under ten minutes left a new one is asked for, before the old one lapses.
    advance(11 * MINUTE);
    await reader.listPageBatch(wiki, SECRET, undefined, 2);
    expect([tokenRequests(), lastAuthorization()]).toEqual([2, 'Bearer t-fixture-token-two']);
  });

  it('asks for a new token once when Feishu says the one it holds is no longer valid', async (): Promise<void> => {
    let refused = false;
    const { reader, requests } = readerOnTenant({
      tokens: ['t-fixture-token-one', 't-fixture-token-two'],
      override: (request) => {
        if (refused || request.authorization !== 'Bearer t-fixture-token-one') return undefined;
        if (!request.url.pathname.endsWith('/nodes')) return undefined;
        refused = true;
        return new Response(JSON.stringify({ code: 99991663, msg: 'Invalid access token' }), {
          status: 400,
        });
      },
    });
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    expect(batch.pages).toHaveLength(4);
    expect(requests.at(-1)?.authorization).toBe('Bearer t-fixture-token-two');
  });

  it('fails the batch when the app id and secret are refused, and never repeats the secret', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const wrong = feishuReaderSecret(feishuTenant.app.appId, 'not-the-fixture-secret');
    let message = '';
    try {
      await reader.listPageBatch(wiki, wrong, undefined, 25);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Feishu refused the app ID and secret this source was linked with (Feishu code 10014, app secret invalid); link it again with the app's current secret.",
    );
    expect(message).not.toContain('not-the-fixture-secret');
  });

  it('says how to add the app when the wiki space does not admit it', async (): Promise<void> => {
    const { reader } = readerOnTenant({
      override: (request) =>
        request.url.pathname.endsWith('/nodes')
          ? new Response(
              JSON.stringify({
                code: 131006,
                msg: 'permission denied: wiki space permission denied',
              }),
              { status: 400 },
            )
          : undefined,
    });
    await expect(reader.listPageBatch(wiki, SECRET, undefined, 25)).rejects.toThrow(
      "The Feishu app is not a member of this wiki space (Feishu code 131006): add a group chat that has the app as its bot to the space's members.",
    );
  });

  it('reads a folder of documents and the folders under it', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const batch = await reader.listPageBatch(
      { ...wiki, locator: `https://open.feishu.cn/drive/folders/${feishuTenant.folderToken}` },
      SECRET,
      undefined,
      25,
    );
    expect(batch.pages.map((page) => [page.ref, page.title, page.url])).toEqual([
      [
        feishuTenant.folder.close,
        'Q3 close checklist',
        `https://feishu.cn/docx/${feishuTenant.folder.close}`,
      ],
      [
        feishuTenant.folder.old,
        'Old close process',
        `https://feishu.cn/docx/${feishuTenant.folder.old}`,
      ],
    ]);
    expect(batch.unread).toEqual([]);
  });

  it('reads Lark sources from the Lark host', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    await reader.listPageBatch(
      { ...wiki, locator: `https://open.larksuite.com/wiki/spaces/${feishuTenant.spaceId}` },
      SECRET,
      undefined,
      1,
    );
    expect(new Set(requests.map((request) => request.url.host))).toEqual(
      new Set(['open.larksuite.com']),
    );
  });

  it('refuses to read without the app ID and secret', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    await expect(reader.listPageBatch(wiki, undefined, undefined, 25)).rejects.toThrow(
      'A Feishu source reads with its app ID and secret',
    );
  });
});

describe("the Feishu reader's guide", (): void => {
  it('quotes word for word every reason the reader gives for a page it does not read', async (): Promise<void> => {
    const guide = readFileSync(
      new URL('../../../../docs/running/reader-feishu.md', import.meta.url),
      'utf8',
    )
      .replace(/\s+/g, ' ')
      .replaceAll('` `', ' ');
    const { reader } = readerOnTenant();
    const batch = await reader.listPageBatch(wiki, SECRET, undefined, 25);
    const reasons = batch.unread
      .map((page) => page.reason)
      .filter((reason) => !reason.includes('mind note'));
    expect(reasons).toHaveLength(3);
    for (const reason of reasons) expect(guide).toContain(reason);
  });
});
