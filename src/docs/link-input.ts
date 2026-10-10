/**
 * The checks a documentation source's link passes before anything is stored: its kind, its
 * location and the secret it reads with (E-74). Moved from `convex/docSources.ts` (wave 14,
 * 14-F), which re-exports them, so the backend's largest documentation module stops growing with
 * each source kind.
 */
import { isBundledNotionLocator } from './components';
import {
  checkConfluenceToken,
  parseConfluenceCloudLocator,
  parseConfluenceDataCenterLocator,
} from './confluence-source';
import { parseDriveLocator, parseDriveSecret } from './drive-source';
import { parseFeishuLocator, parseFeishuSecret } from './feishu-source';
import { parseSharePointLocator, parseSharePointSecret } from './sharepoint-source';
import type { DocSourceKind } from './types';
import { checkYuqueToken, parseYuqueLocator } from './yuque-source';

/** The link form's values for one documentation source, as `docSources.link` takes them. */
export interface LinkInput {
  label: string;
  kind: DocSourceKind;
  locator: string;
  serverKind?: 'notion' | 'confluence' | 'drive' | 'generic';
}

/**
 * Validate and normalise an owner-supplied documentation location.
 *
 * Args:
 *   input: Link form values.
 *
 * Returns:
 *   Trimmed values safe to persist.
 *
 * Raises:
 *   Error: If the source kind and locator fields are inconsistent.
 */
export function validateLinkInput(input: LinkInput): LinkInput {
  const label = input.label.trim();
  const locator = input.locator.trim();
  if (!label) throw new Error('Documentation label is required.');
  if (!locator) throw new Error('Documentation locator is required.');
  // The locator is stored on the row and shown on the page, so a token in it
  // would sit in plaintext on both; no refusal repeats the locator.
  // Read on the raw text as well as the parsed URL: a `#` before the `@`
  // moves the userinfo into the fragment, where the parser does not see it.
  const refuseUserinfo = (url: URL, raw: string): void => {
    if (url.username !== '' || url.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(raw)) {
      throw new Error(
        'Documentation locators must not carry a user name or password; a credential is ' +
          'linked with the source, never inside its address.',
      );
    }
  };
  if (input.kind === 'folder') {
    if (locator.startsWith('/') || locator.split(/[\\/]/).includes('..')) {
      throw new Error('Folder locator must be relative and stay inside DAY0_DOCS_ROOT.');
    }
  } else if (input.kind === 'urls') {
    const values = locator
      .split(/\r?\n/)
      .map((value: string): string => value.trim())
      .filter(Boolean);
    if (values.length === 0) throw new Error('At least one documentation URL is required.');
    for (const value of values) {
      const url = new URL(value);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error('Documentation URLs must use HTTP or HTTPS.');
      }
      refuseUserinfo(url, value);
    }
  } else if (input.kind === 'feishu') {
    // The host names the region and the path the space or folder; nothing else is stored.
    parseFeishuLocator(locator);
  } else if (input.kind === 'confluence-v2') {
    // Atlassian's gateway, the site's cloud ID and one space's key; nothing else is stored.
    parseConfluenceCloudLocator(locator);
  } else if (input.kind === 'confluence-dc') {
    // The customer's own server over https, and one space's key.
    parseConfluenceDataCenterLocator(locator);
  } else if (input.kind === 'sharepoint') {
    // One site's address on a SharePoint host, which names its Microsoft cloud.
    parseSharePointLocator(locator);
  } else if (input.kind === 'yuque') {
    // One repository on Yuque's site or a space's own subdomain of it.
    parseYuqueLocator(locator);
  } else if (input.kind === 'drive') {
    // One folder, by the address the browser shows for it.
    parseDriveLocator(locator);
  } else {
    const rawUrl = input.kind === 'git' ? locator.split('#')[0] : locator;
    const url = new URL(rawUrl);
    refuseUserinfo(url, locator);
    // Only Day0's own Notion component is reached over plain HTTP, on the
    // compose network; every other MCP server gets a secret, and the reader
    // connects to it over HTTPS at a checked public address alone (M16).
    const bundled =
      input.kind === 'mcp' && input.serverKind === 'notion' && isBundledNotionLocator(url.href);
    if (url.protocol !== 'https:' && !(bundled && url.protocol === 'http:')) {
      throw new Error('Remote documentation locators must use HTTPS.');
    }
  }
  if (input.kind === 'mcp') {
    if (!input.serverKind) throw new Error('MCP server kind is required.');
  } else if (input.serverKind) {
    throw new Error('Only MCP sources may name a server kind.');
  }
  return { ...input, label, locator };
}

