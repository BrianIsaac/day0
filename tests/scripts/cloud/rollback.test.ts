import { describe, expect, it } from 'vitest';
import { rollbackLines } from '../../../scripts/cloud/rollback';

const TARGET = { file: '/private/prod-target.env', deployment: 'brisk-heron-417' };

describe('rollbackLines', (): void => {
  it('after an upgrade, names the earlier build and the export with its checksum', (): void => {
    const backup = { file: '/private/before-v0.4.0.zip', sha256: 'ab'.repeat(32), earlier: false };
    expect(
      rollbackLines({
        target: { ...TARGET, scope: 'team-a' },
        previousApp: 'dpl_Before1',
        upgrade: { to: '0.4.0', from: '0.3.0', backup },
      }),
    ).toEqual([
      'Rollback (nothing here is run for you):',
      '  the app: vercel promote dpl_Before1 --scope team-a, the build that served production before this run.',
      `  the rows and functions: /private/before-v0.4.0.zip (sha256 ${'ab'.repeat(32)}) holds the rows from before the upgrade to v0.4.0. From a clean checkout of v0.3.0, take \`./setup.sh cloud backup\` of what you replace, then npx convex import --replace-all --deployment brisk-heron-417 /private/before-v0.4.0.zip and npx convex deploy --typecheck enable --env-file /private/prod-target.env.`,
    ]);
  });

  it("after a re-run, says the export is the first attempt's and names no release it did not read", (): void => {
    const lines = rollbackLines({
      target: TARGET,
      upgrade: {
        to: '0.4.0',
        from: undefined,
        backup: { file: '/private/before-v0.4.0-a.zip', sha256: 'cd'.repeat(32), earlier: true },
      },
    });
    expect(lines[2]).toContain(
      'from before the upgrade to v0.4.0, taken when that upgrade first ran.',
    );
    expect(lines[2]).toContain('From a clean checkout of the release before it,');
  });

  it('after a first push, says the deployment held nothing and the Vercel values changed', (): void => {
    const lines = rollbackLines({ target: TARGET, appValuesChanged: true });
    expect(lines[1]).toBe('  the app: this run read no earlier production build to go back to.');
    expect(lines[2]).toContain('put back what they held');
    expect(lines[3]).toBe(
      '  the deployment: brisk-heron-417 held nothing before this run; an app that points away from it leaves it serving nobody.',
    );
  });
});
