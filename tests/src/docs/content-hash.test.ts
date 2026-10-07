import { describe, expect, it } from 'vitest';
import { pageContentHash } from '../../../src/docs/content-hash';
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
});
