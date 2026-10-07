import { credentialValueFingerprint } from '../lib/credential-crypto';

/** What makes a page's hash its own: never the fingerprint of a credential holding the same text. */
const PAGE_CONTENT_LABEL = 'day0-page-content-v1';

/** The parts of a page a sync stores, as its reader returned them. */
export interface HashedPage {
  readonly title: string;
  readonly url?: string;
  readonly markdown: string;
}

/**
 * The hash of a page as its reader returned it, before redaction (wave 14, 14-I; P8-10): a sync
 * that finds it unchanged skips the page's redaction and split. The title and the address are
 * part of it, since the sync stores both.
 *
 * Keyed and bound to the owner, as a credential's fingerprint is: the page may hold a secret the
 * redaction later removes, and a plain digest of a short page would let anyone who reads the row
 * test a guessed password against it. It changes with the key, so after a rotation every page
 * is redacted once more.
 *
 * @param page - The page's title, address and Markdown.
 * @param keyBase64 - The deployment's credential key (`DAY0_CREDENTIAL_KEY`).
 * @param userId - The source's owner.
 * @returns 32 lower-case hex characters.
 * @throws Error when the key is not canonical 32-byte base64.
 */
export function pageContentHash(page: HashedPage, keyBase64: string, userId: string): string {
  const content = JSON.stringify([page.title, page.url ?? null, page.markdown]);
  return credentialValueFingerprint(`${PAGE_CONTENT_LABEL}\0${content}`, keyBase64, userId);
}
