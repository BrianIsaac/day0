import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  changelogReleases,
  LAST_UNVERSIONED_RELEASE,
  listsReleaseTable,
  parseReleaseStamp,
  upgradeVerdict,
} from '../../scripts/releases';

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
    upgradeVerdict({ stored, fresh, checkout, releases: RELEASES });

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
});
