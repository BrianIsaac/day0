import { describe, expect, it } from 'vitest';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { AUTHORING_LEASE_MS } from '../../../src/lib/skill-authoring';
import {
  oneToOneWaitsOnManager,
  attemptsSpent,
  parkedRowNeedsManager,
  skillWaitsOnManager,
  stoppedRowNeedsManager,
  stoppedRowOffersMove,
} from '../../../src/work/needs-manager';

const NOW = 1_000_000_000;
const SKILL_ID = 'skill-1' as Id<'skills'>;
const RUN_ID = 'run-1' as Id<'events'>;

function skill(fields: Partial<Doc<'skills'>>): Doc<'skills'> {
  return { _id: SKILL_ID, state: 'proposed', ...fields } as Doc<'skills'>;
}

function row(fields: Partial<Doc<'workItems'>>): Doc<'workItems'> {
  return { state: 'failed', ...fields } as Doc<'workItems'>;
}

describe('needs-manager rules', (): void => {
  it('hands a proposed skill to the manager and takes it back while a run authors it', (): void => {
    expect(skillWaitsOnManager(skill({ state: 'proposed' }), NOW)).toBe(true);
    expect(
      skillWaitsOnManager(
        skill({ state: 'authoring', authoringRunId: RUN_ID, authoringClaimedAt: NOW - 1_000 }),
        NOW,
      ),
    ).toBe(false);
    expect(
      skillWaitsOnManager(
        skill({
          state: 'authoring',
          authoringRunId: RUN_ID,
          authoringClaimedAt: NOW - AUTHORING_LEASE_MS - 1,
        }),
        NOW,
      ),
    ).toBe(true);
    expect(skillWaitsOnManager(skill({ state: 'registered' }), NOW)).toBe(false);
  });

  it('withdraws Retry at the third failed attempt, and only from a failed skill', (): void => {
    expect(attemptsSpent(skill({ state: 'failed', authoringAttempts: 2 }))).toBe(false);
    expect(attemptsSpent(skill({ state: 'failed', authoringAttempts: 3 }))).toBe(true);
    expect(attemptsSpent(skill({ state: 'failed', authoringAttempts: 4 }))).toBe(true);
    expect(attemptsSpent(skill({ state: 'failed' }))).toBe(false);
    expect(attemptsSpent(skill({ state: 'authoring', authoringAttempts: 3 }))).toBe(false);
  });

  it('keeps a skill at its third failed attempt on the manager, for Give up', (): void => {
    const spent = skill({ state: 'failed', authoringAttempts: 3 });
    expect(skillWaitsOnManager(spent, NOW)).toBe(true);
    expect(
      parkedRowNeedsManager(
        row({ state: 'needs-skill', proposedSkillId: SKILL_ID }),
        new Map([[SKILL_ID, spent]]),
        NOW,
      ),
    ).toBe(true);
  });

  it('leaves a row parked behind a skill taken out of use with nobody until it is proposed again', (): void => {
    for (const state of ['retired', 'superseded', 'rejected'] as const) {
      expect(skillWaitsOnManager(skill({ state }), NOW)).toBe(false);
    }
  });

  it('counts every deferral and a skill wait only while the skill is the manager’s', (): void => {
    const skills = new Map([[SKILL_ID, skill({ state: 'proposed' })]]);
    expect(parkedRowNeedsManager(row({ state: 'deferred' }), skills, NOW)).toBe(true);
    expect(
      parkedRowNeedsManager(row({ state: 'needs-skill', proposedSkillId: SKILL_ID }), skills, NOW),
    ).toBe(true);
    expect(parkedRowNeedsManager(row({ state: 'needs-skill' }), skills, NOW)).toBe(false);
    expect(
      parkedRowNeedsManager(
        row({ state: 'needs-skill', proposedSkillId: SKILL_ID }),
        new Map([[SKILL_ID, null]]),
        NOW,
      ),
    ).toBe(false);
  });

  it('leaves a row the manager’s own rejection failed with nobody', (): void => {
    expect(stoppedRowNeedsManager(row({ skipReason: 'rejected by the manager: no' }))).toBe(false);
    expect(stoppedRowNeedsManager(row({ skipReason: 'the run stopped' }))).toBe(true);
  });

  it('leaves a stopped row the manager dismissed with nobody (N7)', (): void => {
    expect(stoppedRowNeedsManager(row({ skipReason: 'the run stopped', dismissedAt: 5 }))).toBe(
      false,
    );
  });

  it('offers Retry on a stopped row whose ledger names nothing to reconcile', (): void => {
    expect(stoppedRowOffersMove(row({ skipReason: 'the run stopped' }))).toBe(true);
  });
});

describe('oneToOneWaitsOnManager (D4 (b))', (): void => {
  it('waits on the manager only while the employee is deployed and its one-to-one not begun', (): void => {
    expect(oneToOneWaitsOnManager({ state: 'deployed' })).toBe(true);
    expect(oneToOneWaitsOnManager({ state: 'day-one-in-progress' })).toBe(false);
    expect(oneToOneWaitsOnManager({ state: 'charter-pending' })).toBe(false);
    expect(oneToOneWaitsOnManager({ state: 'active' })).toBe(false);
  });
});
