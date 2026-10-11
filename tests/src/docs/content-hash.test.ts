import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { sep } from 'node:path';
import {
  PAGE_REDACTION_REVISION,
  REDACTOR_MODELS_DIGEST,
  pageContentHash,
} from '../../../src/docs/content-hash';
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

  it('changes with the redactor’s models, so a redactor model change re-redacts every page once, by itself (W14-R16)', (): void => {
    const hash = pageContentHash(PAGE, KEY_A, 'owner-a');
    expect(
      pageContentHash(PAGE, KEY_A, 'owner-a', PAGE_REDACTION_REVISION, 'a'.repeat(64)),
    ).not.toBe(hash);
    expect(
      pageContentHash(PAGE, KEY_A, 'owner-a', PAGE_REDACTION_REVISION, REDACTOR_MODELS_DIGEST),
    ).toBe(hash);
  });

  it('holds the digest of the models the redactor loads: a model change moves it, and with it every page’s hash (W14-R16)', (): void => {
    // `redactor/models.sha256` names every file the component loads with its digest, and the
    // component refuses to start on any other. Re-pin this constant with the model change: no
    // revision bump is owed for it, since the hash's input moves by itself.
    const models = readFileSync(
      new URL('../../../redactor/models.sha256', import.meta.url),
      'utf8',
    );
    expect(REDACTOR_MODELS_DIGEST).toBe(sha256OfText(models));
  });

  it('pins everything that decides a page’s redaction: a change to that code bumps PAGE_REDACTION_REVISION (W14-R16)', (): void => {
    // A page whose hash is unchanged is never redacted again, so a redaction that would now find
    // more must bump the revision, which re-redacts every page once. Re-pin the digest with the
    // bump; re-pin it alone only for a change that cannot alter what a page is redacted to.
    // Since 15-A the digest also covers the exact-value matcher the redaction calls
    // (`src/surfaces/secrets.ts`, through `src/redaction/known-values.ts`) and the component that
    // serves the span model, with its threshold and chunking (`redactor/server.py`): the review
    // found a change to either left this test green and every unchanged page with its old
    // redaction for good.
    // Since 15-T (W15-R41) it also covers the pins of the libraries that produce the spans
    // (`redactor/requirements.txt` and `requirements-cuda.txt`: a `transformers==` bump left the
    // test green) and every file under `src/redaction/`, however deep: the directory was read
    // at its top level only.
    const src = new URL('../../../src/', import.meta.url);
    const redactor = new URL('../../../redactor/', import.meta.url);
    const files = [
      'docs/redaction.ts',
      ...readdirSync(new URL('redaction/', src), { recursive: true, encoding: 'utf8' })
        .map((name) => name.split(sep).join('/'))
        .filter((name) => name.endsWith('.ts'))
        .sort()
        .map((name) => `redaction/${name}`),
      'surfaces/secrets.ts',
    ];
    const component = readdirSync(redactor)
      .filter((name) => name === 'server.py' || /^requirements.*\.txt$/.test(name))
      .sort();
    expect(component).toEqual(['requirements-cuda.txt', 'requirements.txt', 'server.py']);
    const digest = sha256OfText(
      [
        ...files.map((file) => `${file}\n${readFileSync(new URL(file, src), 'utf8')}`),
        ...component.map(
          (file) => `redactor/${file}\n${readFileSync(new URL(file, redactor), 'utf8')}`,
        ),
      ].join('\n'),
    );
    expect({ revision: PAGE_REDACTION_REVISION, digest }).toEqual({
      revision: 2,
      // Re-pinned for W15-R41: the digest takes two more files in (the redactor's requirement
      // pins); none of the code it covered before changed, so no bump is owed.
      digest: '43a03656a250d01ea17b4206fea77e2b676269810398d92691c55bf6d84e5ad0',
    });
  });
});
