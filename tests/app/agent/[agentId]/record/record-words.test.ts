import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../../../../src/events/contract';
import { recordWords } from '../../../../../app/agent/[agentId]/record/record-words';

const subject = { name: 'Mira', item: 'Draft response for new tier-two RevOps ask' };

describe('recordWords', (): void => {
  it.each(EVENT_TYPES)(
    'says %s as one plain sentence, from a full row and from an older row that carries nothing',
    (type): void => {
      for (const payload of [{}, null, { workItemId: 'w1', name: 'chat-thread-reply' }]) {
        for (const about of [subject, { name: 'Mira' }]) {
          const words = recordWords({ type, payload }, about);
          expect(words).toMatch(/^[A-Z0-9“]/);
          expect(words).toMatch(/[.!?]$/);
          expect(words).not.toMatch(/\.\.$/);
          expect(words).not.toContain(type);
          expect(words).not.toMatch(/undefined|\[object|NaN/);
          // N29: the manager hires employees; no manager-facing line says agent.
          expect(words).not.toMatch(/\bagents?\b/i);
          expect(words).not.toContain('—');
        }
      }
    },
  );

  it('names the employee, addresses the manager and quotes the item', (): void => {
    expect(
      recordWords(
        { type: 'work.actions-pending', payload: { heldIndexes: [2], workItemId: 'w1' } },
        subject,
      ),
    ).toBe(
      'Mira held 1 action on “Draft response for new tier-two RevOps ask” for you. Nothing has reached a surface.',
    );
    expect(
      recordWords(
        {
          type: 'work.plan-approved',
          payload: { decidedVia: 'channel', answered: [{ question: 'Which topic?' }] },
        },
        subject,
      ),
    ).toBe(
      'You approved the plan for “Draft response for new tier-two RevOps ask” from your DMs, answering 1 charter question.',
    );
    expect(
      recordWords(
        { type: 'charter.approved', payload: { version: '0.1', struckConstraints: ['x'] } },
        { name: 'Mira' },
      ),
    ).toBe('You approved charter version 0.1, 1 rule struck.');
    expect(
      recordWords(
        { type: 'work.skipped', payload: { reason: 'forecasting work assigned to Aman.' } },
        { name: 'Mira', item: 'Refresh pipeline coverage view' },
      ),
    ).toBe('Mira skipped “Refresh pipeline coverage view”: forecasting work assigned to Aman.');
  });

  it('says a plan approved under autonomous actions was not the manager pressing Approve', (): void => {
    expect(
      recordWords({ type: 'work.plan-approved', payload: { by: 'autonomous' } }, { name: 'Mira' }),
    ).toBe('The plan was approved under autonomous actions.');
  });

  it('says a type only an older release wrote under the name it was stored as', (): void => {
    expect(recordWords({ type: 'work.teleported', payload: {} }, subject)).toBe(
      'An event this release does not describe: work.teleported.',
    );
  });
});
