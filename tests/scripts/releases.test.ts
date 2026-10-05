import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  changelogReleases,
  checkoutRefusal,
  LAST_UNVERSIONED_RELEASE,
  listsReleaseTable,
  migrationLines,
  parseMigrationReport,
  parseReleaseStamp,
  readReleaseVerdict,
  releaseStampArguments,
  RETIRED_DECLARATIONS,
  RETIRING_DECLARATIONS,
  unclearedDeclarations,
  upgradeVerdict,
} from '../../scripts/releases';
import { compareReleases, NEWEST_MIGRATION_RELEASE } from '../../src/lib/release';

const RELEASES = ['0.1.0', '0.2.0', '0.3.0', '0.4.0'];

describe('the releases a checkout records', (): void => {
  it('reads them from the CHANGELOG headings, oldest first, ignoring the undated sections', (): void => {
    const changelog = [
      '# Changelog',
      '## v0.3.0, 27 September 2026',
      '- **The ticket is re-read** (see ## v9.9.9 in prose, not a heading)',
      '## v0.2.0, 27 September 2026',
      '## v0.1.0, 16 to 19 September 2026',
      '## Before v0.1.0, 4 to 16 September 2026',
    ].join('\n');
    expect(changelogReleases(changelog)).toEqual(['0.1.0', '0.2.0', '0.3.0']);
  });

  it('has this repository’s package.json version as its newest CHANGELOG release', (): void => {
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const releases = changelogReleases(changelog);
    expect(releases.at(-1)).toBe(version);
    expect(releases).toContain(LAST_UNVERSIONED_RELEASE);
  });
});

describe('the release stamp as the Convex CLI prints it', (): void => {
  it('finds the table in a listing and the stamp in one JSON line', (): void => {
    expect(listsReleaseTable('agents\ndeploymentVersions\nevents\n')).toBe(true);
    expect(listsReleaseTable('')).toBe(false);
    expect(
      parseReleaseStamp(
        '{"_creationTime":1,"_id":"k1","commit":"06823b19","recordedAt":2,"release":"0.3.0"}\n',
      ),
    ).toEqual({ release: '0.3.0', commit: '06823b19' });
    expect(parseReleaseStamp('')).toBeUndefined();
    expect(() => parseReleaseStamp('{"_id":"k1"}')).toThrow('carries no release');
  });
});

describe('whether the upgrade may push this checkout (decision N10)', (): void => {
  const verdict = (stored: string | undefined, checkout: string, fresh = false) =>
    upgradeVerdict({
      stored,
      fresh,
      checkout,
      releases: RELEASES,
      newestMigrationRelease: '0.3.0',
    });

  it('allows a new volume, the same release again, and the next release', (): void => {
    expect(verdict(undefined, '0.4.0', true)).toMatchObject({ allowed: true });
    expect(verdict('0.3.0', '0.3.0')).toMatchObject({ allowed: true, note: 'already at 0.3.0' });
    expect(verdict('0.3.0', '0.4.0')).toMatchObject({ allowed: true, note: '0.3.0 to 0.4.0' });
  });

  it('takes rows with no stamp as the last release before the stamp existed', (): void => {
    expect(verdict(undefined, '0.4.0')).toMatchObject({
      allowed: true,
      note: '0.3.0 (taken from its unstamped rows) to 0.4.0',
    });
    expect(verdict(undefined, '0.2.0')).toMatchObject({ allowed: false });
  });

  it('refuses a jump of more than one release and names the release to go through first', (): void => {
    const refused = verdict('0.1.0', '0.4.0');
    expect(refused.allowed).toBe(false);
    expect(refused.allowed ? '' : refused.reason).toContain('0.4.0 skips 0.2.0, 0.3.0');
    expect(refused.allowed ? '' : refused.reason).toContain('check out v0.2.0');
  });

  it('refuses older functions over newer rows, an unknown stamp and a checkout the CHANGELOG lacks', (): void => {
    const older = verdict('0.4.0', '0.3.0');
    expect(older.allowed ? '' : older.reason).toContain('newer than this checkout');
    const unknown = verdict('0.9.0', '0.4.0');
    expect(unknown.allowed ? '' : unknown.reason).toContain('does not record');
    const unlisted = verdict('0.3.0', '0.5.0');
    expect(unlisted.allowed ? '' : unlisted.reason).toContain('has no heading in CHANGELOG.md');
  });

  it('refuses a checkout older than the newest release its migrations name, new volume or kept, naming both files', (): void => {
    for (const [stored, fresh] of [
      [undefined, true],
      ['0.3.0', false],
      ['0.2.0', false],
      [undefined, false],
    ] as const) {
      const refused = upgradeVerdict({
        stored,
        fresh,
        checkout: '0.3.0',
        releases: RELEASES,
        newestMigrationRelease: '0.4.0',
      });
      expect(refused.allowed, `${stored} ${fresh}`).toBe(false);
      const reason = refused.allowed ? '' : refused.reason;
      expect(reason).toContain('0.3.0, from package.json) is older than 0.4.0');
      expect(reason).toContain("set package.json's version to 0.4.0");
      expect(reason).toContain('"## v0.4.0" heading to CHANGELOG.md');
    }
    expect(
      upgradeVerdict({
        stored: '0.3.0',
        fresh: false,
        checkout: '0.4.0',
        releases: RELEASES,
        newestMigrationRelease: '0.4.0',
      }),
    ).toMatchObject({ allowed: true, note: '0.3.0 to 0.4.0' });
  });
});

