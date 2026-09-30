import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  INHERITED_SELECTORS,
  readCheckout,
  readTarget,
  toolRefusal,
  vercelRefusal,
} from '../../../scripts/cloud/checkout';
import { APP_URL, cleanupClouds, cloud, COMMIT, DEPLOYMENT } from './harness';

afterEach(cleanupClouds);

describe('readTarget', (): void => {
  it('reads the deployment, the app address and the scope, the flags over the file', (): void => {
    const c = cloud(
      {},
      {
        targetText: `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nDAY0_APP_URL=${APP_URL}/\nVERCEL_SCOPE=team-a\n`,
      },
    );
    expect(readTarget({ target: c.target }, c.io)).toEqual({
      file: c.target,
      deployment: DEPLOYMENT,
      appUrl: APP_URL,
      scope: 'team-a',
    });
    expect(
      readTarget({ target: c.target, appUrl: 'https://other.example.com', scope: 'team-b' }, c.io),
    ).toMatchObject({ appUrl: 'https://other.example.com', scope: 'team-b' });
  });

  it('resolves a relative target against the checkout it runs from', (): void => {
    const c = cloud();
    const relative = join('..', c.privateDir.split('/').at(-1)!, 'prod-target.env');
    expect(readTarget({ target: relative }, c.io)).toMatchObject({ deployment: DEPLOYMENT });
  });

  it.each([
    ['no file named', undefined, 'the target file is not named'],
    [
      'a name that is not generated',
      'CONVEX_DEPLOYMENT=prod:production\n',
      'does not name a production deployment',
    ],
    ['a bare name', `CONVEX_DEPLOYMENT=${DEPLOYMENT}\n`, 'does not name a production deployment'],
    [
      'an app address that is not https',
      `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nDAY0_APP_URL=http://x.example.com\n`,
      'is not an https origin',
    ],
    [
      'a line that is not a setting',
      `CONVEX_DEPLOYMENT=prod:${DEPLOYMENT}\nprod\n`,
      'line 2 is not a NAME=value setting',
    ],
  ])('refuses %s', (_label, text, words): void => {
    const c = cloud({}, { targetText: text ?? null });
    const refusal = readTarget({ target: text === undefined ? undefined : c.target }, c.io);
    expect('failure' in refusal && refusal.failure).toContain(words);
  });
});

describe('readCheckout', (): void => {
  it('reads the release and the commit of a clean tag checkout', (): void => {
    const c = cloud();
    expect(readCheckout(c.io, true)).toMatchObject({ release: '0.3.0', commit: COMMIT });
  });

  it('lets a verb that pushes nothing run from a checkout that is not a clean tag', (): void => {
    const c = cloud({ dirty: true, tag: undefined });
    expect(readCheckout(c.io, false)).toMatchObject({ release: '0.3.0' });
    expect(readCheckout(c.io, true)).toMatchObject({
      failure: expect.stringContaining('git has not committed'),
    });
  });

  it('names every deployment selector the shell carries', (): void => {
    const c = cloud();
    const environment = Object.fromEntries(INHERITED_SELECTORS.map((name) => [name, 'x']));
    const refusal = readCheckout({ ...c.io, environment }, false);
    expect('failure' in refusal && refusal.failure).toBe(
      'CONVEX_DEPLOYMENT and CONVEX_DEPLOY_KEY and CONVEX_SELF_HOSTED_URL and CONVEX_SELF_HOSTED_ADMIN_KEY are set in this shell and would choose the deployment instead of the target file; unset them.',
    );
  });

  it('refuses a directory that is not a Day0 checkout', (): void => {
    const c = cloud();
    const refusal = readCheckout({ ...c.io, cwd: c.privateDir }, false);
    expect('failure' in refusal && refusal.failure).toContain('is not a Day0 checkout');
  });

  it('refuses an empty .env.local as well, which the CLI still reads', (): void => {
    const c = cloud();
    writeFileSync(join(c.checkout, '.env.local'), '');
    expect(readCheckout(c.io, false)).toMatchObject({
      failure: expect.stringContaining('.env.local'),
    });
  });
});

describe('the tools', (): void => {
  it('say how to install a tool that does not answer', (): void => {
    const c = cloud({ missing: ['vercel', 'curl'] });
    expect(toolRefusal(c.io, 'curl')?.failure).toBe(
      '`curl` does not answer on this machine; install it (the curl package).',
    );
    expect(vercelRefusal(c.io)?.failure).toContain(
      'npm install --global vercel, then vercel login',
    );
    expect(toolRefusal(c.io, 'unzip')).toBeUndefined();
  });

  it('refuse a checkout the Vercel CLI is not linked from', (): void => {
    const c = cloud({}, { linked: false });
    expect(vercelRefusal(c.io)?.failure).toContain('run `vercel link`');
  });
});
