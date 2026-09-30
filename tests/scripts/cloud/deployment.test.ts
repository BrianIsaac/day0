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
    expect(proveTarget(c.io, targetOf(c), true)).toBeUndefined();
    expect(ran(c)[0]).toBe(`npx convex deploy --dry-run --typecheck enable --env-file ${c.target}`);
  });

  it('refuses a dry run that names nothing, in its own first words', (): void => {
    const c = cloud({ defaultProd: 'other-prod-789' });
    expect(proveTarget(c.io, targetOf(c), true)?.failure).toContain(
      'exit 1: ✖ Cannot prompt for input in non-interactive terminals.',
    );
  });

  it('refuses a dry run after which the checkout is changed', (): void => {
    const c = cloud({ dirty: true });
    expect(proveTarget(c.io, targetOf(c), true)?.failure).toContain(
      'the dry run changed the checkout',
    );
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
    const failure = pushFunctions(c.io, targetOf(c), 'v0.3.0 test')?.failure ?? '';
    expect(failure).toContain('the push did not report deploying to happy-otter-123 (exit 1)');
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
    expect(c.state.stamp).toEqual({ release: '0.3.0', commit: COMMIT });
  });

  it('stops after twelve calls with the migrations still pending named', (): void => {
    const c = cloud({ pendingMigrations: Array.from({ length: 14 }, (_, index) => `m${index}`) });
    expect(migrateAndStamp(c.io, targetOf(c), checkoutOf(c))).toEqual({
      failure:
        'migrations still pending after 12 calls (m12, m13); run the verb again, which resumes them',
    });
    expect(c.state.stamp?.release).toBe('0.2.0');
  });

  it('refuses a stamp that does not read back as written', (): void => {
    const c = cloud({
      failing: [
        {
          match: 'data deploymentVersions',
          status: 0,
          stderr: '',
          stdout: '{"release":"0.2.0","commit":"x"}\n',
        },
      ],
    });
    expect(migrateAndStamp(c.io, targetOf(c), checkoutOf(c))).toEqual({
      failure: `the stamp reads 0.2.0 / x after stamping 0.3.0 / ${COMMIT}`,
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

  it('is named by a sortable second', (): void => {
    expect(fileStamp(Date.UTC(2026, 9, 1, 2, 3, 4, 567))).toBe('20261001T020304Z');
    expect(`${DEPLOYMENT}-${fileStamp(0)}`).toBe('happy-otter-123-19700101T000000Z');
  });
});
