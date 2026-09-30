import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  readCheckout,
  readTarget,
  type CheckoutState,
  type CloudTarget,
} from '../../../scripts/cloud/checkout';
import {
  backupDirectory,
  earliestUpgradeExport,
  fileStamp,
  migrateAndStamp,
  pauseReason,
  proveTarget,
  pushFunctions,
  readDeploymentEnv,
  takeBackup,
} from '../../../scripts/cloud/deployment';
import { cleanupClouds, cloud, COMMIT, DEPLOYMENT, ran, type Cloud } from './harness';

afterEach(cleanupClouds);

/** The fake cloud's target, read as a verb reads it. */
function targetOf(c: Cloud): CloudTarget {
  const target = readTarget({ target: c.target }, c.io);
  if ('failure' in target) throw new Error(target.failure);
  return target;
}

/** The fake checkout's state, read as a verb that pushes reads it. */
function checkoutOf(c: Cloud): CheckoutState {
  const checkout = readCheckout(c.io, true);
  if ('failure' in checkout) throw new Error(checkout.failure);
  return checkout;
}

describe('proveTarget', (): void => {
  it("accepts the project's default production deployment, named by the dry run", (): void => {
    const c = cloud();
    expect(proveTarget(c.io, targetOf(c), 'push')).toBeUndefined();
    expect(ran(c)[1]).toBe(`npx convex deploy --dry-run --typecheck enable --env-file ${c.target}`);
  });

  it('refuses a dry run that names nothing, in its own words', (): void => {
    const c = cloud({ defaultProd: 'other-prod-789' });
    expect(proveTarget(c.io, targetOf(c), 'push')?.failure).toBe(
      "the dry run of the push did not name brisk-heron-417 as the deployment it would reach (exit 1): ✖ Cannot prompt for input in non-interactive terminals. Only the project's default production deployment is pushed to; the Convex dashboard names it.",
    );
  });

  it('on an empty deployment, proves the target but not the push, which its auth config refuses', (): void => {
    const c = cloud({ env: new Map() });
    expect(proveTarget(c.io, targetOf(c), 'target')).toBeUndefined();
    expect(proveTarget(c.io, targetOf(c), 'push')?.failure).toBe(
      'the dry run reached brisk-heron-417 and the deployment refused the push (exit 1): AuthConfigMissingEnvironmentVariable: no identity provider is configured.',
    );
  });

  it("quotes the refusal's cause, never the stack frame the CLI prints after it", (): void => {
    const c = cloud({
      failing: [
        {
          match: 'deploy --dry-run',
          status: 1,
          stdout: '- Deploying to https://brisk-heron-417.convex.cloud... [dry run]\n',
          stderr:
            '✖ Error fetching POST https://brisk-heron-417.convex.cloud/api/deploy2/start_push 400 Bad Request: InvalidModules: Loading the pushed modules encountered the following\n' +
            '    error:\n' +
            '    Failed to analyze auth.config.js: Uncaught Error: This deployment has no identity provider configured\n' +
            '        at identityProviders (../convex/auth.config.ts:49:11)\n' +
            '        at <anonymous> (../convex/auth.config.ts:60:15)\n',
        },
      ],
    });
    expect(proveTarget(c.io, targetOf(c), 'push')?.failure).toBe(
      'the dry run reached brisk-heron-417 and the deployment refused the push (exit 1): Failed to analyze auth.config.js: Uncaught Error: This deployment has no identity provider configured.',
    );
  });

  it('passes over lines that only look like an error, and keeps a cause that begins with "at"', (): void => {
    const c = cloud({
      failing: [
        {
          match: 'deploy --dry-run',
          status: 1,
          stdout: '- Deploying to https://brisk-heron-417.convex.cloud... [dry run]\n',
          stderr:
            'at least one identity provider is required\n' +
            '    at <anonymous> (../convex/auth.config.ts:60:15)\n',
        },
      ],
    });
    expect(proveTarget(c.io, targetOf(c), 'push')?.failure).toBe(
      'the dry run reached brisk-heron-417 and the deployment refused the push (exit 1): at least one identity provider is required.',
    );
    const named = cloud({
      failing: [
        {
          match: 'deploy --dry-run',
          status: 1,
          stdout: '- Deploying to https://brisk-heron-417.convex.cloud... [dry run]\n',
          stderr:
            '400 Bad Request: InvalidModules: at least one identity provider is required\n' +
            'Bundling JavaScript: done\n',
        },
      ],
    });
    expect(proveTarget(named.io, targetOf(named), 'push')?.failure).toBe(
      'the dry run reached brisk-heron-417 and the deployment refused the push (exit 1): 400 Bad Request: InvalidModules: at least one identity provider is required.',
    );
  });

  it('quotes the last line that is not a stack frame when no line names an error', (): void => {
    const c = cloud({
      failing: [
        {
          match: 'deploy --dry-run',
          status: 1,
          stdout: '- Deploying to https://brisk-heron-417.convex.cloud... [dry run]\n',
          stderr:
            'The push was not accepted.\n    at <anonymous> (../convex/auth.config.ts:60:15)\n',
        },
      ],
    });
    expect(proveTarget(c.io, targetOf(c), 'push')?.failure).toBe(
      'the dry run reached brisk-heron-417 and the deployment refused the push (exit 1): The push was not accepted.',
    );
  });

  it('refuses a dry run after which the checkout is changed, and not a tree that was changed before it', (): void => {
    const writes = cloud({ dryRunWrites: true });
    expect(proveTarget(writes.io, targetOf(writes), 'push')?.failure).toBe(
      'the dry run changed the checkout (M convex/_generated/api.d.ts).',
    );
    const dirty = cloud({ dirty: true });
    expect(proveTarget(dirty.io, targetOf(dirty), 'target')).toBeUndefined();
  });
});

