import { credentialValueFingerprint } from '../lib/credential-crypto';

/** What makes a page's hash its own: never the fingerprint of a credential holding the same text. */
const PAGE_CONTENT_LABEL = 'day0-page-content-v1';

/**
 * The revision of the redaction a page's hash vouches for (wave 14, 14-I's second pass): a page
 * whose hash is unchanged is kept as stored and never redacted again, so a change to the
 * redaction that could find more bumps it, and every page is redacted once more at its next
 * sync. `tests/src/docs/content-hash.test.ts` pins a digest of that code beside it, so the
 * change cannot land without the question being asked: `src/docs/redaction.ts`,
 * `src/redaction/` however deep, the exact-value matcher they call (`src/surfaces/secrets.ts`),
 * the component that serves the span model (`redactor/server.py`) and the pins of the libraries
 * it runs on (`redactor/requirements.txt`, `redactor/requirements-cuda.txt`; W15-R41).
 *
 * 2 since 0.19.0 (W14-R16): the pin did not cover the matcher or the component, so a change to
 * either left every unchanged page with its old redaction for good. Bumped once as the pin
 * widened, which redacts every stored page again at its first sync after the upgrade.
 */
export const PAGE_REDACTION_REVISION = 2;

/**
 * The SHA-256 of `redactor/models.sha256`, the list of every file the redaction component loads
 * with the digest it must have (the component refuses to start on any other). Part of every
 * page's hash (W14-R16), so a redactor model change re-redacts every page once by itself, with
 * no revision bump: `tests/src/docs/content-hash.test.ts` holds this to the file, so the model
 * cannot change without it.
 */
export const REDACTOR_MODELS_DIGEST =
  '59741036483a074b1cff09418657a0abac3b725593855b9c80180ac38335886f';

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
 * is redacted once more; and with the redaction's revision and the redactor's models, so a
 * change to what redacts a page does the same.
 *
 * @param page - The page's title, address and Markdown.
 * @param keyBase64 - The deployment's credential key (`DAY0_CREDENTIAL_KEY`).
 * @param userId - The source's owner.
 * @param revision - The redaction the stored page was redacted under; this release's by default.
 * @param models - The digest of the models the redactor loads; this release's by default.
 * @returns 32 lower-case hex characters.
 * @throws Error when the key is not canonical 32-byte base64.
 */
export function pageContentHash(
  page: HashedPage,
  keyBase64: string,
  userId: string,
  revision: number = PAGE_REDACTION_REVISION,
  models: string = REDACTOR_MODELS_DIGEST,
): string {
  const content = JSON.stringify([revision, models, page.title, page.url ?? null, page.markdown]);
  return credentialValueFingerprint(`${PAGE_CONTENT_LABEL}\0${content}`, keyBase64, userId);
}
