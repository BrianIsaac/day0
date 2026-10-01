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
      'Rollback (nothing here is run for you), in this order:',
      `  1. the rows and functions: /private/before-v0.4.0.zip (sha256 ${'ab'.repeat(32)}) holds the rows from before the upgrade to v0.4.0. From a clean checkout of v0.3.0, take \`./setup.sh cloud backup\` of what you replace, then npx convex import --replace-all --deployment brisk-heron-417 /private/before-v0.4.0.zip and npx convex deploy --typecheck enable --env-file /private/prod-target.env.`,
      '  2. the app, after the import and the push: vercel promote dpl_Before1 --scope team-a, the build that served production before this run.',
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
    expect(lines[1]).toContain(
      'from before the upgrade to v0.4.0, taken when that upgrade first ran.',
    );
    expect(lines[1]).toContain(
      'From a clean checkout of the release the deployment ran before v0.4.0 (this run did not read which),',
    );
  });

  it('after a re-push of the release it read, rolls back from this checkout, whose export it took', (): void => {
    const lines = rollbackLines({
      target: TARGET,
      previousApp: 'dpl_Same1',
      upgrade: {
        to: '0.4.0',
        from: undefined,
        backup: { file: '/private/before-v0.4.0-b.zip', sha256: 'ef'.repeat(32), earlier: false },
      },
    });
    expect(lines[1]).toContain(
      'holds the rows from before this run, which found v0.4.0 already there. From a clean checkout of v0.4.0 (this one), take',
    );
    expect(lines[1]).not.toContain('the release before it');
    expect(lines[2]).toBe(
      '  2. the app, after the import and the push: vercel promote dpl_Same1, the build that served production before this run.',
    );
  });

  // Re-pinned: a step with nothing to do is a note under the steps, never a numbered step.
  it('after a first push, says the deployment held nothing and the Vercel values changed', (): void => {
    const lines = rollbackLines({ target: TARGET, appValuesChanged: true });
    expect(lines[0]).toBe('Rollback (nothing here is run for you):');
    expect(lines[1]).toContain('  1. its Convex values: this run set NEXT_PUBLIC_CONVEX_URL');
    expect(lines[1]).toContain('put back what they held');
    expect(lines[2]).toBe('  the app: this run read no earlier production build to go back to.');
    expect(lines[3]).toBe(
      '  the deployment: brisk-heron-417 held nothing before this run; an app that points away from it leaves it serving nobody.',
    );
  });

  it('after a first push that changed the values of a served app, puts the values back before the promote', (): void => {
    const lines = rollbackLines({
      target: TARGET,
      appValuesChanged: true,
      previousApp: 'dpl_Dev1',
    });
    expect(lines[0]).toBe('Rollback (nothing here is run for you), in this order:');
    expect(lines[1]).toMatch(
      /^ {2}1\. its Convex values: .* before promoting the earlier build\.$/,
    );
    expect(lines[2]).toBe(
      '  2. the app: vercel promote dpl_Dev1, the build that served production before this run.',
    );
  });

  it('after an upgrade that left the app alone, numbers only the step there is to take', (): void => {
    expect(
      rollbackLines({
        target: TARGET,
        upgrade: {
          to: '0.4.0',
          from: '0.3.0',
          backup: { file: '/private/before-v0.4.0.zip', sha256: 'ab'.repeat(32), earlier: false },
        },
      }),
    ).toEqual([
      'Rollback (nothing here is run for you):',
      `  1. the rows and functions: /private/before-v0.4.0.zip (sha256 ${'ab'.repeat(32)}) holds the rows from before the upgrade to v0.4.0. From a clean checkout of v0.3.0, take \`./setup.sh cloud backup\` of what you replace, then npx convex import --replace-all --deployment brisk-heron-417 /private/before-v0.4.0.zip and npx convex deploy --typecheck enable --env-file /private/prod-target.env.`,
      '  the app: this run read no earlier production build to go back to.',
    ]);
  });

  it('after a first push with no app, has no step to number, only what the run left', (): void => {
    expect(rollbackLines({ target: TARGET })).toEqual([
      'Rollback (nothing here is run for you):',
      '  the app: this run read no earlier production build to go back to.',
      '  the deployment: brisk-heron-417 held nothing before this run; an app that points away from it leaves it serving nobody.',
    ]);
  });
});