describe('pushFunctions', (): void => {
  it("puts back convex/_generated, and on a failure prints the push's last lines", (): void => {
    const c = cloud({
      failing: [
        {
          match: 'deploy --typecheck enable --env-file',
          status: 1,
          stderr: 'Error: Unable to push deployment config\nInvalidAuthConfig: no provider',
        },
      ],
    });
    const failure = pushFunctions(c.io, targetOf(c), 'v0.4.0 test')?.failure ?? '';
    expect(failure).toContain('the push did not report deploying to brisk-heron-417 (exit 1)');
    expect(failure).toContain('  | InvalidAuthConfig: no provider');
    expect(ran(c).at(-1)).toBe('git checkout -- convex/_generated');
  });
});

describe('readDeploymentEnv and pauseReason', (): void => {
  it('read the env by name and the pause, a blank one as none', (): void => {
    const c = cloud({ env: new Map([['DAY0_CRONS_PAUSED', '  ']]) });
    const env = readDeploymentEnv(c.io, targetOf(c));
    expect(env).toBeInstanceOf(Map);
    expect(pauseReason(env as Map<string, string>)).toBeUndefined();
    expect(pauseReason(new Map([['DAY0_CRONS_PAUSED', 'held']]))).toBe('held');
  });
});

describe('migrateAndStamp', (): void => {
  it('runs until nothing is pending, stamps, and reads the stamp back', (): void => {
    const c = cloud({ pendingMigrations: ['a', 'b', 'c'] });
    const done = migrateAndStamp(c.io, targetOf(c), checkoutOf(c));
    expect(done).toEqual({
      changed: [
        'migrated a: 3 row(s) changed',
        'migrated b: 3 row(s) changed',
        'migrated c: 3 row(s) changed',
      ],
    });
    expect(c.state.stamp).toEqual({ release: '0.4.0', commit: COMMIT });
  });

  it('stops after twelve calls with the migrations still pending named', (): void => {
    const c = cloud({ pendingMigrations: Array.from({ length: 14 }, (_, index) => `m${index}`) });
    expect(migrateAndStamp(c.io, targetOf(c), checkoutOf(c))).toEqual({
      failure:
        'migrations still pending after 12 calls (m12, m13); run the verb again, which resumes them',
    });
    expect(c.state.stamp?.release).toBe('0.3.0');
  });

  it('refuses a stamp that does not read back as written', (): void => {
    const c = cloud({
      failing: [
        {
          match: 'data deploymentVersions',
          status: 0,
          stderr: '',
          stdout: '{"release":"0.3.0","commit":"x"}\n',
        },
      ],
    });
    expect(migrateAndStamp(c.io, targetOf(c), checkoutOf(c))).toEqual({
      failure: `the stamp reads 0.3.0 / x after stamping 0.4.0 / ${COMMIT}`,
    });
  });
});

describe('the export', (): void => {
  it('goes beside the target by default and never inside the checkout', (): void => {
    const c = cloud();
    expect(backupDirectory(undefined, c.io, targetOf(c))).toEqual({ directory: c.privateDir });
    expect(backupDirectory(c.checkout, c.io, targetOf(c))).toMatchObject({
      failure: expect.stringContaining('is inside this checkout'),
    });
  });

  it('writes over nothing, and says so when the export itself fails', (): void => {
    const c = cloud({
      failing: [{ match: 'convex export', status: 1, stderr: 'Error: forbidden' }],
    });
    writeFileSync(join(c.privateDir, 'kept.zip'), 'an earlier backup');
    expect(takeBackup(c.io, targetOf(c), c.privateDir, 'kept')).toMatchObject({
      failure: expect.stringContaining('exists already'),
    });
    expect(takeBackup(c.io, targetOf(c), c.privateDir, 'fresh')).toEqual({
      failure: 'the export failed (exit 1: Error: forbidden)',
    });
    expect(existsSync(join(c.privateDir, 'fresh.zip.sha256'))).toBe(false);
  });

  it("finds an upgrade's earliest export with a checksum beside it, and no other release's", (): void => {
    const c = cloud();
    const sha = (name: string): void =>
      writeFileSync(join(c.privateDir, `${name}.sha256`), `${'a'.repeat(64)}  ${name}\n`);
    for (const name of [
      'before-v0.4.0-20261001T020000Z.zip',
      'before-v0.4.0-20261001T010000Z.zip',
      'before-v0.3.0-20260901T000000Z.zip',
    ]) {
      writeFileSync(join(c.privateDir, name), 'x');
      sha(name);
    }
    writeFileSync(
      join(c.privateDir, 'before-v0.4.0-20261001T000000Z.zip'),
      'no checksum beside it',
    );
    expect(earliestUpgradeExport(c.privateDir, '0.4.0')).toEqual({
      file: join(c.privateDir, 'before-v0.4.0-20261001T010000Z.zip'),
      sha256: 'a'.repeat(64),
    });
    expect(earliestUpgradeExport(c.privateDir, '0.5.0')).toBeUndefined();
  });

  it('is named by a sortable second', (): void => {
    expect(fileStamp(Date.UTC(2026, 9, 1, 2, 3, 4, 567))).toBe('20261001T020304Z');
    expect(`${DEPLOYMENT}-${fileStamp(0)}`).toBe('brisk-heron-417-19700101T000000Z');
  });
});
