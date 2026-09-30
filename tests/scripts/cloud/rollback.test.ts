import { describe, expect, it } from 'vitest';
import { rollbackLines } from '../../../scripts/cloud/rollback';

const TARGET = { file: '/private/prod-target.env', deployment: 'brisk-heron-417' };

describe('rollbackLines', (): void => {
  it('after an upgrade, names the earlier build and the export with its checksum', (): void => {
    expect(
      rollbackLines({
        target: { ...TARGET, scope: 'team-a' },
        previousApp: 'dpl_Before1',
        previousRelease: '0.3.0',
        backup: { file: '/private/before-v0.4.0.zip', sha256: 'ab'.repeat(32) },
      }),
    ).toEqual([
      'Rollback (nothing here is run for you):',
      '  the app: vercel promote dpl_Before1 --scope team-a, the build that served production before this run.',
      `  the rows and functions: /private/before-v0.4.0.zip (sha256 ${'ab'.repeat(32)}) holds the rows at v0.3.0. From a clean checkout of v0.3.0, take \`./setup.sh cloud backup\` of what you replace, then npx convex import --replace-all --deployment brisk-heron-417 /private/before-v0.4.0.zip and npx convex deploy --typecheck enable --env-file /private/prod-target.env.`,
    ]);
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
