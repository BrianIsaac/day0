import { describe, expect, it } from 'vitest';
import {
  confirmationMatches,
  credentialsWords,
  deletedWords,
  listed,
  waitingWords,
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
  });

  it('matches the typed confirmation whatever its case and spacing, never another name', (): void => {
    expect(confirmationMatches('  Retire   mira ', 'retire Mira')).toBe(true);
    expect(confirmationMatches('retire Mir', 'retire Mira')).toBe(false);
    expect(confirmationMatches('retire Aman', 'retire Mira')).toBe(false);
    expect(confirmationMatches('', 'retire Mira')).toBe(false);
  });
});
