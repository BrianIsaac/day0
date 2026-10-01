import { describe, expect, it } from 'vitest';
import { EVENT_TYPES } from '../../../../../src/events/contract';
import { recordWords } from '../../../../../app/agent/[agentId]/record/record-words';

const subject = { name: 'Mira', item: 'Draft response for new tier-two RevOps ask' };

/** A row that carries every field the sentences read, so each branch that prints one is run. */
const FULL = {
  workItemId: 'w1',
  surfaceId: 's1',
  name: 'chat-thread-reply',
  reason: 'the owner changed.',
  cause: 'the model timed out',
  version: '0.2',
  previousVersion: '0.1',
  count: 2,
  systems: 3,
  created: 1,
  retired: 1,
  readmitted: 2,
  attempts: 3,
  attempt: 2,
  decidedVia: 'channel',
  via: 'dashboard',
  by: 'manager',
  source: 'manager',
  kind: 'actions',
  title: 'Refresh the view',
  scope: 'slack:write',
  scopes: ['slack:read', 'slack:write'],
  question: 'Which topic?',
  notes: 'Too broad.',
  topic: 'escalations',
  bossEmail: 'sam@revops.example',
  zone: 'Asia/Singapore',
  from: 'mcp',
  to: 'browser',
  trigger: 'charter',
  refused: 'no assignee',
  feedback: 'Use template B.',
  actor: 'sam@revops.example',
  stage: 'draft',
  outcome: 'timeout',
  statusCode: 504,
  days: 30,
  heldForMs: 90_000,
  retryInMs: 300_000,
  retryAfterMs: 60_000,
  slug: 'linear',
  appName: 'Day0',
  label: 'Linear token',
  page: 'Runbook',
  candidateSlugs: ['linear', 'jira'],
  namedSystem: 'the tracker',
  searched: ['docs', 'charter'],
  withheldTools: ['delete_issue'],
  added: ['save_comment'],
  removed: ['delete_issue'],
  heldIndexes: [1, 2],
  autoIndexes: [0],
  approvedIndexes: [1],
  removedIndices: [3],
  withheld: ['close'],
  members: [{}, {}],
  decided: ['a', 'b'],
  answered: [{ question: 'Which topic?' }],
  struckConstraints: ['x'],
  surfaceIds: ['s1'],
  correctionIds: ['c1'],
};

