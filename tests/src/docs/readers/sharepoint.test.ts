import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { pinnedPageFetch, type PageRequest } from '../../../../src/docs/readers/page-address';
import { SharePointReader } from '../../../../src/docs/readers/sharepoint';
import { MAX_WORD_BYTES } from '../../../../src/docs/readers/word';
import { sharePointReaderSecret } from '../../../../src/docs/sharepoint-source';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  fixtureBytes,
  fixtureJsonWithout,
  providerFake,
  type FakeOverride,
  type FakeRequest,
} from '../../../fixtures/readers/fake';
import { THOUSAND_PAGE_REQUESTS } from '../../../fixtures/readers/guide-counts';
import { libraryFake, type LibraryFake } from '../../../fixtures/readers/library';
import { readWhole, storedIn, type StoredMarks } from '../../../fixtures/readers/stored';

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

/** A transport no test expects a dial on. */
const neverDialled: PageRequest = () => {
  throw new Error('the plain http transport was dialled');
};

/** A transport that answers 200 with this many chunks of this size, as a download streams. */
function streamOf(chunks: number, chunkBytes: number): PageRequest {
  return (_url, _options, callback) => ({
    on: (): void => undefined,
    end: (): void => {
      const response = Object.assign(new PassThrough(), {
        statusCode: 200,
        statusMessage: 'OK',
        headers: { 'content-type': 'application/octet-stream' },
      });
      callback(response as unknown as IncomingMessage);
      for (let sent = 0; sent < chunks; sent += 1) response.write(Buffer.alloc(chunkBytes, 65));
      response.end();
    },
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
      // Re-pinned for wave 17 (D-8): every reader says whether the page's date is its source's own.
      datedBySource: true,
      // Re-pinned for wave 17 (X-1): a file's revision is stored marked with which tag it is.
      sourceRevision: 'c:"c:{11111111-1111-4111-8111-111111111111},7"',
    });
    const download = requests.find((request) => request.url.host === 'acme.sharepoint.com');
    expect(download?.authorization).toBeUndefined();
    for (const request of requests.filter((each) => each.url.host === 'graph.microsoft.com')) {
      expect(request.authorization).toBe('Bearer fixture-graph-token');
    }
  });

  it("captures a file's cTag, marked as the content's tag, and a page's listed eTag as the revision", async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const { pages } = await wholeSite(reader);
    // Re-pinned for wave 17 (the reader contract by revision): a file's cTag carries its mark
    // (X-1), and a site page's revision is the eTag its listing gives, where it was its
    // publishing version, which the listing is not held against.
    expect(pages.map((page) => page.sourceRevision)).toEqual([
      'c:"c:{11111111-1111-4111-8111-111111111111},7"',
      'c:"c:{22222222-2222-4222-8222-222222222222},3"',
      'c:"c:{44444444-4444-4444-8444-444444444444},2"',
      undefined,
      '"{0A1B2C3D-0000-4000-8000-000000000001},3"',
      '"{0A1B2C3D-0000-4000-8000-000000000002},0"',
      '"{0A1B2C3D-0000-4000-8000-000000000003},1"',
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
      // Re-pinned for wave 17 (D-8): a deletion's delta item carries no date, so the read dates it.
      datedBySource: false,
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
      // Re-pinned for wave 17 (D-8): every reader says whether the page's date is its source's own.
      datedBySource: true,
      // Re-pinned for wave 17: the listed eTag, where it was the publishing version.
      sourceRevision: '"{0A1B2C3D-0000-4000-8000-000000000001},3"',
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
      // Re-pinned for wave 17 (D-8): every reader says whether the page's date is its source's own.
      datedBySource: true,
      // Re-pinned for wave 17 (X-1): marked as the content's tag.
      sourceRevision: 'c:"c:{22222222-2222-4222-8222-222222222222},3"',
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
      // Re-pinned for D-7: the deck and the PDF say they are of a kind Day0 does not read in
      // their entries' own field; the file too large to read carries none and is a failure.
      {
        ref: 'file-01DECK',
        reason:
          '"Q3 board deck.pptx" is a slide deck, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site\'s own pages.',
        kind: 'not-read',
      },
      {
        ref: 'file-01HUGE',
        reason: '"full-crm-export.md" is 5 MiB, larger than the 2 MiB Day0 reads of one file.',
      },
      {
        ref: 'file-01SCAN',
        reason:
          '"Signed policy.pdf" is a PDF, which Day0 does not read: from a SharePoint library it reads Markdown files, Word documents (.docx) and the site\'s own pages.',
        kind: 'not-read',
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

  it('never stores a web page that answered in a file’s place, whatever type it says it is (W15-R30)', async (): Promise<void> => {
    // On the base a captive portal's page at the download host was stored as the Markdown file.
    const portal = '<!doctype html>\n<html><body><h1>Sign in to continue</h1></body></html>';
    for (const type of ['text/html; charset=utf-8', 'application/octet-stream']) {
      const { reader } = readerOnTenant((request) =>
        request.url.host === 'acme.sharepoint.com' &&
        request.url.searchParams.get('UniqueId') === '01CLOSE'
          ? new Response(portal, { status: 200, headers: { 'content-type': type } })
          : undefined,
      );
      const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
      expect(batch.unread[0], type).toEqual({
        ref: 'file-01CLOSE',
        reason:
          '"close-the-quarter.md" came back from acme.sharepoint.com as a web page, not the document itself, so something between Day0 and SharePoint (a proxy or a sign-in page) may have answered for it: ask IT whether the machine Day0\'s backend runs on reaches acme.sharepoint.com directly.',
      });
      expect(batch.pages.map((page) => page.ref)).toEqual(['file-01ESCAL']);
    }
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

  it('follows an empty delta page’s nextLink to the delta link, so the files after it are read (W15-R30)', async (): Promise<void> => {
    // Graph may answer a delta page with no entries and a nextLink: the walk ends only at the
    // delta link. On the base it ended on the empty page, and the finish pruned the library.
    const NEXT = `https://graph.microsoft.com/v1.0/sites/${SITE_ID}/drive/root/delta?token=fixture-delta-page-2`;
    const { reader, requests } = readerOnTenant((request) =>
      request.url.pathname.endsWith('/drive/root/delta') && !request.url.searchParams.has('token')
        ? json(200, { value: [], '@odata.nextLink': NEXT })
        : undefined,
    );
    const { pages } = await wholeSite(reader);
    expect(pages.map((page) => page.ref)).toContain('file-01OPSZH');
    expect(walked(requests).slice(0, 2)).toEqual(['files start', 'files fixture-delta-page-2']);
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

  it('names a site page nested too deeply to convert, or larger than it reads of one answer, unread, and reads the page beside it (W15-R9, W15-R11)', async (): Promise<void> => {
    const deep = `${'<div>'.repeat(3_000)}x${'</div>'.repeat(3_000)}`;
    const big = `<p>${'x'.repeat(17 * 1024 * 1024)}</p>`;
    for (const [innerHtml, reason] of [
      [
        deep,
        '"How to refresh the pipeline tile" is not read: it is laid out too deeply for Day0 to convert: lists, tables or quotations inside one another, many levels down.',
      ],
      [
        big,
        '"How to refresh the pipeline tile" is larger than the 16 MiB Day0 reads of one SharePoint page.',
      ],
    ] as const) {
      const { reader } = readerOnTenant((request) =>
        request.url.pathname.endsWith(
          '/pages/0a1b2c3d-0000-4000-8000-000000000001/microsoft.graph.sitePage',
        )
          ? json(200, { canvasLayout: { verticalSection: { webparts: [{ innerHtml }] } } })
          : undefined,
      );
      const cursor = `sp:${JSON.stringify({ phase: 'pages', siteId: SITE_ID, skip: 0 })}`;
      const batch = await reader.listPageBatch(site, SECRET, cursor, 3);
      expect(batch.unread, reason).toEqual([
        { ref: 'page-0a1b2c3d-0000-4000-8000-000000000001', reason },
      ]);
      expect(batch.pages.map((page) => page.ref)).toEqual([
        'page-0a1b2c3d-0000-4000-8000-000000000002',
      ]);
    }
  });

  it('names a file whose download runs past the bound of the checked fetch unread, and reads the rest (W15-R11)', async (): Promise<void> => {
    // Reader 3's pinned.mts: listed small, the stream itself goes past 16 MiB. The checked
    // fetch bounds its own body and says so in its own error, which is the file's, not the batch's.
    const tenant = providerFake('sharepoint');
    const download = pinnedPageFetch(
      { url: new URL('https://acme.sharepoint.com/'), addresses: ['203.0.113.7'] },
      MAX_WORD_BYTES,
      { http: neverDialled, https: streamOf(18, 1024 * 1024) },
    );
    const reader = new SharePointReader({
      fetch: tenant.fetch,
      download: async (input: URL, init: RequestInit): Promise<Response> =>
        input.searchParams.get('UniqueId') === '01ESCAL'
          ? await download(input, init)
          : await tenant.fetch(input, init),
      sleep: async (): Promise<void> => undefined,
    });
    const batch = await reader.listPageBatch(site, SECRET, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: 'file-01ESCAL',
      reason: '"Escalation paths.docx" is larger than the 16 MiB Day0 reads of one Word document.',
    });
    expect(batch.pages.map((page) => page.ref)).toEqual(['file-01CLOSE']);
  });
});

describe("a SharePoint page's date (wave 17, D-8)", (): void => {
  it('says a file and a site page that SharePoint dates are dated by their source', async (): Promise<void> => {
    const { reader } = readerOnTenant();
    const { pages } = await wholeSite(reader);
    const dated = new Map(pages.map((page) => [page.ref, page.datedBySource]));
    expect(dated.get('file-01CLOSE')).toBe(true);
    expect(dated.get('page-0a1b2c3d-0000-4000-8000-000000000001')).toBe(true);
    // A deleted file's time is the read's: the delta item of a deletion carries no date.
    expect(dated.get('file-01OLD')).toBe(false);
    expect([...dated.values()].every((value) => typeof value === 'boolean')).toBe(true);
  });

  it('says a page with no date from its source is dated by the read: datedBySource false', async (): Promise<void> => {
    const { reader } = readerOnTenant((request) => {
      const path = request.url.pathname;
      if (path.endsWith('/drive/root/delta') && !request.url.searchParams.has('token')) {
        return json(200, fixtureJsonWithout('sharepoint', 'delta-1.json', 'lastModifiedDateTime'));
      }
      return path.endsWith('/pages/0a1b2c3d-0000-4000-8000-000000000001/microsoft.graph.sitePage')
        ? json(200, fixtureJsonWithout('sharepoint', 'page-refresh.json', 'lastModifiedDateTime'))
        : undefined;
    });
    const { pages } = await wholeSite(reader);
    for (const ref of ['file-01CLOSE', 'page-0a1b2c3d-0000-4000-8000-000000000001']) {
      expect(pages.find((page) => page.ref === ref)).toMatchObject({
        updatedAt: T0,
        datedBySource: false,
      });
    }
    // The file beside it, which the second delta page dates, is still its source's.
    expect(pages.find((page) => page.ref === 'file-01OPSZH')?.datedBySource).toBe(true);
  });
});

/** A reader on a generated library, its clock still. */
function readerOnLibrary(
  library: LibraryFake,
  now: () => number = (): number => T0,
): SharePointReader {
  return new SharePointReader({
    fetch: library.fetch,
    download: library.fetch,
    now,
    sleep: async (): Promise<void> => undefined,
  });
}

/** The ref of a library's file, and of its site page, by the page's place in the library. */
const fileRef = (index: number): string => `file-01LIB${String(index).padStart(6, '0')}`;
const pageRef = (index: number): string =>
  `page-0a1b2c3d-0000-4000-8000-${String(index).padStart(12, '0')}`;

/** The fields each listing is asked for (the wave file's 5.5). */
const FILE_SELECT =
  'id,name,size,file,folder,deleted,lastModifiedDateTime,webUrl,eTag,cTag,parentReference';
const PAGE_SELECT = 'id,name,title,eTag,lastModifiedDateTime,webUrl,publishingState';

describe('the SharePoint reader contract by revision (wave 17, 17-X)', (): void => {
  it("reads a thousand unchanged pages for the listing's requests and no body request, and one changed page alone", async (): Promise<void> => {
    // 960 files in the library and 40 site pages: a thousand pages.
    const library = libraryFake('sharepoint', { pages: 1_000, sitePages: 40 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const clock = { now: (): number => T0 };
    const first = await readWhole(reader, site, SECRET, marks, clock);
    expect(first.read).toHaveLength(1_000);
    expect(library.counts().bodies).toBe(1_000);
    // The whole first read, as the guide prints it.
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.sharepoint.first);

    library.reset();
    const unchanged = await readWhole(reader, site, SECRET, marks, clock);
    expect(unchanged.read).toEqual([]);
    expect(unchanged.unread).toEqual([]);
    expect(unchanged.kept).toHaveLength(1_000);
    // The delta's 961 items (the root folder and the files) are 39 listing pages of 25 and the
    // site's 40 pages two; the first batch signs in and looks the site up, and every later batch
    // reads with the token it handed back (X-1; wave 18, 18-X).
    expect(library.counts()).toEqual({ token: 1, lookup: 1, listing: 41, body: 0, bodies: 0 });
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.sharepoint.unchanged);
    expect(unchanged.batches).toBe(41);
    expect(unchanged.handedBack).toEqual([
      { token: 'fixture-graph-token', expiresAt: T0 + 3_599_000 },
    ]);

    library.edit(500);
    library.reset();
    const edited = await readWhole(reader, site, SECRET, marks, clock);
    expect(edited.read.map((page) => page.ref)).toEqual([fileRef(500)]);
    expect(edited.read[0].markdown).toContain('Edited 1.');
    expect(edited.kept).toHaveLength(999);
    // A file costs the redirect and the download.
    expect(library.counts()).toEqual({ token: 1, lookup: 1, listing: 41, body: 2, bodies: 1 });
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.sharepoint.oneChanged);

    library.edit(980);
    library.reset();
    const pageEdited = await readWhole(reader, site, SECRET, marks, clock);
    expect(pageEdited.read.map((page) => page.ref)).toEqual([pageRef(980)]);
    expect(pageEdited.kept).toHaveLength(999);
    // A site page costs one request.
    expect(library.counts()).toEqual({ token: 1, lookup: 1, listing: 41, body: 1, bodies: 1 });
  });

  it('asks each listing for the fields it reads, and the contract once a listing page before any body', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 30, sitePages: 5 });
    const reader = readerOnLibrary(library);
    const whole = await readWhole(reader, site, SECRET, new Map());
    const listings = library.requests.filter((request) => request.kind === 'listing');
    expect(listings[0].url.searchParams.get('$select')).toBe(FILE_SELECT);
    expect(listings.at(-1)?.url.searchParams.get('$select')).toBe(PAGE_SELECT);
    // 25 files and the root folder's page, the last file, then the five site pages.
    expect(whole.asked.map((refs) => refs.length)).toEqual([24, 1, 5]);
    expect(whole.asked[2]).toEqual([25, 26, 27, 28, 29].map(pageRef));
    expect(whole.read).toHaveLength(30);
  });

  it('reads a page the listing gives no revision for as before, at every sync', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 50, sitePages: 10 });
    library.pages[3].listsRevision = false;
    library.pages[45].listsRevision = false;
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    for (const sync of [2, 3]) {
      library.reset();
      const again = await readWhole(reader, site, SECRET, marks);
      expect(
        again.read.map((page) => page.ref),
        `sync ${sync}`,
      ).toEqual([fileRef(3), pageRef(45)]);
      expect(again.read.map((page) => page.sourceRevision)).toEqual([undefined, undefined]);
      expect(again.kept).toHaveLength(48);
    }
  });

  it('keeps a site page whose title the store writes otherwise: its spaces closed up, a closing # dropped (the second pass)', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 30, sitePages: 5 });
    // As the title stands at its source before anything is read.
    library.rename(27, 'Q3  close plan #');
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    expect(marks.get(pageRef(27))?.title).toBe('Q3 close plan');
    library.reset();
    const again = await readWhole(reader, site, SECRET, marks);
    expect(again.read).toEqual([]);
    expect(again.kept).toHaveLength(30);
    expect(library.counts().body).toBe(0);
  });

  it('keeps a Word document whose file name the store writes otherwise (the second pass)', async (): Promise<void> => {
    const listing = JSON.parse(
      new TextDecoder().decode(fixtureBytes('sharepoint', 'delta-1.json')),
    ) as { value: Array<Record<string, unknown>> };
    const { reader, requests } = readerOnTenant((request) =>
      request.url.pathname.endsWith('/drive/root/delta') && request.url.searchParams.has('$top')
        ? json(200, {
            ...listing,
            value: listing.value.map((item) =>
              item.id === '01ESCAL' ? { ...item, name: 'Escalation  paths.docx' } : item,
            ),
          })
        : undefined,
    );
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks, { limit: 3 });
    expect(first.read.find((page) => page.ref === 'file-01ESCAL')?.title).toBe('Escalation  paths');
    expect(marks.get('file-01ESCAL')?.title).toBe('Escalation paths');
    requests.length = 0;
    const again = await readWhole(reader, site, SECRET, marks, { limit: 3 });
    expect(again.kept.map((page) => page.ref)).toContain('file-01ESCAL');
    expect(walked(requests).filter((line) => line.includes('01ESCAL'))).toEqual([]);
  });

  it('goes by the last occurrence of a file its delta page lists twice, as Graph says to: a file kept by the first and changed by the last is read, and not kept', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 4 });
    let changedSince = false;
    const fetch: LibraryFake['fetch'] = async (input, init) => {
      const answer = await library.fetch(input, init);
      const url = new URL(input instanceof Request ? input.url : input);
      if (!changedSince || !url.pathname.endsWith('/drive/root/delta')) return answer;
      const body = (await answer.json()) as { value: Array<Record<string, unknown>> };
      const earlier = body.value.find((item) => item.id === '01LIB000001');
      if (earlier === undefined) throw new Error('the delta page does not list the file');
      // The feed shows the file as it was, then again as it is now.
      return json(200, {
        ...body,
        value: [...body.value, { ...earlier, cTag: '"c:{changed-since},9"' }],
      });
    };
    const reader = new SharePointReader({
      fetch,
      download: fetch,
      now: (): number => T0,
      sleep: async (): Promise<void> => undefined,
    });
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    changedSince = true;
    library.reset();
    const again = await readWhole(reader, site, SECRET, marks);
    expect(again.read.map((page) => [page.ref, page.sourceRevision])).toEqual([
      [fileRef(1), 'c:"c:{changed-since},9"'],
    ]);
    expect(again.kept.map((page) => page.ref)).toEqual([0, 2, 3].map(fileRef));
  });

  it('reads a renamed page, though its revision is the stored one', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 50, sitePages: 10 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    const before = { file: marks.get(fileRef(7)), page: marks.get(pageRef(42)) };
    // A file's rename moves its name and address and leaves its cTag; the page's leaves its eTag.
    library.rename(7, 'Close the quarter');
    library.rename(42, 'Escalation paths 2027');
    library.reset();
    const renamed = await readWhole(reader, site, SECRET, marks);
    expect(renamed.read.map((page) => [page.ref, page.title, page.sourceRevision])).toEqual([
      [fileRef(7), 'close-the-quarter', before.file?.revision],
      [pageRef(42), 'Escalation paths 2027', before.page?.revision],
    ]);
    expect(renamed.read[0].url).toBe(
      'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents/close-the-quarter.md',
    );
    expect(renamed.kept).toHaveLength(48);
  });

  it('keeps a site page checked out at its source and unchanged, and marks it a draft', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 50, sitePages: 10 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    library.archive(44);
    library.reset();
    const after = await readWhole(reader, site, SECRET, marks);
    expect(after.read).toEqual([]);
    expect(library.counts().body).toBe(0);
    expect(after.kept.find((page) => page.ref === pageRef(44))).toEqual({
      ref: pageRef(44),
      nativeStatus: 'draft',
      datedBySource: true,
    });
    // A page its listing says nothing of carries no status, so the stored one is cleared.
    expect(after.kept.find((page) => page.ref === pageRef(43))).toEqual({
      ref: pageRef(43),
      datedBySource: true,
    });
    expect(after.kept).toHaveLength(50);
  });

  it('keeps a delta item with no cTag by its eTag, and never compares an eTag with a stored cTag (X-1)', async (): Promise<void> => {
    // Graph's reference: the delta omits cTag for OneDrive for Business on a create or a modify.
    const library = libraryFake('sharepoint', { pages: 30, contentTags: false });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks);
    const eTag = '"{0A1B2C3D-0000-4000-8000-000000000000},0"';
    expect(first.read[0].sourceRevision).toBe(`e:${eTag}`);
    library.reset();
    const unchanged = await readWhole(reader, site, SECRET, marks);
    expect(unchanged.kept).toHaveLength(30);
    expect(library.counts().body).toBe(0);

    // The same text stored as a cTag, marked or as 0.20.0 stored it, is not this item's revision.
    for (const storedAsContentTag of [`c:${eTag}`, eTag]) {
      marks.set(fileRef(0), { ...first.read[0], revision: storedAsContentTag });
      library.reset();
      const again = await readWhole(reader, site, SECRET, marks);
      expect(
        again.read.map((page) => page.ref),
        storedAsContentTag,
      ).toEqual([fileRef(0)]);
    }
  });

  it("marks a file's revision with which tag it is, and keeps a file 0.20.0 stored by its unmarked cTag", async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 30 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks);
    const cTag = '"c:{0A1B2C3D-0000-4000-8000-000000000000},0"';
    expect(first.read[0].sourceRevision).toBe(`c:${cTag}`);
    // As 0.20.0 stored it: the cTag itself. It is still the content's tag, so nothing is read.
    for (const [ref, mark] of marks) marks.set(ref, { ...mark, revision: mark.revision.slice(2) });
    expect(marks.get(fileRef(0))?.revision).toBe(cTag);
    library.reset();
    const upgraded = await readWhole(reader, site, SECRET, marks);
    expect(upgraded.read).toEqual([]);
    expect(upgraded.kept).toHaveLength(30);
    // A stored eTag is not compared with the item's cTag, whatever its text.
    marks.set(fileRef(1), {
      ...first.read[1],
      revision: `e:${first.read[1].sourceRevision?.slice(2)}`,
    });
    const mixed = await readWhole(reader, site, SECRET, marks);
    expect(mixed.read.map((page) => page.ref)).toEqual([fileRef(1)]);
  });

  it('reads a site page stored at 0.20.0 with its version once more, then keeps it by its eTag', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 5, sitePages: 5 });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks);
    expect(first.read[0].sourceRevision).toBe('"{0A1B2C3D-0000-4000-8000-000000000000},0"');
    // As 0.20.0 stored a page: its publishing version.
    for (const [ref, mark] of marks) marks.set(ref, { ...mark, revision: '1.0' });
    const upgraded = await readWhole(reader, site, SECRET, marks);
    expect(upgraded.read).toHaveLength(5);
    library.reset();
    const after = await readWhole(reader, site, SECRET, marks);
    expect(after.read).toEqual([]);
    expect(library.counts().body).toBe(0);
  });

  it('says a kept page with no date from its source was dated by the read', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 4, sitePages: 2 });
    library.pages[0].editedAt = undefined;
    library.pages[3].editedAt = undefined;
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks);
    expect(first.read.map((page) => page.datedBySource)).toEqual([false, true, true, false]);
    const kept = (await readWhole(reader, site, SECRET, marks)).kept;
    expect(kept.map((page) => page.datedBySource)).toEqual([false, true, true, false]);
  });

  it('reads a site page whose listing leaves its publishing state out, since a kept page takes its status from the listing', async (): Promise<void> => {
    // Whether the listing answers publishingState under $select is unverified (V17-3): where it
    // does not, keeping the page would clear a draft's status, so the page is read.
    const library = libraryFake('sharepoint', {
      pages: 6,
      sitePages: 3,
      withheld: ['publishingState'],
    });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    const again = await readWhole(reader, site, SECRET, marks);
    expect(again.read.map((page) => page.ref)).toEqual([3, 4, 5].map(pageRef));
    expect(again.kept.map((page) => page.ref)).toEqual([0, 1, 2].map(fileRef));
  });

  it('reads a Markdown file whose listing gives no address, since nothing else of it would show a rename', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 3, withheld: ['webUrl'] });
    const reader = readerOnLibrary(library);
    const marks: StoredMarks = new Map();
    const first = await readWhole(reader, site, SECRET, marks);
    expect(first.read.map((page) => page.url)).toEqual([undefined, undefined, undefined]);
    const again = await readWhole(reader, site, SECRET, marks);
    expect(again.read).toHaveLength(3);
    expect(again.kept).toEqual([]);
  });

  it('reads as before with no contract to ask, and for a page the sync does not answer for', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 6, sitePages: 2 });
    const reader = readerOnLibrary(library);
    const batch = await reader.listPageBatch(site, SECRET, undefined, 25);
    expect(batch.pages).toHaveLength(4);
    expect(batch).not.toHaveProperty('kept');
    const marks: StoredMarks = new Map();
    await readWhole(reader, site, SECRET, marks);
    // The sync offers no page whose stored text holds a value its owner stored since.
    marks.delete(fileRef(2));
    const again = await reader.listPageBatch(site, SECRET, undefined, 25, storedIn(marks));
    expect(again.pages.map((page) => page.ref)).toEqual([fileRef(2)]);
    expect(again.kept?.map((page) => page.ref)).toEqual([fileRef(0), fileRef(1), fileRef(3)]);
  });
});

