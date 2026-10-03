import { describe, expect, it } from 'vitest';
import {
  confirmationMatches,
  credentialsWords,
  deletedWords,
  listed,
  revokedLines,
  waitingWords,
  type RetirePreview,
} from '../../../../../app/agent/[agentId]/manage/retire-words';
import type { InboxItem } from '../../../../../app/components/InboxEntry';

/** An inbox entry of a kind, with the fields the words read. */
function entry(kind: InboxItem['kind'], extra: Record<string, unknown> = {}): InboxItem {
  return { kind, key: `${kind}-${Math.random()}`, subject: 'REVOPS-7', ...extra } as InboxItem;
}

describe('the retire dialog in words', (): void => {
  it('lists in prose, with "and" before the last', (): void => {
    expect(listed([])).toBe('');
    expect(listed(['a'])).toBe('a');
    expect(listed(['a', 'b'])).toBe('a and b');
    expect(listed(['a', 'b', 'c'])).toBe('a, b and c');
  });

  it('names the rows the manager knows, counts the rest together, and says how many tables', (): void => {
    expect(
      deletedWords({
        rowCounts: {
          events: 41,
          charters: 2,
          workItems: 3,
          skills: 3,
          surfaces: 2,
          corrections: 1,
          externalClaims: 2,
          permissionGrants: 4,
        },
        atLeast: false,
      }),
    ).toBe(
      '2 charter versions, 3 work items, 3 skills, 2 connections, 1 correction, 41 events and 6 other rows across 8 tables',
    );
    expect(deletedWords({ rowCounts: { events: 1 }, atLeast: false })).toBe(
      '1 event across 1 table',
    );
    expect(deletedWords({ rowCounts: { mockTweets: 2 }, atLeast: false })).toBe(
      '2 rows across 1 table',
    );
  });

  it('says a count the preview stopped at is a floor, and when there is nothing to delete', (): void => {
    expect(deletedWords({ rowCounts: { events: 500, charters: 1 }, atLeast: true })).toBe(
      'at least 1 charter version and 500 events across 2 tables',
    );
    expect(deletedWords({ rowCounts: {}, atLeast: false })).toBe(
      'nothing beyond the employee itself: it has made no rows yet',
    );
  });

  it('names each credential by its connection once', (): void => {
    expect(credentialsWords([{ slug: 'linear', displayName: 'Linear' }])).toBe(
      'the Linear credential',
    );
    expect(
      credentialsWords([
        { slug: 'slack', displayName: 'Slack' },
        { slug: 'linear', displayName: 'Linear' },
        { slug: 'slack-2', displayName: 'Slack' },
      ]),
    ).toBe('the Slack and Linear credentials');
  });

  it('counts what waits by kind, a held entry by its writes, and the entries past the read', (): void => {
    expect(waitingWords([], 0)).toBe('');
    expect(
      waitingWords(
        [entry('held', { heldWrites: 2 }), entry('plan'), entry('held', { heldWrites: 1 })],
        3,
      ),
    ).toBe('3 held writes and 1 plan');
    expect(waitingWords([entry('skill'), entry('surface')], 5)).toBe(
      '1 skill to approve, 1 connection to approve and 3 more entries',
    );
    expect(waitingWords([entry('surface'), entry('surface', { ready: 'connect' })], 2)).toBe(
      '1 connection to approve and 1 connection waiting to be connected',
    );
    expect(waitingWords([entry('transfer'), entry('transfer'), entry('plan')], 3)).toBe(
      '2 employees to take on and 1 plan',
    );
  });

  it('matches the typed confirmation whatever its case and spacing, never another name', (): void => {
    expect(confirmationMatches('  Retire   mira ', 'retire Mira')).toBe(true);
    expect(confirmationMatches('retire Mir', 'retire Mira')).toBe(false);
    expect(confirmationMatches('retire Aman', 'retire Mira')).toBe(false);
    expect(confirmationMatches('', 'retire Mira')).toBe(false);
    // A name with a composed letter, typed as the letter and its combining mark (m37).
    expect(confirmationMatches('retire Zoe\u0301', 'retire Zo\u00e9')).toBe(true);
  });
});