describe('recordWords', (): void => {
  it.each(EVENT_TYPES)(
    'says %s as one plain sentence, from a full row and from an older row that carries nothing',
    (type): void => {
      for (const payload of [{}, null, { workItemId: 'w1', name: 'chat-thread-reply' }, FULL]) {
        for (const about of [subject, { name: 'Mira' }, { name: 'Mira', connection: 'Linear' }]) {
          const words = recordWords({ type, payload }, about);
          expect(words).toMatch(/^[A-Z0-9“]/);
          expect(words).toMatch(/[.!?][\u201d)]?$/);
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
          payload: {
            decidedVia: 'channel',
            answered: [{ question: 'Which topic?', questionId: 'q1' }],
          },
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

  it('says each step of a handover request by who asked, the address it names and the employee', (): void => {
    const request = {
      transferId: 't1',
      fromAddress: 'sam@company.com',
      toAddress: 'priya@company.com',
    };
    const said = (type: (typeof EVENT_TYPES)[number], payload: Record<string, unknown>): string =>
      recordWords({ type, payload: { ...request, ...payload } }, { name: 'Maya' });
    expect(said('manager.transfer-asked', { hasNote: true })).toBe(
      "Maya's manager, sam@company.com, asked priya@company.com to take Maya on.",
    );
    expect(said('manager.transfer-cancelled', { reason: 'owner' })).toBe(
      "Maya's manager, sam@company.com, cancelled the handover to priya@company.com.",
    );
    expect(said('manager.transfer-cancelled', { reason: 'retired' })).toBe(
      "Maya's manager, sam@company.com, cancelled the handover to priya@company.com when Maya was retired.",
    );
    expect(said('manager.transfer-cancelled', { reason: 'address-changed' })).toBe(
      "Maya's manager, sam@company.com, cancelled the handover to priya@company.com to ask another address.",
    );
    expect(said('manager.transfer-declined', { hasReason: false })).toBe(
      'Asked to take Maya on, priya@company.com declined.',
    );
    expect(said('manager.transfer-expired', {})).toBe(
      'The handover to priya@company.com expired unanswered.',
    );
  });

  it('says the reason for a rejection once, not the stored prefix before it (m43)', (): void => {
    const rejected = (reason: string): string =>
      recordWords(
        { type: 'work.actions-rejected', payload: { reason, decidedVia: 'dashboard' } },
        { name: 'Mira' },
      );
    expect(rejected('rejected by the manager: Too long, five bullets at most.')).toBe(
      'You rejected the held actions from the dashboard: Too long, five bullets at most.',
    );
    expect(rejected('rejected by the manager')).toBe(
      'You rejected the held actions from the dashboard.',
    );
    expect(rejected('the plan changed')).toBe(
      'You rejected the held actions from the dashboard: the plan changed.',
    );
  });

  it('says a dismissal took the item out of the inbox and kept it on the Work tab (m16)', (): void => {
    expect(
      recordWords(
        { type: 'work.dismissed', payload: { workItemId: 'w1' } },
        { name: 'Mira', item: 'Refresh pipeline coverage view' },
      ),
    ).toBe(
      'You dismissed “Refresh pipeline coverage view” from your inbox. It stays on the Work tab, where Retry runs it again.',
    );
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

  it('names the connection an event is about, and a stand-in when it names none', (): void => {
    expect(
      recordWords(
        { type: 'surface.approved', payload: {} },
        { name: 'Mira', connection: 'Linear' },
      ),
    ).toBe('You approved the Linear connection.');
    expect(recordWords({ type: 'surface.connected', payload: {} }, { name: 'Mira' })).toBe(
      'A connection connected.',
    );
    expect(
      recordWords({ type: 'surface.expiring', payload: {} }, { name: 'Mira', connection: 'Slack' }),
    ).toBe('Access to the Slack connection ends within a week; renew it on its card.');
  });

  it('says each way the manager changed, the adoption of the owner’s own address included (D17)', (): void => {
    const changed = (payload: Record<string, unknown>): string =>
      recordWords({ type: 'manager.changed', payload }, { name: 'Mira' });
    expect(changed({ via: 'adopted', bossEmail: 'lead@kestrel.example' })).toBe(
      "You made yourself Mira's manager at lead@kestrel.example, so its DMs come to you now.",
    );
    expect(changed({ via: 'adopted' })).toBe(
      "You made yourself Mira's manager, so its DMs come to you now.",
    );
    expect(changed({ via: 'dashboard', bossEmail: 'ana@kestrel.example' })).toBe(
      "You changed Mira's manager to ana@kestrel.example.",
    );
    expect(changed({ via: 'probe', managerUserId: 'U2' })).toBe(
      'The chat surface showed Mira a different manager, so its DMs go to them now.',
    );
  });

  it('says an intake listing is a change the tracker shows, with intake’s refusal when there is one', (): void => {
    expect(recordWords({ type: 'work.listed', payload: { refused: 'no assignee' } }, subject)).toBe(
      'The tracker shows \u201cDraft response for new tier-two RevOps ask\u201d changed; intake did not take it: no assignee.',
    );
  });

  it('closes a sentence that ends on a quoted title with its own stop without a second', (): void => {
    expect(
      recordWords(
        { type: 'work.completed', payload: {} },
        { name: 'Mira', item: 'Why is ARR down?' },
      ),
    ).toBe('Mira finished \u201cWhy is ARR down?\u201d');
  });
});

describe('what an evaluation and a plan approval say in the record (walk m15)', (): void => {
  const subject = { name: 'Ada', item: 'Priya asks for tracker update' };

  it("says what the evaluator judged in the manager's words, never the verdict's name", (): void => {
    const evaluated = (decision: string): string =>
      recordWords({ type: 'work.evaluated', payload: { decision } }, subject);
    expect(evaluated('claim')).toBe('Ada judged “Priya asks for tracker update” part of the job.');
    expect(evaluated('needs-skill')).toBe(
      'Ada judged “Priya asks for tracker update” part of the job, needs a skill first.',
    );
    expect(evaluated('pending-reevaluation')).toBe(
      'Ada will judge “Priya asks for tracker update” again: the skill it waited on is ready.',
    );
    expect(evaluated('retired-verdict')).toBe(
      'Ada evaluated “Priya asks for tracker update”: retired verdict.',
    );
  });

  it("counts a charter question only where the answer names one, and calls the rest the planner's note", (): void => {
    const approved = (answered: Array<{ question: string; questionId?: string }>): string =>
      recordWords(
        { type: 'work.plan-approved', payload: { decidedVia: 'dashboard', answered } },
        subject,
      );
    expect(approved([{ question: 'Discrepancies are flagged.' }])).toBe(
      "You approved the plan for “Priya asks for tracker update” from the dashboard, answering the planner's note.",
    );
    expect(
      approved([
        { question: 'Which channel?', questionId: 'q1' },
        { question: 'Discrepancies are flagged.' },
      ]),
    ).toBe(
      "You approved the plan for “Priya asks for tracker update” from the dashboard, answering 1 charter question and the planner's note.",
    );
  });
});
