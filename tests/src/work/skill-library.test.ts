import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CHECK_NOT_KEPT_REASON,
  HANDED_OVER_AUTHOR_NAME,
  HANDED_OVER_RECHECK_REASON,
  MAX_AUTHORING_ATTEMPTS,
  countsAsAuthoringAttempt,
  harnessToolsBySurface,
  harnessToolsNamed,
  isNewerVersionReason,
  isOfferable,
  newerVersionReason,
  nextVersionNumber,
  sharedSkillsEnabled,
  surfaceCutReason,
  versionBodyHash,
  versionStanding,
} from '../../../src/work/skill-library';
import { skillBodyHash } from '../../../src/work/skill-body';

describe('nextVersionNumber', (): void => {
  it('numbers a new name 1 and a known one past its newest version, gaps and order aside', (): void => {
    expect(nextVersionNumber([])).toBe(1);
    expect(nextVersionNumber([1])).toBe(2);
    expect(nextVersionNumber([3, 1])).toBe(4);
  });
});

describe('versionBodyHash', (): void => {
  it('is the body hash alone while the check is not kept, so it matches the ledger', (): void => {
    expect(versionBodyHash('# body', undefined)).toBe(skillBodyHash('# body'));
  });

  it('covers the body and the smoke test with a separator neither can carry', (): void => {
    const expected = `sha256:${createHash('sha256').update('# body\u0000print(1)', 'utf8').digest('hex')}`;
    expect(versionBodyHash('# body', 'print(1)')).toBe(expected);
    expect(versionBodyHash('ab', 'c')).not.toBe(versionBodyHash('a', 'bc'));
    expect(versionBodyHash('# body', '')).not.toBe(versionBodyHash('# body', undefined));
  });
});

describe('versionStanding and isOfferable', (): void => {
  it('offers only a version with a kept check, not revoked and not superseded', (): void => {
    expect(versionStanding({ smokeTest: 'print(1)' })).toBe('offerable');
    expect(isOfferable({ smokeTest: 'print(1)' })).toBe(true);
    expect(versionStanding({})).toBe('check-not-kept');
    expect(isOfferable({})).toBe(false);
    expect(versionStanding({ smokeTest: 'print(1)', supersededAt: 2 })).toBe('superseded');
    expect(isOfferable({ smokeTest: 'print(1)', supersededAt: 2 })).toBe(false);
  });

  it('reads a revoked version as revoked before any other standing', (): void => {
    expect(versionStanding({ revokedAt: 3, supersededAt: 2 })).toBe('revoked');
    expect(versionStanding({ revokedAt: 3 })).toBe('revoked');
    expect(isOfferable({ smokeTest: 'print(1)', revokedAt: 3 })).toBe(false);
  });
});

describe('the re-check reasons', (): void => {
  it('says why each trigger stamped the chip, in the words the card shows', (): void => {
    expect(CHECK_NOT_KEPT_REASON).toBe('its check was not kept');
    expect(newerVersionReason(3, 2)).toBe('v3 is verified; this runs v2');
    expect(surfaceCutReason('linear')).toBe(
      'its connection to linear was cut when the employee was handed over',
    );
  });
});

describe('sharedSkillsEnabled (K4)', (): void => {
  it('is on unless the flag says off', (): void => {
    for (const on of [undefined, '', '1', 'true', 'on', 'yes', 'TRUE']) {
      expect(sharedSkillsEnabled(on), String(on)).toBe(true);
    }
    for (const off of ['0', 'false', 'off', 'no', ' Off ', 'FALSE']) {
      expect(sharedSkillsEnabled(off), off).toBe(false);
    }
  });
});

describe('countsAsAuthoringAttempt', (): void => {
  const fresh = { state: 'approved', body: '' } as const;

  it('counts a run that writes a body from the start or again after a failure', (): void => {
    expect(countsAsAuthoringAttempt(fresh)).toBe(true);
    expect(countsAsAuthoringAttempt({ state: 'failed', body: '# old' })).toBe(true);
  });

  it('does not count a run that only carries on an attempt already counted', (): void => {
    // A provider outage's own retry, a takeover of a run that stopped, and a check of a body
    // already written but never run are the same attempt.
    expect(countsAsAuthoringAttempt({ state: 'authoring', body: '', authoringDeferrals: 1 })).toBe(
      false,
    );
    expect(
      countsAsAuthoringAttempt({ state: 'authoring', body: '# b', authoringRunId: 'run-1' }),
    ).toBe(false);
    expect(
      countsAsAuthoringAttempt({ state: 'authoring', body: '# b', pendingSmokeTest: 'print(1)' }),
    ).toBe(false);
  });

  it('caps the attempts the card counts at three', (): void => {
    expect(MAX_AUTHORING_ATTEMPTS).toBe(3);
  });
});

describe('harnessToolsNamed', (): void => {
  const surfaces = [
    { allowedTools: ['save_comment', 'save_issue', 'list_issues'] },
    { allowedTools: ['chat.postMessage', 'chat.update'] },
  ];

  it('lists the allowed tools SKILL.md names as whole words, once each, in allowlist order', (): void => {
    const body = [
      'Call `save_comment` on <record-id>, then `save_issue` to close it.',
      'Reply with chat.postMessage. Never save_comment twice.',
    ].join('\n');
    expect(harnessToolsNamed(body, surfaces)).toEqual([
      'save_comment',
      'save_issue',
      'chat.postMessage',
    ]);
  });

  it('does not read a tool inside a longer word or a dotted name', (): void => {
    expect(harnessToolsNamed('use save_comments and chat.update.v2', surfaces)).toEqual([]);
  });
});

describe('harnessToolsBySurface', (): void => {
  it('says which surface allows each tool SKILL.md names, and leaves out a surface it names none of', (): void => {
    const body = 'Call `save_comment`, then reply with chat.postMessage.';
    expect(
      harnessToolsBySurface(body, [
        { slug: 'linear', surfaceClass: 'kanban', allowedTools: ['save_comment', 'save_issue'] },
        { slug: 'slack', surfaceClass: 'chat', allowedTools: ['chat.postMessage'] },
        { slug: 'notion', allowedTools: ['notion-search'] },
      ]),
    ).toEqual([
      { slug: 'linear', surfaceClass: 'kanban', tools: ['save_comment'] },
      { slug: 'slack', surfaceClass: 'chat', tools: ['chat.postMessage'] },
    ]);
  });
});

describe('what a handover rewrites', (): void => {
  it('recognises the newer-version reason, which names the old library’s numbers, and nothing else', (): void => {
    expect(isNewerVersionReason(newerVersionReason(12, 3))).toBe(true);
    expect(isNewerVersionReason(CHECK_NOT_KEPT_REASON)).toBe(false);
    expect(isNewerVersionReason(surfaceCutReason('linear'))).toBe(false);
    expect(isNewerVersionReason('v3 is verified; this runs v2 and more')).toBe(false);
  });

  it('names an author left behind at a handover without naming them', (): void => {
    expect(HANDED_OVER_AUTHOR_NAME).toBe('a colleague under the previous manager');
    expect(HANDED_OVER_RECHECK_REASON).toBe(
      'it was due a re-check when the employee was handed over',
    );
  });
});
