import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { Id } from '../../../../convex/_generated/dataModel';
import { ListingChangedError, type ReadPageBatch } from '../../../../src/docs/readers/batch';
import { GoogleDriveReader } from '../../../../src/docs/readers/drive';
import { mirroredDocSlug, type DocSourceRecord } from '../../../../src/docs/types';
import {
  fixtureJsonWithout,
  providerFake,
  type FakeOverride,
  type FakeRequest,
} from '../../../fixtures/readers/fake';
import { THOUSAND_PAGE_REQUESTS } from '../../../fixtures/readers/guide-counts';
import {
  libraryFake,
  type LibraryFake,
  type LibraryOptions,
} from '../../../fixtures/readers/library';
import { readWhole, storedIn, type StoredMarks } from '../../../fixtures/readers/stored';

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
      // Re-pinned for wave 17 (D-8): every reader says whether the page's date is its source's own.
      datedBySource: true,
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
      // Re-pinned for D-7: a page of a kind Day0 does not read says so in its entry's own field;
      // a read that failed, the entry after it, carries none and is recorded as failed.
      {
        ref: '1SlidesBoardDeck00000000000000000001',
        reason:
          '"Q3 board deck" is a slide deck, which Day0 does not read: from a Google Drive folder it reads Google Docs and Word documents (.docx).',
        kind: 'not-read',
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

  it('never stores a web page that answered in a document’s place: a captive portal’s 200 is named unread (W15-R30)', async (): Promise<void> => {
    // On the base the portal's page was stored as "Close the quarter", over the real one.
    const { reader } = readerOnDrive((request) =>
      request.url.pathname.endsWith('/files/1DocCloseTheQuarter00000000000000001/export')
        ? new Response(
            '<!DOCTYPE html><html><body><h1>Sign in to the guest network</h1></body></html>',
            {
              status: 200,
              headers: { 'content-type': 'text/html; charset=utf-8' },
            },
          )
        : undefined,
    );
    const batch = await reader.listPageBatch(folder, SECRET, undefined, 3);
    expect(batch.unread[0]).toEqual({
      ref: '1DocCloseTheQuarter00000000000000001',
      reason:
        '"Close the quarter" came back from www.googleapis.com as a web page, not the document itself, so something between Day0 and Google Drive (a proxy or a sign-in page) may have answered for it: ask IT whether the machine Day0\'s backend runs on reaches www.googleapis.com directly.',
    });
    expect(batch.pages.map((page) => page.title)).toEqual(['Escalation paths']);
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

describe("a Google Drive document's date (wave 17, D-8)", (): void => {
  it('says a document is dated by its source when Drive gives its modified time', async (): Promise<void> => {
    const { reader } = readerOnDrive();
    const { pages } = await wholeFolder(reader);
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.map((page) => page.datedBySource)).toEqual(pages.map(() => true));
  });

  it('says a document with no date from its source is dated by the read: datedBySource false', async (): Promise<void> => {
    const { reader } = readerOnDrive((request) =>
      request.url.pathname.endsWith('/drive/v3/files') &&
      !request.url.searchParams.has('pageToken') &&
      (request.url.searchParams.get('q') ?? '').startsWith(`'${ROOT}'`)
        ? json(200, fixtureJsonWithout('drive', 'list-root-1.json', 'modifiedTime'))
        : undefined,
    );
    const { pages } = await reader.listPageBatch(folder, SECRET, undefined, 3);
    expect(pages.map((page) => [page.title, page.updatedAt, page.datedBySource])).toEqual([
      ['Close the quarter', T0, false],
      ['Escalation paths', T0, false],
    ]);
  });
});

/** A generated library in the fixture folder, and a reader on it with its clock still. */
function driveLibrary(
  options: Omit<LibraryOptions, 'publicKey'>,
  now: () => number = (): number => T0,
): {
  library: LibraryFake;
  reader: GoogleDriveReader;
} {
  const library = libraryFake('drive', { ...options, publicKey: KEYS.publicKey });
  const reader = new GoogleDriveReader({
    fetch: library.fetch,
    now,
    sleep: async (): Promise<void> => undefined,
  });
  return { library, reader };
}

/** The ref of a library's document by its place in the library. */
const libraryRef = (index: number): string => `1LibDoc${String(index).padStart(26, '0')}`;

describe('the Google Drive reader contract by revision (wave 17, 17-X)', (): void => {
  it("reads a thousand unchanged documents for the listing's requests and no body request, and one changed document alone", async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 1_000 });
    const marks: StoredMarks = new Map();
    const clock = { now: (): number => T0 };
    const first = await readWhole(reader, folder, SECRET, marks, clock);
    expect(first.read).toHaveLength(1_000);
    expect(library.counts().bodies).toBe(1_000);
    // The whole first read, as the guide prints it.
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.drive.first);

    library.reset();
    const unchanged = await readWhole(reader, folder, SECRET, marks, clock);
    expect(unchanged.read).toEqual([]);
    expect(unchanged.kept).toHaveLength(1_000);
    // Forty listing pages of 25; the first batch signs in and checks the folder, and every later
    // batch reads with the token it handed back (X-1; wave 18, 18-X).
    expect(library.counts()).toEqual({ token: 1, lookup: 1, listing: 40, body: 0, bodies: 0 });
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.drive.unchanged);
    expect(unchanged.handedBack).toEqual([
      { token: 'fixture-google-token', expiresAt: T0 + 3_600_000 },
    ]);

    library.edit(500);
    library.reset();
    const edited = await readWhole(reader, folder, SECRET, marks, clock);
    expect(edited.read.map((page) => [page.ref, page.sourceRevision])).toEqual([
      [libraryRef(500), '2'],
    ]);
    expect(edited.read[0].markdown).toContain('Edited 1.');
    expect(edited.kept).toHaveLength(999);
    expect(library.counts()).toEqual({ token: 1, lookup: 1, listing: 40, body: 1, bodies: 1 });
    expect(library.requests).toHaveLength(THOUSAND_PAGE_REQUESTS.drive.oneChanged);
    // The contract is asked once a listing page, by every document it lists.
    expect(edited.asked).toHaveLength(40);
    expect(edited.asked.every((refs) => refs.length === 25)).toBe(true);
  });

  it('reads a document the listing gives no revision for as before, at every sync', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 30 });
    library.pages[3].listsRevision = false;
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    for (const sync of [2, 3]) {
      const again = await readWhole(reader, folder, SECRET, marks);
      expect(
        again.read.map((page) => page.ref),
        `sync ${sync}`,
      ).toEqual([libraryRef(3)]);
      expect(again.kept).toHaveLength(29);
    }
  });

  it('keeps a document whose name the store writes otherwise: its spaces closed up, a closing # dropped (the second pass)', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 5 });
    // As the name stands at its source before anything is read.
    library.rename(1, 'Q3  close plan #');
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    expect(marks.get(libraryRef(1))?.title).toBe('Q3 close plan');
    library.reset();
    const again = await readWhole(reader, folder, SECRET, marks);
    expect(again.read).toEqual([]);
    expect(again.kept).toHaveLength(5);
    expect(library.counts().body).toBe(0);
  });

  it('reads a renamed document, though its revision is the stored one', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 30 });
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    library.rename(7, 'Close the quarter');
    const renamed = await readWhole(reader, folder, SECRET, marks);
    expect(renamed.read.map((page) => [page.ref, page.title, page.sourceRevision])).toEqual([
      [libraryRef(7), 'Close the quarter', '1'],
    ]);
    expect(renamed.kept).toHaveLength(29);
    expect((await readWhole(reader, folder, SECRET, marks)).read).toEqual([]);
  });

  it('keeps a document moved to the bin and unchanged, and marks it archived', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 30 });
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    library.archive(12);
    library.reset();
    const after = await readWhole(reader, folder, SECRET, marks);
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

  it('reads a document whose listing does not say whether it is in the bin, since a kept page takes its status from the listing', async (): Promise<void> => {
    const { reader } = driveLibrary({ pages: 4, withheld: ['trashed'] });
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    const again = await readWhole(reader, folder, SECRET, marks);
    expect(again.read).toHaveLength(4);
    expect(again.kept).toEqual([]);
  });

  it('says a kept document with no date from its source was dated by the read, and reads as before with no contract to ask', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 3 });
    library.pages[1].editedAt = undefined;
    const plain = await reader.listPageBatch(folder, SECRET, undefined, 25);
    expect(plain.pages).toHaveLength(3);
    expect(plain).not.toHaveProperty('kept');
    const marks: StoredMarks = new Map();
    await readWhole(reader, folder, SECRET, marks);
    const kept = (await readWhole(reader, folder, SECRET, marks)).kept;
    expect(kept.map((page) => page.datedBySource)).toEqual([true, false, true]);
  });
});

