/**
 * A Google Drive documentation source's location and reader secret, as the link form, the link's
 * validators and the reader all read them (wave 15, 15-X).
 *
 * The location is one folder (`https://drive.google.com/drive/folders/<folder ID>`), read with
 * the folders under it. The reader secret is a service account's JSON key, as Google Cloud
 * downloads it: the reader signs a short-lived assertion with its private key and reads what the
 * folder's owner shared with the service account's address. No domain-wide delegation is used.
 */

/** Where a Drive folder opens in a browser. */
export const DRIVE_SITE_HOST = 'drive.google.com';

/** One Drive folder. */
export interface DriveLocator {
  readonly folderId: string;
}

/** The identity a source reads as: a service account's address and the key it signs with. */
export interface DriveServiceAccount {
  readonly clientEmail: string;
  /** The private key, PEM encoded. */
  readonly privateKey: string;
}

const FOLDER_ID = /^[A-Za-z0-9_-]{10,128}$/;

const LOCATOR_REFUSAL =
  "A Google Drive location is a folder's address as the browser shows it: " +
  'https://drive.google.com/drive/folders/<folder ID>. Share the folder with the service ' +
  "account's address first; the address of a single document does not work.";

/** The folder ID a Drive address names: the path segment after `folders`. */
function folderIdIn(url: URL): string | undefined {
  const segments = url.pathname.split('/');
  const id = segments[segments.indexOf('folders') + 1];
  return segments.includes('folders') && FOLDER_ID.test(id ?? '') ? id : undefined;
}

/**
 * Parse a Google Drive source's stored locator.
 *
 * @param locator - `https://drive.google.com/drive/folders/<folder ID>`.
 * @throws Error when it is anything else; the message never repeats the locator.
 */
export function parseDriveLocator(locator: string): DriveLocator {
  let url: URL;
  try {
    url = new URL(locator);
  } catch {
    throw new Error(LOCATOR_REFUSAL);
  }
  const folderId = folderIdIn(url);
  if (
    url.protocol !== 'https:' ||
    url.hostname !== DRIVE_SITE_HOST ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    folderId === undefined ||
    url.pathname !== `/drive/folders/${folderId}`
  ) {
    throw new Error(LOCATOR_REFUSAL);
  }
  return { folderId };
}

/**
 * The stored locator for a folder's address as the browser shows it, or its bare ID.
 *
 * @param typed - What the manager pasted: `.../drive/folders/<ID>`, with or without an account
 *   segment (`/u/0/`) and a query, or the ID alone.
 * @returns The locator `parseDriveLocator` reads, or the text as typed when it names no folder,
 *   for the link to refuse.
 */
export function driveLocator(typed: string): string {
  const text = typed.trim();
  const stored = (id: string): string => `https://${DRIVE_SITE_HOST}/drive/folders/${id}`;
  if (FOLDER_ID.test(text)) return stored(text);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return text;
  }
  const id = folderIdIn(url);
  return url.hostname === DRIVE_SITE_HOST && id !== undefined ? stored(id) : text;
}

const SECRET_REFUSAL =
  "A Google Drive secret is the service account's JSON key file, as Google Cloud downloaded it.";

/**
 * The service account a reader secret names.
 *
 * @param secret - The JSON key file's text.
 * @throws Error when it is not a service account key; the message never repeats it.
 */
export function parseDriveSecret(secret: string): DriveServiceAccount {
  let key: unknown;
  try {
    key = JSON.parse(secret);
  } catch {
    throw new Error(SECRET_REFUSAL);
  }
  const fields = typeof key === 'object' && key !== null ? (key as Record<string, unknown>) : {};
  const { client_email: clientEmail, private_key: privateKey } = fields;
  if (
    typeof clientEmail !== 'string' ||
    !/^[^@\s]+@[^@\s]+$/.test(clientEmail) ||
    typeof privateKey !== 'string' ||
    !privateKey.includes('PRIVATE KEY')
  ) {
    throw new Error(SECRET_REFUSAL);
  }
  return { clientEmail, privateKey };
}

/**
 * The reader secret for a JSON key file as it was pasted: the same key on one line, since a
 * stored secret holds no line break.
 *
 * @param pasted - The key file's text, with its line breaks.
 * @returns The key on one line, or the text as pasted when it is not JSON, for the link to refuse.
 */
export function driveReaderSecret(pasted: string): string {
  try {
    return JSON.stringify(JSON.parse(pasted));
  } catch {
    return pasted.trim();
  }
}