describe('what refuses a checkout before the deployment is read', (): void => {
  it('refuses a release older than the migrations, then one the CHANGELOG lacks, and takes a newer one', (): void => {
    expect(
      checkoutRefusal({ release: '0.3.0', releases: RELEASES, newestMigrationRelease: '0.4.0' }),
    ).toContain('older than 0.4.0');
    expect(
      checkoutRefusal({ release: '0.4.0', releases: ['0.3.0'], newestMigrationRelease: '0.4.0' }),
    ).toContain('no heading in CHANGELOG.md');
    expect(
      checkoutRefusal({ release: '0.4.0', releases: RELEASES, newestMigrationRelease: '0.4.0' }),
    ).toBeUndefined();
    expect(
      checkoutRefusal({ release: '0.4.0', releases: RELEASES, newestMigrationRelease: '0.3.0' }),
    ).toBeUndefined();
    expect(
      checkoutRefusal({ release: 'v0.4.0', releases: RELEASES, newestMigrationRelease: '0.3.0' }),
    ).toContain('not shaped as X.Y.Z');
  });

  it('is what this repository would meet: its package.json against the release its migrations name', (): void => {
    const changelog = readFileSync(new URL('../../CHANGELOG.md', import.meta.url), 'utf8');
    const { version } = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string };
    const refusal = checkoutRefusal({
      release: version,
      releases: changelogReleases(changelog),
      newestMigrationRelease: NEWEST_MIGRATION_RELEASE,
    });
    // Between a tag and the release commit that follows it, staging is refused
    // by name; at a tag, it is not.
    if (compareReleases(version, NEWEST_MIGRATION_RELEASE) < 0) {
      expect(refusal).toContain(`older than ${NEWEST_MIGRATION_RELEASE}`);
    } else {
      expect(refusal).toBeUndefined();
    }
  });
});

describe('reading the verdict through the Convex CLI', (): void => {
  const cli =
    (answers: Record<string, { status?: number; stdout?: string; stderr?: string }>) =>
    (args: readonly string[]) => ({
      status: 0,
      stdout: '',
      stderr: '',
      ...answers[args.join(' ')],
    });
  const checkout = { release: '0.4.0', releases: RELEASES, newestMigrationRelease: '0.4.0' };

  it('takes a deployment that lists no tables as new, and reads the stamp when its table is there', (): void => {
    expect(readReleaseVerdict(cli({}), checkout)).toMatchObject({ allowed: true, from: undefined });
    expect(
      readReleaseVerdict(
        cli({
          'convex data': { stdout: 'agents\ndeploymentVersions\n' },
          'convex data deploymentVersions --limit 1 --format jsonl': {
            stdout: '{"release":"0.2.0","recordedAt":1}\n',
          },
        }),
        checkout,
      ),
    ).toMatchObject({ allowed: false });
  });

  it('refuses a checkout older than its migrations before any CLI call, so nothing on the deployment is read or changed', (): void => {
    const calls: string[] = [];
    const verdict = readReleaseVerdict(
      (args) => {
        calls.push(args.join(' '));
        return { status: 0, stdout: '', stderr: '' };
      },
      { ...checkout, release: '0.3.0' },
    );
    expect(verdict).toMatchObject({ allowed: false });
    expect(verdict.allowed ? '' : verdict.reason).toContain('older than 0.4.0');
    expect(calls).toEqual([]);
  });

  it('refuses a deployment whose tables cannot be listed', (): void => {
    const verdict = readReleaseVerdict(
      cli({ 'convex data': { status: 1, stderr: 'Failed to connect\n' } }),
      checkout,
    );
    expect(verdict).toEqual({
      allowed: false,
      reason: "the deployment's tables could not be listed: Failed to connect",
    });
  });
});

