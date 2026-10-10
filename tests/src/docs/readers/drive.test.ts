import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { GoogleDriveReader } from '../../../../src/docs/readers/drive';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import { providerFake, type FakeOverride, type FakeRequest } from '../../../fixtures/readers/fake';

/** 10 October 2026, 09:00 UTC: the clock every test starts at. */
const T0 = Date.UTC(2026, 9, 10, 9, 0, 0);

const ACCOUNT = 'day0-reader@acme-docs.iam.gserviceaccount.com';
const ROOT = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

// A key pair made for this run: the fake checks each assertion's signature against its public
// half, as Google does against the one it holds. Nothing reads the key's text.
const KEYS = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const SECRET = JSON.stringify({
  type: 'service_account',
  client_email: ACCOUNT,
  private_key: KEYS.privateKey,
});

const folder: DocSourceRecord = {
  _id: 'jd7googledrive000001' as Id<'docSources'>,
  label: 'Runbooks folder',
  kind: 'drive',
  locator: `https://drive.google.com/drive/folders/${ROOT}`,
};

/** A reader on the fixture project with a clock that moves only when the reader waits. */
function readerOnDrive(override?: FakeOverride): {
  reader: GoogleDriveReader;
  requests: FakeRequest[];
  sleeps: number[];
} {
  let clock = T0;
  const sleeps: number[] = [];
  const drive = providerFake('drive', {
    now: (): number => clock,
    override,
    publicKey: KEYS.publicKey,
  });
  const reader = new GoogleDriveReader({
    fetch: drive.fetch,
    now: (): number => clock,
    sleep: async (ms: number): Promise<void> => {
      sleeps.push(ms);
      clock += ms;
    },
  });
  return { reader, requests: drive.requests, sleeps };
}

/** Every batch of the folder, three entries at a time. */
async function wholeFolder(
  reader: GoogleDriveReader,
): Promise<{ pages: ReadPageBatch['pages']; unread: ReadPageBatch['unread'][number][] }> {
  const pages: ReadPageBatch['pages'] = [];
  const unread: ReadPageBatch['unread'][number][] = [];
  let cursor: string | undefined;
  do {
    const batch = await reader.listPageBatch(folder, SECRET, cursor, 3);
    expect(batch.pages.length + batch.unread.length).toBeLessThanOrEqual(3);
    pages.push(...batch.pages);
    unread.push(...batch.unread);
    cursor = batch.nextCursor;
  } while (cursor !== undefined);
  return { pages, unread };
}

/** A Drive answer a test puts in place of the fixture's. */
function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/** A Drive error body with this reason, as the error guide prints one. */
function driveError(code: number, reason: string, message: string): unknown {
  return { error: { errors: [{ domain: 'usageLimits', reason, message }], code, message } };
}

/** The listings a run asked for, as the folder each named and its page token. */
function listings(requests: readonly FakeRequest[]): string[] {
  return requests
    .filter((request) => request.url.pathname === '/drive/v3/files')
    .map((request) => {
      const parent = /^'([^']+)' in parents/.exec(request.url.searchParams.get('q') ?? '')?.[1];
      return `${parent === ROOT ? 'root' : parent}|${request.url.searchParams.get('pageToken') ?? ''}`;
    });
}

