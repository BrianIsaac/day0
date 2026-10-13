import { describe, expect, it } from 'vitest';
import type { OneToOneTurn } from '../../../src/agent/one-to-one-conversation';
import { talkQuotes } from '../../../src/agent/reorientation-talk-evidence';

/*
 * The evidence a Discuss talk's route puts on the card (16-D; the wave file's 5.3): the quotes go
 * through the charter's own guard against agent-quoted evidence (`withoutAgentQuotedEvidence`),
 * with the manager's turns as the only evidence, then the store's floor.
 */

function turn(id: string, speaker: OneToOneTurn['speaker'], text: string): OneToOneTurn {
  return { id, speaker, text, at: 1 };
}

/** The handover's case: Priya's escalation contact changed, and the manager says who now. */
const TALK: readonly OneToOneTurn[] = [
  turn(
    'e0',
    'employee',
    'Priya now approves committee-deck numbers. Should tier-2 drafts about them go to her first?',
  ),
  turn('m0', 'manager', 'Yes, send committee-deck drafts to Priya first, then to me.'),
  turn(
    'e1',
    'employee',
    'I will put tier-2 drafts about committee-deck numbers to Priya first on the card.',
  ),
];

describe('the evidence a talk puts on the card (talkQuotes)', (): void => {
  it('keeps the manager’s own words', (): void => {
    expect(talkQuotes(['send committee-deck drafts to Priya first, then to me'], TALK)).toEqual([
      'send committee-deck drafts to Priya first, then to me',
    ]);
  });

  it('never keeps an agent-quoted phrase, the answer that offered it included', (): void => {
    expect(
      talkQuotes(
        [
          'Should tier-2 drafts about them go to her first?',
          'tier-2 drafts about committee-deck numbers to Priya first',
        ],
        TALK,
      ),
    ).toEqual([]);
  });

  it('keeps nothing the manager did not say, and at most a few', (): void => {
    expect(talkQuotes(['Priya owns every tier-2 draft from now on.'], TALK)).toEqual([]);
    const words = TALK[1].text.split(' ');
    expect(
      talkQuotes(
        words.map((_, index) => words.slice(index).join(' ')),
        TALK,
      ),
    ).toHaveLength(5);
  });
});