describe('the declarations this checkout retired (N10)', (): void => {
  const finished = (name: string): string =>
    `${JSON.stringify({ name, release: '0.4.0', read: 3, changed: 1, startedAt: 1, completedAt: 2 })}\n`;

  it('names each retired declaration whose clearing migration has not finished', (): void => {
    const all = RETIRED_DECLARATIONS.map(({ migration }) => finished(migration)).join('');
    expect(unclearedDeclarations(all)).toEqual([]);
    const started = `${JSON.stringify({ name: 'agents-posture', read: 3, changed: 1, startedAt: 1 })}\n`;
    const partial = RETIRED_DECLARATIONS.filter(({ migration }) => migration !== 'agents-posture')
      .map(({ migration }) => finished(migration))
      .join('');
    expect(unclearedDeclarations(partial + started).map((row) => row.declaration)).toEqual([
      'agents.posture',
    ]);
    expect(unclearedDeclarations('')).toEqual(RETIRED_DECLARATIONS);
  });

  it('refuses rows stamped before the clearing release until its migrations have finished, and passes a new one', (): void => {
    const checkout = { release: '0.4.0', releases: RELEASES, newestMigrationRelease: '0.4.0' };
    const cli = (answers: Record<string, string>) => (args: readonly string[]) => ({
      status: 0,
      stdout: answers[args.join(' ')] ?? '',
      stderr: '',
    });
    const stampedAt = (release: string, migrations?: string): Record<string, string> => ({
      'convex data': `agents\ndeploymentVersions\n${migrations === undefined ? '' : 'migrations\n'}`,
      'convex data deploymentVersions --limit 1 --format jsonl': `{"release":"${release}","recordedAt":1}\n`,
      ...(migrations === undefined
        ? {}
        : { 'convex data migrations --limit 1000 --format jsonl': migrations }),
    });
    const refused = readReleaseVerdict(cli(stampedAt('0.3.0')), checkout);
    expect(refused.allowed ? '' : refused.reason).toContain(
      'rows may still carry agents.docSourceIds, agents.posture',
    );
    expect(readReleaseVerdict(cli({}), checkout)).toMatchObject({ allowed: true });
    const allFinished = RETIRED_DECLARATIONS.map(({ migration }) => finished(migration)).join('');
    expect(readReleaseVerdict(cli(stampedAt('0.3.0', allFinished)), checkout)).toMatchObject({
      allowed: true,
    });
    const garbled = readReleaseVerdict(cli(stampedAt('0.3.0', '{not json\n')), checkout);
    expect(garbled.allowed ? '' : garbled.reason).toContain(
      "the deployment's migrations could not be read",
    );
  });

  it('passes rows stamped at or after the clearing release, which a volume created then never needed the migrations for', (): void => {
    // Re-pinned at 12-S3: the retired list now holds a declaration cleared at 0.6.0, which a
    // checkout that records no 0.6.0 must check, so the stamp and the checkout are at 0.6.0.
    // Re-pinned again at 13-K: it holds one cleared at 0.16.0 too, so both are at 0.16.0.
    const checkout = {
      release: '0.16.0',
      releases: [...RELEASES, '0.5.0', '0.6.0', '0.15.0', '0.16.0'],
      newestMigrationRelease: '0.16.0',
    };
    const cli = (args: readonly string[]) => ({
      status: 0,
      stdout:
        {
          'convex data': 'agents\ndeploymentVersions\nmigrations\n',
          'convex data deploymentVersions --limit 1 --format jsonl':
            '{"release":"0.16.0","recordedAt":1}\n',
          'convex data migrations --limit 1000 --format jsonl': finished('agents-owner'),
        }[args.join(' ')] ?? '',
      stderr: '',
    });
    expect(readReleaseVerdict(cli, checkout)).toMatchObject({ allowed: true });
  });
});

