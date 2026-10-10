import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { SharePointReader } from '../../../../src/docs/readers/sharepoint';
import { sharePointReaderSecret } from '../../../../src/docs/sharepoint-source';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  fixtureBytes,
  providerFake,
  type FakeOverride,
  type FakeRequest,
} from '../../../fixtures/readers/fake';

/** 10 October 2026, 09:00 UTC: the clock every test starts at. */
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

const APP = {
  tenantId: '9188040d-6c67-4c5b-b112-36a304b66dad',
  clientId: '6731de76-14a6-49ae-97bc-6eba6914391e',
  clientSecret: 'fixture-client-secret',
};
const SECRET = sharePointReaderSecret(APP);
const SITE_ID =
  'acme.sharepoint.com,2c712604-1370-44e7-a1f5-426573fda7bb,2d2244c3-251a-49ea-93c8-39e1c3a060fe';

const site: DocSourceRecord = {
  _id: 'jd7sharepointsite001' as Id<'docSources'>,
  label: 'Runbooks site',
  kind: 'sharepoint',
  locator: 'https://acme.sharepoint.com/sites/Runbooks',
};

/** A reader on the fixture tenant with a clock that moves only when the reader waits. */
function readerOnTenant(override?: FakeOverride): {
  reader: SharePointReader;
  requests: FakeRequest[];
  sleeps: number[];
} {
  let clock = T0;
  const sleeps: number[] = [];
  const tenant = providerFake('sharepoint', { now: (): number => clock, override });
  const reader = new SharePointReader({
    fetch: tenant.fetch,
    download: tenant.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reader, requests: tenant.requests, sleeps };
}

/** Every batch of the site, three entries at a time. */
async function wholeSite(reader: SharePointReader): Promise<{
  pages: ReadPageBatch['pages'];
  unread: ReadPageBatch['unread'][number][];
  batches: number;
}> {
  const pages: ReadPageBatch['pages'] = [];
  const unread: ReadPageBatch['unread'][number][] = [];
  let cursor: string | undefined;
  let batches = 0;
  do {
    const batch = await reader.listPageBatch(site, SECRET, cursor, 3);
    expect(batch.pages.length + batch.unread.length).toBeLessThanOrEqual(3);
    pages.push(...batch.pages);
    unread.push(...batch.unread);
    cursor = batch.nextCursor;
    batches += 1;
  } while (cursor !== undefined);
  return { pages, unread, batches };
}

/** A Graph answer a test puts in place of the fixture's. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** The Graph listings a run asked for, by what each walked. */
function walked(requests: readonly FakeRequest[]): string[] {
  return requests.flatMap((request): string[] => {
    if (request.url.pathname.endsWith('/drive/root/delta')) {
      return [`files ${request.url.searchParams.get('token') ?? 'start'}`];
    }
    if (request.url.pathname.endsWith('/pages/microsoft.graph.sitePage')) {
      return [`pages ${request.url.searchParams.get('$skiptoken') ?? 'start'}`];
    }
    return [];
  });
}

describe('the SharePoint documentation reader', (): void => {
  it("walks the library's delta through each nextLink to its delta link, then the site's pages", async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    const { pages, unread } = await wholeSite(reader);
    expect(pages.map((page) => page.ref)).toEqual([
      'file-01CLOSE',
      'file-01ESCAL',
      'file-01OPSZH',
      'file-01OLD',
      'page-0a1b2c3d-0000-4000-8000-000000000001',
      'page-0a1b2c3d-0000-4000-8000-000000000002',
      'page-0a1b2c3d-0000-4000-8000-000000000003',
    ]);
    expect(unread.map((page) => page.ref)).toEqual(['file-01DECK', 'file-01HUGE', 'file-01SCAN']);
    // The second delta page holds more than one batch takes, so it is asked for again and the
    // entries already taken are passed over; the delta link ends the files and is not followed.
    expect(walked(requests)).toEqual([
      'files start',
      'files fixture-delta-page-2',
      'files fixture-delta-page-2',
      'pages start',
      'pages fixture-pages-2',
    ]);
    expect(requests.some((request) => request.url.href.includes('fixture-delta-link'))).toBe(false);
    // The site is looked up once, and its id carried in the cursor after that.
    expect(
      requests.filter((request) => request.url.pathname.endsWith(':/sites/Runbooks')),
    ).toHaveLength(1);
  });

  it('reads a Markdown file as it is, through the pre-authenticated address, which gets no token', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    const [close] = (await reader.listPageBatch(site, SECRET, undefined, 3)).pages;
    expect(close).toEqual({
      sourceId: site._id,
      ref: 'file-01CLOSE',
      title: 'Close the quarter',
      url: 'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents/close-the-quarter.md',
      markdown:
        '# Close the quarter\n\n1. Lock the ledger.\n2. Refresh the pipeline tile.\n\n| Step | Owner |\n| --- | --- |\n| Lock the ledger | Finance |\n',
      updatedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
      sourceRevision: '"c:{11111111-1111-4111-8111-111111111111},7"',
    });
    const download = requests.find((request) => request.url.host === 'acme.sharepoint.com');
    expect(download?.authorization).toBeUndefined();
    for (const request of requests.filter((each) => each.url.host === 'graph.microsoft.com')) {
      expect(request.authorization).toBe('Bearer fixture-graph-token');
    }
  });

  it("captures a file's cTag and a page's version as the revision", async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const { pages } = await wholeSite(reader);
    expect(pages.map((page) => page.sourceRevision)).toEqual([
      '"c:{11111111-1111-4111-8111-111111111111},7"',
      '"c:{22222222-2222-4222-8222-222222222222},3"',
      '"c:{44444444-4444-4444-8444-444444444444},2"',
      undefined,
      '3.0',
      '0.4',
      '1.0',
    ]);
  });

  it('says a deleted file is archived and leaves nothing of its text, and says a checked-out page is a draft', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const { pages } = await wholeSite(reader);
    expect(pages.find((page) => page.ref === 'file-01OLD')).toEqual({
      sourceId: site._id,
      ref: 'file-01OLD',
      title: 'old-process',
      markdown: '# old-process\n\nThis file was deleted in SharePoint.',
      updatedAt: T0,
      nativeStatus: 'archived',
    });
    expect(pages.find((page) => page.title === 'Escalation paths 2027')?.nativeStatus).toBe(
      'draft',
    );
    for (const ref of ['file-01CLOSE', 'page-0a1b2c3d-0000-4000-8000-000000000001']) {
      expect(pages.find((page) => page.ref === ref)).not.toHaveProperty('nativeStatus');
    }
  });

  it("reads a site page's text web parts in order as Markdown, under the page's title", async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const { pages } = await wholeSite(reader);
    expect(pages.find((page) => page.ref === 'page-0a1b2c3d-0000-4000-8000-000000000001')).toEqual({
      sourceId: site._id,
      ref: 'page-0a1b2c3d-0000-4000-8000-000000000001',
      title: 'How to refresh the pipeline tile',
      url: 'https://acme.sharepoint.com/sites/Runbooks/SitePages/How-to-refresh-the-tile.aspx',
      markdown: [
        '# How to refresh the pipeline tile',
        '## Before you start',
        'Open **Looker** and sign in.',
        '| Step | Owner |\n| --- | --- |\n| Refresh the pipeline tile | RevOps |',
        'Ask in #revops when the tile stays grey.',
      ].join('\n\n'),
      updatedAt: Date.UTC(2026, 8, 28, 7, 0, 0),
      sourceRevision: '3.0',
    });
    const chinese = pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['运维手册', '值班表']);
    expect(new Set(chinese.map((page) => mirroredDocSlug(site._id, page.ref))).size).toBe(2);
  });

  it("converts a Word document where it runs, under the file's name, with its tables kept (RM9 (b1))", async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const word = (await reader.listPageBatch(site, SECRET, undefined, 3)).pages[1];
    expect(word).toEqual({
      sourceId: site._id,
      ref: 'file-01ESCAL',
      title: 'Escalation paths',
      url: 'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents/Escalation paths.docx',
      markdown: [
        '# Escalation paths',
        'Call the **duty manager** first.',
        '1.  Page the on-call engineer.\n2.  Post in #incidents.',
        '| Severity | Who |\n| --- | --- |\n| SEV1 | Duty manager |\n| SEV2 | Team lead |',
        '## Out of hours',
        '夜间请致电值班经理。',
      ].join('\n\n'),
      updatedAt: Date.UTC(2026, 8, 12, 10, 0, 0),
      sourceRevision: '"c:{22222222-2222-4222-8222-222222222222},3"',
    });
  });

  it('names a Word document it cannot convert unread, with why: no package, no text, or too large', async (): Promise<void> => {
    const answers: Record<string, Uint8Array<ArrayBuffer>> = {
      protected: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]),
      pictures: fixtureBytes('word', 'pictures-only.docx'),
    };
    for (const [which, reason] of [
      [
        'protected',
        '"Escalation paths.docx" is not read: it is not a .docx file Day0 can open: it may be protected with a password, or be an older .doc saved under the newer name.',
      ],
      ['pictures', '"Escalation paths.docx" has no text Day0 can read: it may hold only pictures.'],
    ] as const) {
      const { reader } = readerOnTenant((request) =>
        request.url.host === 'acme.sharepoint.com' &&
        request.url.searchParams.get('UniqueId') === '01ESCAL'
          ? new Response(answers[which], { status: 200 })
          : undefined,
      );
      const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
      expect(batch.unread[0], which).toEqual({ ref: 'file-01ESCAL', reason });
    }
    const large = readerOnTenant((request) =>
      request.url.pathname.endsWith('/drive/root/delta')
        ? json(200, {
            value: [
              {
                id: '01BIG',
                name: 'Policy binder.docx',
                size: 40 * 1024 * 1024,
                file: {},
                parentReference: { driveId: 'drive' },
              },
            ],
          })
        : undefined,
    );
    const batch = await large.reader.listPageBatch(site, SECRET, undefined, 3);
    expect(batch.unread).toEqual([
      {
        ref: 'file-01BIG',
        reason:
          '"Policy binder.docx" is 40 MiB, larger than the 16 MiB Day0 reads of one Word document.',
      },
    ]);
    expect(large.requests.some((request) => request.url.pathname.includes('/items/'))).toBe(false);
  });

  it('names what it does not read unread with the reason, and passes over a file that is no document', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    const { unread } = await wholeSite(reader);
    expect(unread).toEqual([
      {
        ref: 'file-01DECK',
        reason:
          '"Q3 board deck.pptx" is a slide deck, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site\'s own pages.',
      },
      {
        ref: 'file-01HUGE',
        reason: '"full-crm-export.md" is 5 MiB, larger than the 2 MiB Day0 reads of one file.',
      },
      {
        ref: 'file-01SCAN',
        reason:
          '"Signed policy.pdf" is a PDF, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site\'s own pages.',
      },
    ]);
    // Nothing is downloaded of a file the reader does not read, and a spreadsheet is no page.
    for (const id of ['01DECK', '01HUGE', '01SCAN', '01BUDGET']) {
      expect(requests.some((request) => request.url.pathname.includes(`/items/${id}/`))).toBe(
        false,
      );
    }
  });

  it('holds the download address Graph names to the page rules, and names a file behind a refused one unread', async (): Promise<void> => {
    const tenant = providerFake('sharepoint', {
      override: (request) =>
        request.url.pathname.endsWith('/items/01CLOSE/content')
          ? new Response(null, {
              status: 302,
              headers: { location: 'https://10.20.0.9/download?tempauth=fixture' },
            })
          : undefined,
    });
    // The reader's own download: the address is checked first, and nothing is dialled.
    const reader = new SharePointReader({ fetch: tenant.fetch });
    const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
    expect(batch.pages).toEqual([]);
    expect(batch.unread[0]).toEqual({
      ref: 'file-01CLOSE',
      reason:
        '"close-the-quarter.md" could not be downloaded: https://10.20.0.9 names a host inside a private network that DAY0_PRIVATE_HOSTS does not list, so Day0 does not read it.',
    });
    // The download address carries its own authorisation, which no reason repeats.
    expect(JSON.stringify(batch.unread)).not.toContain('tempauth');
    expect(tenant.requests.some((request) => request.url.host === '10.20.0.9')).toBe(false);
  });

  it('names a file that grew past the bound after it was listed unread, and reads the rest (second pass)', async (): Promise<void> => {
    const { reader } = readerOnTenant((request) =>
      request.url.host === 'acme.sharepoint.com' &&
      request.url.searchParams.get('UniqueId') === '01CLOSE'
        ? new Response('x'.repeat(3 * 1024 * 1024), { status: 200 })
        : undefined,
    );
    const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: 'file-01CLOSE',
      reason: '"close-the-quarter.md" is larger than the 2 MiB Day0 reads of one file.',
    });
    expect(batch.pages.map((page) => page.ref)).toEqual(['file-01ESCAL']);
  });

  it('follows a download address given relative to Graph, and reads a file Graph answers directly (second pass)', async (): Promise<void> => {
    const direct = readerOnTenant((request) =>
      request.url.pathname.endsWith('/items/01CLOSE/content')
        ? new Response('# Direct\n\nSent with no redirect.\n', { status: 200 })
        : undefined,
    );
    const [page] = (await direct.reader.listPageBatch(site, SECRET, undefined, 3)).pages;
    expect([page.ref, page.title]).toEqual(['file-01CLOSE', 'Direct']);
  });

  it('starts the walk again when Graph answers 410 Gone to a link an earlier batch kept', async (): Promise<void> => {
    const { reader } = readerOnTenant((request) =>
      request.url.searchParams.get('token') === 'fixture-delta-page-2'
        ? json(
            410,
            { error: { code: 'resyncChangesApplyDifferences', message: 'Resync required' } },
            {
              location: `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drive/root/delta?token=fixture-fresh`,
            },
          )
        : undefined,
    );
    const first = await reader.listPageBatch(site, SECRET, undefined, 3);
    await expect(reader.listPageBatch(site, SECRET, first.nextCursor, 3)).rejects.toThrow(
      ListingChangedError,
    );
    await expect(reader.listPageBatch(site, SECRET, '25@abc1234', 3)).rejects.toThrow(
      ListingChangedError,
    );
  });

  it('waits the seconds Retry-After names when Graph throttles, then reads on', async (): Promise<void> => {
    let throttled = false;
    const { reader, sleeps } = readerOnTenant((request) => {
      if (throttled || !request.url.pathname.endsWith('/drive/root/delta')) return undefined;
      throttled = true;
      return json(
        429,
        { error: { code: 'TooManyRequests', message: 'Please retry again later.' } },
        { 'retry-after': '10' },
      );
    });
    const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
    expect(sleeps).toEqual([10_000]);
    expect(batch.pages).toHaveLength(2);
  });

  it('says what IT does when Microsoft refuses the app registration, and never repeats its secret', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    let message = '';
    try {
      await reader.listPageBatch(
        site,
        sharePointReaderSecret({ ...APP, clientSecret: 'not-the-fixture-secret' }),
        undefined,
        3,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Microsoft refused the app registration this source reads as (invalid_client, AADSTS7000215): its client secret may have expired or been replaced. Ask IT for the registration's tenant ID, client ID and current client secret, then use Rotate on the source's row to enter them as tenant ID:client ID:client secret.",
    );
    expect(message).not.toContain('not-the-fixture-secret');
  });

  it('names the permission IT grants when Graph refuses the app a call, and the address when it finds no site', async (): Promise<void> => {
    const denied = (path: string): FakeOverride => {
      return (request) =>
        request.url.pathname.endsWith(path)
          ? json(403, { error: { code: 'accessDenied', message: 'Access denied' } })
          : undefined;
    };
    await expect(
      readerOnTenant(denied('/drive/root/delta')).reader.listPageBatch(site, SECRET, undefined, 3),
    ).rejects.toThrow(
      "Microsoft Graph refused the app this call (HTTP 403, accessDenied): reading the site's document library needs the application permission Files.Read.All, or Sites.Read.All, with admin consent. Ask IT to check the app registration against reader-sharepoint.md; where it was given Sites.Selected alone, ask them to confirm the site was granted to the app, or to grant Sites.Read.All.",
    );
    await expect(
      readerOnTenant(denied(':/sites/Runbooks')).reader.listPageBatch(site, SECRET, undefined, 3),
    ).rejects.toThrow('looking the site up needs the application permission Sites.Read.All');
    const { reader } = readerOnTenant();
    await expect(
      reader.listPageBatch(
        { ...site, locator: 'https://acme.sharepoint.com/sites/Nowhere' },
        SECRET,
        undefined,
        3,
      ),
    ).rejects.toThrow(
      'Microsoft Graph found no SharePoint site at acme.sharepoint.com/sites/Nowhere (HTTP 404): check the address. To change it, unlink the source and link it again.',
    );
  });

  it('reads a site on the cloud 21Vianet operates through that cloud’s sign-in and Graph hosts', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant((request) =>
      request.url.host === 'login.chinacloudapi.cn'
        ? json(200, { token_type: 'Bearer', expires_in: 3599, access_token: 'fixture-cn-token' })
        : json(404, { error: { code: 'itemNotFound', message: 'Not found' } }),
    );
    await expect(
      reader.listPageBatch(
        { ...site, locator: 'https://acme.sharepoint.cn/sites/Runbooks' },
        SECRET,
        undefined,
        3,
      ),
    ).rejects.toThrow(
      'Microsoft Graph found no SharePoint site at acme.sharepoint.cn/sites/Runbooks',
    );
    expect(requests.map((request) => request.url.host)).toEqual([
      'login.chinacloudapi.cn',
      'microsoftgraph.chinacloudapi.cn',
    ]);
    expect(new URLSearchParams(requests[0].body).get('scope')).toBe(
      'https://microsoftgraph.chinacloudapi.cn/.default',
    );
    expect(requests[1].authorization).toBe('Bearer fixture-cn-token');
  });

  it('never follows a link to another host with its token', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant((request) =>
      request.url.pathname.endsWith('/drive/root/delta')
        ? json(200, {
            value: [{ id: '01ROOT', name: 'root', folder: {} }],
            '@odata.nextLink': 'https://graph.example.test/v1.0/steal?token=1',
          })
        : undefined,
    );
    const first = await reader.listPageBatch(site, SECRET, undefined, 3);
    await expect(reader.listPageBatch(site, SECRET, first.nextCursor, 3)).rejects.toThrow(
      'Microsoft Graph named a next page on another host, which Day0 does not follow.',
    );
    expect(requests.some((request) => request.url.host === 'graph.example.test')).toBe(false);
  });

  it('refuses to read without its app registration', async (): Promise<void> => {
    const { reader, requests } = readerOnTenant();
    await expect(reader.listPageBatch(site, undefined, undefined, 3)).rejects.toThrow(
      "A SharePoint source reads as an app registration, and this one has none: use Rotate on the source's row to give its tenant ID, client ID and client secret.",
    );
    expect(requests).toEqual([]);
  });
});
