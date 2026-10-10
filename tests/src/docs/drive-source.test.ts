import { describe, expect, it } from 'vitest';
import {
  driveLocator,
  driveReaderSecret,
  parseDriveLocator,
  parseDriveSecret,
} from '../../../src/docs/drive-source';

const FOLDER = '1AbCdEfGhIjKlMnOpQrStUvWxYz012345';

describe('a Google Drive location', (): void => {
  it("is the folder's own address, however the browser showed it, or from its ID alone", (): void => {
    const stored = `https://drive.google.com/drive/folders/${FOLDER}`;
    for (const typed of [
      ` ${stored} `,
      `https://drive.google.com/drive/u/0/folders/${FOLDER}?usp=sharing`,
      FOLDER,
    ]) {
      expect(driveLocator(typed)).toBe(stored);
    }
    expect(parseDriveLocator(stored)).toEqual({ folderId: FOLDER });
  });

  it('is refused for a document, another host or plain http, without repeating it', (): void => {
    const document = 'https://docs.google.com/document/d/1DocCloseTheQuarter00000000000000001/edit';
    expect(driveLocator(document)).toBe(document);
    for (const locator of [
      document,
      `https://drive.example/drive/folders/${FOLDER}`,
      `http://drive.google.com/drive/folders/${FOLDER}`,
      `https://drive.google.com/drive/u/0/folders/${FOLDER}`,
      `https://drive.google.com/drive/folders/${FOLDER}?usp=sharing`,
      `https://user:pass@drive.google.com/drive/folders/${FOLDER}`,
      'https://drive.google.com/drive/my-drive',
    ]) {
      let message = '';
      try {
        parseDriveLocator(locator);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, locator).toContain("A Google Drive location is a folder's address");
      expect(message).not.toContain(locator);
    }
  });
});

describe('a Google Drive reader secret', (): void => {
  const key = {
    type: 'service_account',
    client_email: 'day0-reader@acme-docs.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n',
  };

  it("is the service account's JSON key, put on one line so it holds no line break", (): void => {
    const pasted = JSON.stringify(key, null, 2);
    const secret = driveReaderSecret(pasted);
    expect(secret).not.toMatch(/[\u0000-\u001f]/);
    expect(parseDriveSecret(secret)).toEqual({
      clientEmail: key.client_email,
      privateKey: key.private_key,
    });
  });

  it('is refused when it is not a service account key, without repeating it', (): void => {
    expect(driveReaderSecret(' not json ')).toBe('not json');
    for (const secret of [
      'not json',
      '"a string"',
      JSON.stringify({ client_email: key.client_email }),
      JSON.stringify({ ...key, client_email: 'not an address' }),
      JSON.stringify({ ...key, private_key: 'fixture-not-a-key' }),
    ]) {
      let message = '';
      try {
        parseDriveSecret(secret);
      } catch (error) {
        message = error instanceof Error ? error.message : String(error);
      }
      expect(message, secret).toBe(
        "A Google Drive secret is the service account's JSON key file, as Google Cloud downloaded it.",
      );
    }
  });
});