describe('the Google Drive documentation reader', (): void => {
  it('follows nextPageToken to the end of the folder, then reads the folders under it', async (): Promise<void> => {
    const { reader, requests } = readerOnDrive();
    const { pages, unread } = await wholeFolder(reader);
    expect(pages.map((page) => page.title)).toEqual([
      'Close the quarter',
      'Escalation paths',
      '运维手册',
      'Old close process',
      '刷新看板',
    ]);
    expect(unread.map((page) => page.ref)).toEqual([
      '1SlidesBoardDeck00000000000000000001',
      '1DocFullCrmExport000000000000000001',
    ]);
    expect(listings(requests)).toEqual([
      'root|',
      'root|fixture-page-2',
      '1ArchiveFolder0000000000000000001|',
    ]);
    for (const request of requests.filter((each) => each.url.host === 'www.googleapis.com')) {
      expect(request.authorization).toBe('Bearer fixture-google-token');
    }
    // The folder is checked once, before its first listing.
    expect(
      requests.filter((request) => request.url.pathname.endsWith(`/files/${ROOT}`)),
    ).toHaveLength(1);
  });

  it('exports a Google Doc as Markdown under its name, with its version as the revision', async (): Promise<void> => {
    const { reader, requests } = readerOnDrive();
    const [close] = (await reader.listPageBatch(folder, SECRET, undefined, 3)).pages;
    expect(close).toEqual({
      sourceId: folder._id,
      ref: '1DocCloseTheQuarter00000000000000001',
      title: 'Close the quarter',
      url: 'https://docs.google.com/document/d/1DocCloseTheQuarter00000000000000001/edit?usp=drivesdk',
      markdown:
        '# Close the quarter\n\n## Steps\n\n1. Lock the ledger.\n2. Refresh the pipeline tile.\n\n| Step | Owner |\n| :--- | :--- |\n| Lock the ledger | Finance |',
      updatedAt: Date.UTC(2026, 9, 1, 9, 30, 0),
      sourceRevision: '41',
    });
    const exported = requests.find((request) => request.url.pathname.endsWith('/export'));
    expect(exported?.url.searchParams.get('mimeType')).toBe('text/markdown');
  });

  it('converts a Word document in the folder where it runs (RM9 (b1))', async (): Promise<void> => {
    const { reader } = readerOnDrive();
    const word = (await reader.listPageBatch(folder, SECRET, undefined, 3)).pages[1];
    expect(word).toMatchObject({
      ref: '1WordEscalationPaths0000000000000001',
      title: 'Escalation paths',
      sourceRevision: '5',
    });
    expect(word.markdown).toContain('| Severity | Who |\n| --- | --- |\n| SEV1 | Duty manager |');
    expect(word.markdown.startsWith('# Escalation paths\n\nCall the **duty manager** first.')).toBe(
      true,
    );
  });

  it('names a Word document that grew past the bound after it was listed unread, and reads the rest (second pass)', async (): Promise<void> => {
    const { reader } = readerOnDrive((request) =>
      request.url.searchParams.get('alt') === 'media'
        ? new Response(new Uint8Array(17 * 1024 * 1024), { status: 200 })
        : undefined,
    );
    const batch = await reader.listPageBatch(folder, SECRET, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '1WordEscalationPaths0000000000000001',
      reason: '"Escalation paths.docx" is larger than the 16 MiB Day0 reads of one Word document.',
    });
    expect(batch.pages.map((page) => page.title)).toEqual(['Close the quarter']);
  });

  it('says a document in the bin is archived, keeping its text, and nothing of any other', async (): Promise<void> => {
    const { reader } = readerOnDrive();
    const { pages } = await wholeFolder(reader);
    expect(pages.find((page) => page.title === 'Old close process')).toMatchObject({
      nativeStatus: 'archived',
      sourceRevision: '12',
      markdown: '# Old close process\n\nThe old process. Do not use.',
    });
    for (const page of pages.filter((each) => each.title !== 'Old close process')) {
      expect(page).not.toHaveProperty('nativeStatus');
    }
    const chinese = pages.filter((page) => !/[A-Za-z]/.test(page.title));
    expect(chinese.map((page) => page.title)).toEqual(['运维手册', '刷新看板']);
    expect(chinese[0].markdown).toBe('# 运维手册\n\n每周一上午检查备份。');
    expect(new Set(chinese.map((page) => mirroredDocSlug(folder._id, page.ref))).size).toBe(2);
  });

  it('names a document past the 10 MB Google exports, and a slide deck, unread with the reason', async (): Promise<void> => {
    const { reader } = readerOnDrive();
    const { unread } = await wholeFolder(reader);
    expect(unread).toEqual([
      {
        ref: '1SlidesBoardDeck00000000000000000001',
        reason:
          '"Q3 board deck" is a slide deck, which Day0 does not read: from a Google Drive folder it reads Google Docs and Word documents (.docx).',
      },
      {
        ref: '1DocFullCrmExport000000000000000001',
        reason:
          '"Full CRM export" is larger than the 10 MB Google exports, so Day0 does not read it.',
      },
    ]);
  });

  it('backs off a 403 userRateLimitExceeded and a 429, doubling its wait, then reads on', async (): Promise<void> => {
    let refusals = 0;
    const { reader, sleeps } = readerOnDrive((request) => {
      if (!request.url.pathname.endsWith('/export') || refusals >= 3) return undefined;
      refusals += 1;
      return refusals === 3
        ? json(429, driveError(429, 'rateLimitExceeded', 'Rate Limit Exceeded'))
        : json(403, driveError(403, 'userRateLimitExceeded', 'User Rate Limit Exceeded'));
    });
    const batch = await reader.listPageBatch(folder, SECRET, undefined, 3);
    expect(sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(batch.pages).toHaveLength(2);
  });

  it('signs a short-lived assertion as the service account for a read-only token, and sends the key nowhere', async (): Promise<void> => {
    const { reader, requests } = readerOnDrive();
    await reader.listPageBatch(folder, SECRET, undefined, 3);
    const [token] = requests;
    expect(token.url.href).toBe('https://oauth2.googleapis.com/token');
    const form = new URLSearchParams(token.body);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    const [header, claims] = (form.get('assertion') ?? '')
      .split('.')
      .slice(0, 2)
      .map((part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as unknown);
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(claims).toEqual({
      iss: ACCOUNT,
      scope: 'https://www.googleapis.com/auth/drive.readonly',
      aud: 'https://oauth2.googleapis.com/token',
      iat: T0 / 1_000,
      exp: T0 / 1_000 + 3_600,
    });
    expect(JSON.stringify(requests)).not.toContain('PRIVATE KEY');
  });

  it('says what IT does when Google refuses the key, and never repeats it', async (): Promise<void> => {
    const other = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const { reader } = readerOnDrive();
    let message = '';
    try {
      await reader.listPageBatch(
        folder,
        JSON.stringify({ client_email: ACCOUNT, private_key: other.privateKey }),
        undefined,
        3,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe(
      "Google refused the service account key this source uses (invalid_grant): the key may have been deleted, or the service account disabled. Ask IT to create a new JSON key for day0-reader@acme-docs.iam.gserviceaccount.com in Google Cloud, then use Rotate on the source's row to paste it.",
    );
    expect(message).not.toContain('PRIVATE KEY');
  });

  it("names the service account's address to share the folder with when Drive finds none, and the API to enable", async (): Promise<void> => {
    const { reader } = readerOnDrive();
    await expect(
      reader.listPageBatch(
        {
          ...folder,
          locator: 'https://drive.google.com/drive/folders/1NotSharedFolder000000000000000001',
        },
        SECRET,
        undefined,
        3,
      ),
    ).rejects.toThrow(
      'Google Drive found no folder at this address that the service account may read (HTTP 404): share the folder with day0-reader@acme-docs.iam.gserviceaccount.com as a Viewer, and check the address. To change the address, unlink the source and link it again.',
    );
    const disabled = readerOnDrive((request) =>
      request.url.host === 'www.googleapis.com'
        ? json(403, driveError(403, 'accessNotConfigured', 'Google Drive API has not been used'))
        : undefined,
    );
    await expect(disabled.reader.listPageBatch(folder, SECRET, undefined, 3)).rejects.toThrow(
      "Google Drive refused this request (HTTP 403, accessNotConfigured): the Google Drive API is not enabled in the service account's Google Cloud project. Ask IT to enable it there (APIs and services, Library, Google Drive API).",
    );
  });

  it('names a document it may not export unread with Google’s reason, and reads the rest', async (): Promise<void> => {
    const { reader } = readerOnDrive((request) =>
      request.url.pathname.endsWith('/files/1DocCloseTheQuarter00000000000000001/export')
        ? json(403, {
            error: {
              errors: [{ domain: 'global', reason: 'cannotExportFile', message: 'No export' }],
              code: 403,
              message: 'No export',
            },
          })
        : undefined,
    );
    const batch = await reader.listPageBatch(folder, SECRET, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '1DocCloseTheQuarter00000000000000001',
      reason:
        'Google Drive would not give "Close the quarter" (HTTP 403, cannotExportFile). Re-sync to try again; if it repeats, ask the document\'s owner whether viewers may download it.',
    });
    expect(batch.pages.map((page) => page.title)).toEqual(['Escalation paths']);
  });

  it('starts the folder again from a cursor that is not its own, and refuses to read without its key', async (): Promise<void> => {
    const { reader, requests } = readerOnDrive();
    await expect(reader.listPageBatch(folder, SECRET, 'yq|live|3', 3)).rejects.toThrow(
      ListingChangedError,
    );
    await expect(reader.listPageBatch(folder, undefined, undefined, 3)).rejects.toThrow(
      "A Google Drive source reads as a service account, and this one has no key: use Rotate on the source's row to paste the service account's JSON key.",
    );
    expect(requests).toEqual([]);
  });
});
