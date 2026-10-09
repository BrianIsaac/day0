import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { PAGE_REDACTION_REVISION, pageContentHash } from '../../../src/docs/content-hash';
import { sha256OfText } from '../../../src/lib/sha256';
import { credentialValueFingerprint } from '../../../src/lib/credential-crypto';

/** Two fixed 32-byte keys in standard base64. */
const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');

/** A page as a reader returns it. */
const PAGE = {
  title: 'Refresh the tile',
  url: 'https://docs.example.test/refresh',
  markdown: '# Refresh the tile\n\npassword: hunter2-value',
};

describe('pageContentHash', (): void => {
  it('is the same for the same page, owner and key', (): void => {
    expect(pageContentHash(PAGE, KEY_A, 'owner-a')).toBe(
      pageContentHash({ ...PAGE }, KEY_A, 'owner-a'),
    );
    expect(pageContentHash(PAGE, KEY_A, 'owner-a')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('changes with the body, the title and the address, which a sync stores', (): void => {
    const hash = pageContentHash(PAGE, KEY_A, 'owner-a');
    expect(pageContentHash({ ...PAGE, markdown: `${PAGE.markdown}.` }, KEY_A, 'owner-a')).not.toBe(
      hash,
    );
    expect(pageContentHash({ ...PAGE, title: 'Refresh' }, KEY_A, 'owner-a')).not.toBe(hash);
    expect(pageContentHash({ ...PAGE, url: undefined }, KEY_A, 'owner-a')).not.toBe(hash);
  });

  it('is keyed and bound to the owner, so the row is no test of a guessed secret', (): void => {
    const hash = pageContentHash(PAGE, KEY_A, 'owner-a');
    expect(pageContentHash(PAGE, KEY_B, 'owner-a')).not.toBe(hash);
    expect(pageContentHash(PAGE, KEY_A, 'owner-b')).not.toBe(hash);
  });

  it('never equals a credential fingerprint of the same text', (): void => {
    expect(pageContentHash(PAGE, KEY_A, 'owner-a')).not.toBe(
      credentialValueFingerprint(PAGE.markdown, KEY_A, 'owner-a'),
    );
  });

  it('changes with the redaction revision, so a page kept as stored is redacted once more under a changed pipeline', (): void => {
    expect(pageContentHash(PAGE, KEY_A, 'owner-a', PAGE_REDACTION_REVISION + 1)).not.toBe(
      pageContentHash(PAGE, KEY_A, 'owner-a'),
    );
  });

  it('pins the redaction pipeline its revision names: a change to that code bumps PAGE_REDACTION_REVISION', (): void => {
    // A page whose hash is unchanged is never redacted again, so a redaction that would now find
    // more must bump the revision, which re-redacts every page once. Re-pin the digest with the
    // bump; re-pin it alone only for a change that cannot alter what a page is redacted to.
    const root = new URL('../../../src/', import.meta.url);
    const files = [
      'docs/redaction.ts',
      ...readdirSync(new URL('redaction/', root))
        .filter((name) => name.endsWith('.ts'))
        .sort()
        .map((name) => `redaction/${name}`),
    ];
    const digest = sha256OfText(
      files.map((file) => `${file}\n${readFileSync(new URL(file, root), 'utf8')}`).join('\n'),
    );
    expect({ revision: PAGE_REDACTION_REVISION, digest }).toEqual({
      revision: 1,
      digest: '23e401ee2c5167bc0eef362411190d0c63a0220241fef83f35add571f1bffc5f',
    });
  });
});
