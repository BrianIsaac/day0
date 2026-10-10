import { confluenceCloudLocator, confluenceDataCenterLocator } from '@/docs/confluence-source';
import { driveLocator, driveReaderSecret } from '@/docs/drive-source';
import { sharePointLocator, sharePointReaderSecret } from '@/docs/sharepoint-source';
import { yuqueLocator } from '@/docs/yuque-source';
import { REPOSITORY_URL } from '@/setup/quickstart';

/** The kinds wave 15's readers read: each asks for its own secret fields and has its own guide. */
export const READER_KINDS = [
  ['sharepoint', 'SharePoint site'],
  ['confluence-v2', 'Confluence Cloud space'],
  ['confluence-dc', 'Confluence Data Center space'],
  ['yuque', 'Yuque repository'],
  ['drive', 'Google Drive folder'],
] as const;

/** One of {@link READER_KINDS}. */
export type ReaderKind = (typeof READER_KINDS)[number][0];

/** Whether a source kind is one of {@link READER_KINDS}. */
export function isReaderKind(kind: string): kind is ReaderKind {
  return READER_KINDS.some(([each]) => each === kind);
}

/** What each kind's "Where it is" field asks for. */
export const READER_WHERE: Readonly<Record<ReaderKind, string>> = {
  sharepoint: "The site's address, for example https://acme.sharepoint.com/sites/Runbooks",
  'confluence-v2': "The space's key, or its address in the browser",
  'confluence-dc':
    "The space's address on your server, for example https://wiki.acme.corp/display/OPS",
  yuque: "The repository's address, for example https://www.yuque.com/acme/runbooks",
  drive: "The folder's address, for example https://drive.google.com/drive/folders/...",
};

/** The guide IT follows for each kind, as the repository publishes it. */
export const READER_GUIDE_URLS: Readonly<Record<ReaderKind, string>> = {
  sharepoint: `${REPOSITORY_URL}/blob/main/docs/running/reader-sharepoint.md`,
  'confluence-v2': `${REPOSITORY_URL}/blob/main/docs/running/reader-confluence.md`,
  'confluence-dc': `${REPOSITORY_URL}/blob/main/docs/running/reader-confluence.md`,
  yuque: `${REPOSITORY_URL}/blob/main/docs/running/reader-yuque.md`,
  drive: `${REPOSITORY_URL}/blob/main/docs/running/reader-drive.md`,
};

/** A form field's text, trimmed; empty when the form has none by that name. */
function text(values: FormData, name: string): string {
  const value = values.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * What `docSources.link` is sent for one of the reader kinds: the stored locator for what was
 * typed (an address copied from the browser is reduced to the site, space, repository or folder
 * it is in), and the one reader secret the kind's fields make.
 *
 * @param kind - The selected kind.
 * @param typed - What the "Where it is" field holds.
 * @param values - The form's uncontrolled fields: the secret, and what a kind asks beside it.
 * @returns The locator and the secret; what names nothing is handed on as typed, for the link
 *   to refuse with its own sentence.
 */
export function readerLinkValues(
  kind: ReaderKind,
  typed: string,
  values: FormData,
): { readonly locator: string; readonly credential: string } {
  switch (kind) {
    case 'sharepoint':
      return {
        locator: sharePointLocator(typed),
        credential: sharePointReaderSecret({
          tenantId: text(values, 'tenantId'),
          clientId: text(values, 'clientId'),
          clientSecret: text(values, 'clientSecret'),
        }),
      };
    case 'confluence-v2':
      return {
        locator: confluenceCloudLocator(text(values, 'cloudId'), typed),
        credential: text(values, 'credential'),
      };
    case 'confluence-dc':
      return {
        locator: confluenceDataCenterLocator(typed),
        credential: text(values, 'credential'),
      };
    case 'yuque':
      return { locator: yuqueLocator(typed), credential: text(values, 'credential') };
    case 'drive':
      return {
        locator: driveLocator(typed),
        credential: driveReaderSecret(text(values, 'credential')),
      };
  }
}