describe("what a retire does at the vendor, one line per credential (11-AR's outcomes)", (): void => {
  const outcome = (
    displayName: string,
    system: string,
    result: RetirePreview['outcomes'][number]['outcome'],
  ): RetirePreview['outcomes'][number] => ({
    slug: displayName.toLowerCase(),
    displayName,
    system,
    outcome: result,
  });
  const preview = (
    outcomes: RetirePreview['outcomes'],
    revoked: RetirePreview['revoked'] = [],
  ): Pick<RetirePreview, 'outcomes' | 'revoked'> => ({ outcomes, revoked });

  it("says the employee's own Slack app is deleted in Slack and its Linear access revoked at Linear", (): void => {
    expect(
      revokedLines(
        preview([
          outcome('Slack', 'slack', 'app-deleted'),
          outcome('Linear', 'linear', 'token-revoked'),
        ]),
        'Leo',
      ),
    ).toEqual(["Leo's Slack app: deleted in Slack.", "Leo's Linear access: revoked at Linear."]);
  });

  it('says every other outcome in its own words, a shared app and a server with no revocation included', (): void => {
    expect(
      revokedLines(
        preview([
          outcome('Slack', 'slack', 'app-uninstalled'),
          outcome('Linear', 'linear', 'shared'),
          outcome('Acme docs', 'mcp:docs.acme.test', 'not-supported'),
          outcome('Tracker', 'mcp:tracker.acme.test', 'failed'),
          outcome('Wiki', 'mcp:wiki.acme.test', 'not-at-vendor'),
        ]),
        'Leo',
      ),
    ).toEqual([
      "Leo's Slack app: uninstalled from Slack.",
      "Leo's Linear access: ends for Leo only; the app your employees share is not revoked at Linear.",
      "Leo's Acme docs access: docs.acme.test offers no way to revoke it, so Day0 deletes its copy.",
      "Leo's Tracker access: Day0 can no longer revoke it at tracker.acme.test, so revoke it there.",
      "Leo's Wiki access: ends in Day0, with nothing to revoke at wiki.acme.test.",
    ]);
  });

  it("says in the plan's own words what stays at the vendor for IT, never that the vendor cannot revoke it (R41V-11)", (): void => {
    expect(
      revokedLines(
        preview([
          {
            ...outcome('Slack', 'slack', 'not-supported'),
            reason:
              "Day0 holds no configuration token to delete the app; delete it in Slack's app settings.",
          },
        ]),
        'Wren',
      ),
    ).toEqual([
      "Wren's Slack access: Day0 holds no configuration token to delete the app; delete it in Slack's app settings.",
    ]);
  });

  it('keeps the pasted-key sentence for the keys someone pasted, and says nothing here of a kept key', (): void => {
    expect(
      revokedLines(
        preview(
          [outcome('Linear', 'Linear', 'pasted-key'), outcome('Slack', 'Slack', 'kept')],
          [{ slug: 'linear', displayName: 'Linear' }],
        ),
        'Leo',
      ),
    ).toEqual([
      'The Linear credential: Day0 deletes its copy at once, so no later run can use it. The token stays valid at the provider until you revoke it there.',
    ]);
  });

  it('says the revoked credentials as before where the preview carries no outcome for them', (): void => {
    expect(revokedLines(preview([], [{ slug: 'linear', displayName: 'Linear' }]), 'Leo')).toEqual([
      'The Linear credential: Day0 deletes its copy at once, so no later run can use it. The token stays valid at the provider until you revoke it there.',
    ]);
    expect(revokedLines(preview([]), 'Leo')).toEqual([]);
  });
});