/**
 * What a kind that cannot be read without a secret of its own says when it is linked with none.
 */
const SECRET_REQUIRED: Partial<Record<LinkInput['kind'], string>> = {
  mcp: 'Connection secret is required for an MCP source.',
  feishu: 'A Feishu source needs its app ID and secret.',
  'confluence-v2': "A Confluence Cloud source needs its service account's API token.",
  'confluence-dc': 'A Confluence Data Center source needs a personal access token.',
  sharepoint:
    "A SharePoint source needs its app registration's tenant ID, client ID and client secret.",
  yuque: 'A Yuque source needs a token.',
  drive: "A Google Drive source needs its service account's JSON key.",
};

/**
 * The source kinds that read with a secret of their own: required for MCP, Feishu, both
 * Confluence kinds, SharePoint, Yuque and Google Drive, optional for git and URLs.
 */
const SECRET_KINDS: ReadonlySet<LinkInput['kind']> = new Set([
  'mcp',
  'git',
  'urls',
  'feishu',
  'confluence-v2',
  'confluence-dc',
  'sharepoint',
  'yuque',
  'drive',
]);

/**
 * Whether a source of this kind reads with a secret of its own, so the secret can be rotated.
 *
 * @param kind - The source's kind.
 */
export function readsWithOwnSecret(kind: LinkInput['kind']): boolean {
  return SECRET_KINDS.has(kind);
}

/**
 * Check the secret a source is linked with, before anything is stored (E-74).
 *
 * An MCP server needs its connection secret. A private git repository or a
 * wiki behind a login may be linked with the reader's own secret, which is
 * stored as a credential and never written into the locator. A URL list
 * read with a secret must list pages of one https site, since the secret is
 * that site's and is sent to no other. A Feishu source needs its app's ID
 * and secret, joined by a colon, which it exchanges for the tenant's token. A
 * Confluence Cloud source needs its service account's API token, and a Data
 * Center one a personal access token. A folder is read from the mounted
 * directory and takes none.
 *
 * @param input - The validated link values.
 * @param secret - The secret the owner entered, if any.
 * @throws Error saying which rule the secret breaks; the message never repeats the secret.
 */
export function validateReaderSecret(input: LinkInput, secret: string | undefined): void {
  const required = SECRET_REQUIRED[input.kind];
  if (required !== undefined && !secret) throw new Error(required);
  if (secret === undefined) return;
  if (!SECRET_KINDS.has(input.kind)) {
    throw new Error('A folder is read from the mounted directory and takes no secret.');
  }
  if (!secret) throw new Error('A secret, when given, cannot be empty.');
  // A secret with a line break or a control character is cut apart by every
  // record that words a failure, and no longer matches its own redaction.
  if (/[\u0000-\u001f\u007f]/.test(secret)) {
    throw new Error('A secret cannot contain a line break or a control character.');
  }
  if (input.kind === 'feishu') parseFeishuSecret(secret);
  if (input.kind === 'sharepoint') parseSharePointSecret(secret);
  if (input.kind === 'yuque') checkYuqueToken(secret);
  if (input.kind === 'drive') parseDriveSecret(secret);
  if (input.kind === 'confluence-v2' || input.kind === 'confluence-dc') {
    checkConfluenceToken(secret);
  }
  if (input.kind === 'urls') {
    const origins = new Set(
      input.locator
        .split(/\r?\n/)
        .map((value: string): string => value.trim())
        .filter(Boolean)
        .map((value: string): string => new URL(value).origin),
    );
    const [origin] = [...origins];
    if (origins.size !== 1 || !origin.startsWith('https://')) {
      throw new Error(
        'A reader secret belongs to one https site: list pages of one https site to read them with it.',
      );
    }
  }
}

/** What a source's own secret is called on its credential row. */
export function secretLabel(source: Pick<LinkInput, 'label' | 'kind'>): string {
  switch (source.kind) {
    case 'mcp':
      return `${source.label} connection secret`;
    case 'feishu':
      return `${source.label} app ID and secret`;
    case 'confluence-v2':
      return `${source.label} API token`;
    case 'confluence-dc':
      return `${source.label} personal access token`;
    case 'sharepoint':
      return `${source.label} app registration`;
    case 'yuque':
      return `${source.label} token`;
    case 'drive':
      return `${source.label} service account key`;
    case 'folder':
    case 'git':
    case 'urls':
      return `${source.label} reader secret`;
  }
}
