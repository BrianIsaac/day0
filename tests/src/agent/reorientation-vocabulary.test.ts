import { describe, expect, it } from 'vitest';
import {
  AGREEMENT_PROPOSAL_ACTIONS,
  PAGE_STATUS_PROPOSALS,
  REORIENTATION_BLOCKING_LIMIT,
  REORIENTATION_PROPOSAL_KINDS,
  REORIENTATION_RISKS,
  REORIENTATION_STATUSES,
  REORIENTATION_TALK_STATES,
  REORIENTATION_TRIGGERS,
  RELATIONSHIP_PROPOSAL_ACTIONS,
  SCOPE_PROPOSAL_ACTIONS,
  SKILL_PROPOSAL_ACTIONS,
  UNDECIDED_REORIENTATION_STATUSES,
} from '../../../src/agent/reorientation-vocabulary';
import { PAGE_STATUSES } from '../../../src/docs/authority';

describe('the reorientation vocabulary (16-K)', (): void => {
  it('names one trigger kind per change of section 3, and none for a confirmed conflict, which asks a question instead', (): void => {
    expect(REORIENTATION_TRIGGERS).toEqual([
      'manager-changed',
      'access-revoked',
      'access-ended',
      'revocation-failed',
      'connection-revoked',
      'skill-withdrawn',
      'skill-recheck-due',
      'skill-recheck-failed',
      'relationship-changed',
      'person-dismissed',
      'agreement-corrected',
      'repeated-refusal',
      'repeated-skip',
      'repeated-rejection',
      'page-status-changed',
      'role-changed',
    ]);
    expect(new Set(REORIENTATION_TRIGGERS).size).toBe(REORIENTATION_TRIGGERS.length);
    expect(REORIENTATION_TRIGGERS.some((trigger) => trigger.includes('conflict'))).toBe(false);
  });

  it('opens a card with its proposal pending, and decides it applied, dismissed or deferred; only open and discussing are undecided', (): void => {
    expect(REORIENTATION_PROPOSAL_KINDS[0]).toBe('pending');
    expect(REORIENTATION_PROPOSAL_KINDS).toContain('none');
    expect(REORIENTATION_STATUSES).toEqual([
      'open',
      'discussing',
      'applied',
      'dismissed',
      'deferred',
    ]);
    expect(UNDECIDED_REORIENTATION_STATUSES).toEqual(['open', 'discussing']);
    expect(REORIENTATION_RISKS).toEqual(['low', 'medium', 'high']);
  });

  it('proposes only what a named target can apply: every status the manager may set a page to, or clear', (): void => {
    expect(PAGE_STATUS_PROPOSALS.filter((status) => status !== 'clear').sort()).toEqual(
      [...PAGE_STATUSES].sort(),
    );
    expect(AGREEMENT_PROPOSAL_ACTIONS).toEqual(['keep', 'edit', 'recheck', 'retire', 'dismiss']);
    expect(RELATIONSHIP_PROPOSAL_ACTIONS).toEqual(['edit', 'retire']);
    expect(SCOPE_PROPOSAL_ACTIONS).toEqual(['revoke', 'grant']);
    expect(SKILL_PROPOSAL_ACTIONS).toEqual(['recheck', 'retire', 'withdraw']);
  });

  it('keeps a Discuss conversation until it ends in a proposal or is closed, and holds at most ten items on one card', (): void => {
    expect(REORIENTATION_TALK_STATES).toEqual(['active', 'finished', 'closed']);
    expect(REORIENTATION_BLOCKING_LIMIT).toBe(10);
  });
});