describe("the Google Drive reader's token across a sync's batches (wave 18, 18-X; X-1)", (): void => {
  /** A token an earlier batch handed back that Google no longer takes (revoked, or lapsed early). */
  const REVOKED = { token: 'revoked-google-token', expiresAt: T0 + 3_000_000 };

  it('asks for a token again mid-sync once the one it holds is past its expiry, and hands the new one back', async (): Promise<void> => {
    let clock = T0;
    const { library, reader } = driveLibrary({ pages: 100 }, (): number => clock);
    const marks: StoredMarks = new Map();
    const one = await reader.listPageBatch(folder, SECRET, undefined, 25, storedIn(marks));
    expect(one.token).toEqual({ token: 'fixture-google-token', expiresAt: T0 + 3_600_000 });
    const two = await reader.listPageBatch(
      folder,
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

    // A minute before Google's hour is up: inside the margin, so the token is not used.
    clock = T0 + 3_600_000 - 60_000;
    const three = await reader.listPageBatch(
      folder,
      SECRET,
      two.nextCursor,
      25,
      storedIn(marks),
      one.token,
    );
    expect(three.pages).toHaveLength(25);
    expect(three.token).toEqual({ token: 'fixture-google-token', expiresAt: clock + 3_600_000 });
    expect(library.counts().token).toBe(2);
  });

  it('asks for a token again when Google refuses the one handed back, and reads the batch on', async (): Promise<void> => {
    const { library, reader } = driveLibrary({ pages: 30 });
    const batch = await reader.listPageBatch(folder, SECRET, undefined, 25, undefined, REVOKED);
    expect(batch.pages).toHaveLength(25);
    expect(batch.token).toEqual({ token: 'fixture-google-token', expiresAt: T0 + 3_600_000 });
    // The folder's check refused under the handed token, then a sign-in, then the check again.
    expect(library.requests.slice(0, 3).map((request) => [request.kind, request.status])).toEqual([
      ['lookup', 401],
      ['token', 200],
      ['lookup', 200],
    ]);
    expect(library.counts().token).toBe(1);
  });

  it('never puts the token it hands back, or the one it was handed, in a log line or a cursor', async (): Promise<void> => {
    const { reader } = driveLibrary({ pages: 60 });
    const lines: string[] = [];
    const cursors: string[] = [];
    const logged = vi.spyOn(console, 'log').mockImplementation((line: unknown): void => {
      lines.push(String(line));
    });
    try {
      const first = await reader.listPageBatch(folder, SECRET, undefined, 25, undefined, REVOKED);
      let cursor = first.nextCursor;
      let token = first.token;
      while (cursor !== undefined) {
        cursors.push(cursor);
        const batch = await reader.listPageBatch(folder, SECRET, cursor, 25, undefined, token);
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
      expect(said).not.toContain('fixture-google-token');
      expect(said).not.toContain(REVOKED.token);
    }
  });
});