describe('the declarations the next release retires (N10, Q D2)', (): void => {
  // Re-pinned at 12-S3: this checkout no longer declares itApprovedAt (it moved to
  // RETIRED_DECLARATIONS), so the v0.5.0 volume this test pushed is now refused until its
  // single-approval migration has finished.
  it('refuses a v0.5.0 volume whose single-approval migration has not run, now this checkout no longer declares itApprovedAt', (): void => {
    expect(RETIRED_DECLARATIONS).toContainEqual({
      declaration: 'surfaces.itApprovedAt',
      migration: 'surfaces-single-approval',
      release: '0.6.0',
    });
    // A v0.5.0 volume finished v0.4.0's clearing migrations and none of this release's.
    const cleared = RETIRED_DECLARATIONS.filter((row) => row.release === '0.4.0')
      .map(
        ({ migration }) =>
          `${JSON.stringify({ name: migration, release: '0.4.0', read: 1, changed: 0, startedAt: 1, completedAt: 2 })}\n`,
      )
      .join('');
    const cli = (args: readonly string[]) => ({
      status: 0,
      stdout:
        {
          'convex data': 'agents\ndeploymentVersions\nmigrations\nsurfaces\n',
          'convex data deploymentVersions --limit 1 --format jsonl':
            '{"release":"0.5.0","recordedAt":1}\n',
          'convex data migrations --limit 1000 --format jsonl': cleared,
        }[args.join(' ')] ?? '',
      stderr: '',
    });
    const refused = readReleaseVerdict(cli, {
      release: '0.6.0',
      releases: [...RELEASES, '0.5.0', '0.6.0'],
      newestMigrationRelease: '0.6.0',
    });
    expect(refused).toMatchObject({ allowed: false });
    // Re-pinned at 13-K: the retired list now also holds docSyncRuns.refs, cleared at 0.16.0, which
    // a v0.5.0 volume has not run either, so the refusal names both and both migrations.
    expect(refused.allowed ? '' : refused.reason).toContain(
      'rows may still carry surfaces.itApprovedAt, docSyncRuns.refs',
    );
    expect(refused.allowed ? '' : refused.reason).toContain(
      '(surfaces-single-approval, sync-runs-refs)',
    );
  });

  // Re-pinned at 13-K (was "pushes a v0.15.0 volume ..., since this checkout still declares
  // docSyncRuns.refs (12-S3)"): the declaration moved to RETIRED_DECLARATIONS, so the same volume
  // is now refused until its clearing migration has finished, and a v0.16.0 volume, whose stamp
  // says it finished, pushes.
  it('refuses a v0.15.0 volume whose sync-runs-refs migration has not run, now this checkout no longer declares docSyncRuns.refs, and pushes a v0.16.0 one', (): void => {
    expect(RETIRED_DECLARATIONS).toContainEqual({
      declaration: 'docSyncRuns.refs',
      migration: 'sync-runs-refs',
      release: '0.16.0',
    });
    expect(RETIRING_DECLARATIONS).toEqual([]);
    const releases = [...RELEASES, '0.5.0', '0.6.0', '0.15.0', '0.16.0', '0.17.0'];
    const cli =
      (stamp: string) =>
      (args: readonly string[]): { status: number; stdout: string; stderr: string } => ({
        status: 0,
        stdout:
          {
            'convex data': 'agents\ndeploymentVersions\nmigrations\ndocSyncRuns\n',
            'convex data deploymentVersions --limit 1 --format jsonl': `{"release":"${stamp}","recordedAt":1}\n`,
            // Every migration of 0.15.0 and before finished; none of 0.16.0's has run yet.
            'convex data migrations --limit 1000 --format jsonl': '',
          }[args.join(' ')] ?? '',
        stderr: '',
      });
    const refused = readReleaseVerdict(cli('0.15.0'), {
      release: '0.16.0',
      releases,
      newestMigrationRelease: '0.16.0',
    });
    expect(refused.allowed ? '' : refused.reason).toContain(
      'rows may still carry docSyncRuns.refs',
    );
    expect(
      readReleaseVerdict(cli('0.16.0'), {
        release: '0.17.0',
        releases,
        newestMigrationRelease: '0.17.0',
      }),
    ).toMatchObject({ allowed: true, from: '0.16.0' });
  });
});

describe('the migration report the upgrade prints', (): void => {
  it('reads the runPending answer and says what changed and who owns nothing', (): void => {
    const report = parseMigrationReport(
      'noise before\n{"migrations":[{"name":"agents-owner","read":3,"changed":1},{"name":"agents-posture","read":4,"changed":0}],"pending":[]}\n',
    );
    expect(migrationLines(report)).toEqual([
      'migrated agents-owner: 1 row(s) changed',
      '2 agent(s) with no owner were left as they are: this deployment has more than one owner, so none is theirs by default',
    ]);
    expect(() => parseMigrationReport('')).toThrow('printed no report');
    expect(releaseStampArguments('0.4.0', 'abc123')).toEqual([
      'convex',
      'run',
      'migrations:recordRelease',
      '{"release":"0.4.0","commit":"abc123"}',
    ]);
  });
});
