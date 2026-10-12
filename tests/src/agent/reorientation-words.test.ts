import { describe, expect, it } from 'vitest';
import {
  approvedResultWords,
  closingHeldReason,
  heldPlanWords,
  heldWords,
  isClosingHeld,
  pendingWords,
} from '../../../src/agent/reorientation-words';

describe('the reorientation card’s words (section 7, RM24)', (): void => {
  it('says a held closing phase as drafted, and tells it from any other stop', (): void => {
    const reason = closingHeldReason('Mira', '“Escalation paths” was superseded');
    expect(reason).toBe(
      'Mira stopped before its closing steps: the reorientation card about “Escalation paths” was superseded is still open. Decide it, then Retry.',
    );
    expect(isClosingHeld(`stopped: ${reason}`)).toBe(true);
    expect(isClosingHeld('stopped: the approved plan leaves step 2 to the manager')).toBe(false);
  });

  it('says what a card holds as the hold stops it: plans at approval, runs before closing (second pass M3)', (): void => {
    expect(heldWords({ plans: 0, runs: 0 })).toBe('nothing held');
    expect(heldWords({ plans: 1, runs: 0 })).toBe('1 plan held');
    expect(heldWords({ plans: 2, runs: 1 })).toBe('2 plans held, 1 run held before closing');
    expect(heldWords({ plans: 0, runs: 3 })).toBe('3 runs held before closing');
    expect(pendingWords('Mira', { plans: 0, runs: 0 })).toBe(
      'Mira is working out what to propose. Nothing is held while it does.',
    );
    expect(pendingWords('Mira', { plans: 1, runs: 0 })).toBe(
      'Mira is working out what to propose. The plan it holds waits until you decide the card.',
    );
    expect(pendingWords('Mira', { plans: 0, runs: 2 })).toBe(
      'Mira is working out what to propose. The 2 runs it holds stop before their closing steps until you decide the card.',
    );
    expect(pendingWords('Mira', { plans: 2, runs: 1 })).toBe(
      'Mira is working out what to propose. The 2 plans it holds wait, and the run it holds stops before its closing steps, until you decide the card.',
    );
  });

  it('says a held plan and what each Approve did', (): void => {
    expect(heldPlanWords('Priya, its approver, changed')).toBe(
      'Held until you decide the reorientation card: Priya, its approver, changed.',
    );
    expect(approvedResultWords.charter('0.2')).toBe('the charter was amended to version 0.2');
    expect(approvedResultWords.page('active', 'Runbook')).toBe('“Runbook” was marked current');
    expect(approvedResultWords.page('clear', 'Runbook')).toBe(
      '“Runbook” follows its source’s own status again',
    );
    expect(approvedResultWords.scope('grant', 'notion:read')).toBe(
      'access “notion:read” was granted',
    );
    expect(approvedResultWords.skill('withdraw', 'kanban')).toBe(
      'the skill “kanban” was withdrawn from every employee',
    );
  });
});
