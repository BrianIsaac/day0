import { describe, expect, it } from 'vitest';
import { carriedDeclaredReads, noteReleasesRead } from '../../../src/work/promised-reads';
import type { MockAction } from '../../../src/work/types';
import { FIN_1_RETRY_NOTE, LOG_1_RETRY_NOTE, log1RefusedClosing } from '../../fixtures/work/full-run-3-2026-09-19-log-1';

const linear = { slug: 'linear', displayName: 'Linear' };
const slack = { slug: 'slack', displayName: 'Slack' };
const tile = { slug: 'looker', displayName: 'Looker pipeline tile' };
const surfaces = [
  { slug: 'linear', path: 'mcp' as const },
  { slug: 'slack', path: 'documented-api' as const },
  { slug: 'looker', path: 'browser-driven' as const },
];

const snapshot: MockAction = { tool: 'mcp.call', args: { surface: 'looker', tool: 'browser_snapshot', toolArgsJson: '{}' } };

describe('carriedDeclaredReads', () => {
  const [read, comment, done] = log1RefusedClosing.actions;

  it('returns the read LOG-1\'s refused closing set carried for its declared Linear read', (): void => {
    expect(carriedDeclaredReads([{ step: 1, surface: linear }], log1RefusedClosing.actions, surfaces)).toEqual([read]);
  });

  it('returns nothing when no read is unmet, or the set carries no read of the surface', (): void => {
    expect(carriedDeclaredReads([], log1RefusedClosing.actions, surfaces)).toEqual([]);
    expect(carriedDeclaredReads([{ step: 1, surface: linear }], [comment!, done!], surfaces)).toEqual([]);
  });

  it('returns nothing unless every unmet read is covered: a half-covered gap is still the gate\'s to refuse', (): void => {
    const unmet = [{ step: 1, surface: linear }, { step: 4, surface: slack }];
    expect(carriedDeclaredReads(unmet, log1RefusedClosing.actions, surfaces)).toEqual([]);
  });

  it('never takes a write for a read, and never applies a browser read with no page behind it', (): void => {
    expect(carriedDeclaredReads([{ step: 3, surface: linear }], [comment!], surfaces)).toEqual([]);
    expect(carriedDeclaredReads([{ step: 2, surface: tile }], [snapshot], surfaces)).toEqual([]);
  });
});

describe('noteReleasesRead', () => {
  const slackRead = { step: 4, surface: slack };

  it('reads FIN-1\'s note as removing the Slack read, and LOG-1\'s note as removing nothing', (): void => {
    expect(noteReleasesRead(FIN_1_RETRY_NOTE, slackRead)).toBe(true);
    expect(noteReleasesRead(FIN_1_RETRY_NOTE, { step: 1, surface: linear })).toBe(false);
    expect(noteReleasesRead(LOG_1_RETRY_NOTE, { step: 1, surface: linear })).toBe(false);
  });

  it.each([
    'Leave out the Slack step.',
    'Skip the #finance-close check in Slack, it is quiet today.',
    'Post the note without Slack.',
    'The Slack check is not needed for this ticket.',
    'slack is unnecessary here',
    'Skip step 4.',
    'Drop step 4; the thread was answered on a call.',
  ])('releases on: %s', (note): void => {
    expect(noteReleasesRead(note, slackRead)).toBe(true);
  });

  it.each([
    'Do not skip the Slack read.',
    "Don't leave out Slack this time.",
    'No, read Slack first.',
    'There is no reply yet; check Slack again.',
    'Skip the greeting, and answer in Slack.',
    'Skip the greeting and answer in Slack.',
    'Drop the long summary then check Slack.',
    'No Slack read was made, do it now.',
    'There was no Slack check last time; the Slack check is not needed? It is, make it first.',
    'You left out the Slack read again.',
    'Skip step 40.',
    'Skip step 3.',
    'Leave out the Slackbot mention.',
    'Use the unconfirmed-ETA template.',
    '',
  ])('releases nothing on: %s', (note): void => {
    expect(noteReleasesRead(note, slackRead)).toBe(false);
  });

  it('knows a surface by its display name or its slug', (): void => {
    expect(noteReleasesRead('Skip the Looker pipeline tile this time.', { step: 2, surface: tile })).toBe(true);
    expect(noteReleasesRead('No looker read needed.', { step: 2, surface: tile })).toBe(true);
  });
});