describe("the SharePoint reader's token across a sync's batches (wave 18, 18-X; X-1)", (): void => {
  /** A token an earlier batch handed back that Graph no longer takes (revoked, or lapsed early). */
  const REVOKED = { token: 'revoked-graph-token', expiresAt: T0 + 3_000_000 };

  it('asks for a token again mid-sync once the one it holds is past its expiry, and hands the new one back', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 100 });
    let clock = T0;
    const reader = readerOnLibrary(library, (): number => clock);
    const marks: StoredMarks = new Map();
    const one = await reader.listPageBatch(site, SECRET, undefined, 25, storedIn(marks));
    expect(one.token).toEqual({ token: 'fixture-graph-token', expiresAt: T0 + 3_599_000 });
    const two = await reader.listPageBatch(
      site,
      SECRET,
      one.nextCursor,
      25,
      storedIn(marks),
      one.token,
    );
    // Read with the token handed back: none asked for, none handed back (the sync keeps it).
    expect(two.pages).toHaveLength(25);
    expect(two.token).toBeUndefined();
    expect(library.counts().token).toBe(1);

    // A minute before Graph's 3,599 s are up: inside the margin, so the token is not used.
    clock = T0 + 3_599_000 - 60_000;
    const three = await reader.listPageBatch(
      site,
      SECRET,
      two.nextCursor,
      25,
      storedIn(marks),
      one.token,
    );
    expect(three.pages).toHaveLength(25);
    expect(three.token).toEqual({ token: 'fixture-graph-token', expiresAt: clock + 3_599_000 });
    expect(library.counts().token).toBe(2);
  });

  it('asks for a token again when Graph refuses the one handed back, and reads the batch on', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 30 });
    const reader = readerOnLibrary(library);
    const batch = await reader.listPageBatch(site, SECRET, undefined, 25, undefined, REVOKED);
    // The first delta page's 25 items hold the library's root folder and 24 files.
    expect(batch.pages).toHaveLength(24);
    expect(batch.token).toEqual({ token: 'fixture-graph-token', expiresAt: T0 + 3_599_000 });
    // The site's lookup refused under the handed token, then a sign-in, then the lookup again.
    expect(library.requests.slice(0, 3).map((request) => [request.kind, request.status])).toEqual([
      ['lookup', 401],
      ['token', 200],
      ['lookup', 200],
    ]);
    expect(library.counts().token).toBe(1);
  });

  it('never puts the token it hands back, or the one it was handed, in a log line or a cursor', async (): Promise<void> => {
    const library = libraryFake('sharepoint', { pages: 60, sitePages: 10 });
    const reader = readerOnLibrary(library);
    const lines: string[] = [];
    const cursors: string[] = [];
    const logged = vi.spyOn(console, 'log').mockImplementation((line: unknown): void => {
      lines.push(String(line));
    });
    try {
      const first = await reader.listPageBatch(site, SECRET, undefined, 25, undefined, REVOKED);
      let cursor = first.nextCursor;
      let token = first.token;
      while (cursor !== undefined) {
        cursors.push(cursor);
        const batch = await reader.listPageBatch(site, SECRET, cursor, 25, undefined, token);
        token = batch.token ?? token;
        cursor = batch.nextCursor;
      }
    } finally {
      logged.mockRestore();
    }
    // The refusal of the handed token is logged, by the provider and the source alone.
    expect(lines.some((line) => line.includes('token refused'))).toBe(true);
    expect(cursors.length).toBeGreaterThan(1);
    for (const said of [...lines, ...cursors]) {
      expect(said).not.toContain('fixture-graph-token');
      expect(said).not.toContain(REVOKED.token);
    }
  });
});
