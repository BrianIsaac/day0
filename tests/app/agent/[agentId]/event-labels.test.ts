import { describe, expect, it } from 'vitest';
import {
  eventItemTitle,
  eventLabel,
  recordKindOf,
} from '../../../../app/agent/[agentId]/event-labels';
import { EVENT_TYPES } from '../../../../src/events/contract';
import { eventTypesIn } from '../../../../src/events/record-filters';

describe('the live feed labels', (): void => {
  it('gives every event type the contract lists words of its own, even for a row with no payload', (): void => {
    for (const type of EVENT_TYPES) {
      for (const payload of [undefined, null, {}]) {
        const label = eventLabel({ type, payload });
        expect(label, type).not.toBe(type);
        expect(label, type).not.toMatch(/undefined|null|\[object Object\]|NaN/);
        expect(label.trim(), type).toBe(label);
      }
    }
  });

  it('labels each step of a handover request by the address it names', (): void => {
    const request = {
      transferId: 't1',
      fromAddress: 'sam@co.example',
      toAddress: 'priya@co.example',
    };
    expect([
      eventLabel({ type: 'manager.transfer-asked', payload: { ...request, hasNote: false } }),
      eventLabel({ type: 'manager.transfer-cancelled', payload: { ...request, reason: 'owner' } }),
      eventLabel({
        type: 'manager.transfer-cancelled',
        payload: { ...request, reason: 'retired' },
      }),
      eventLabel({
        type: 'manager.transfer-cancelled',
        payload: { ...request, reason: 'address-changed' },
      }),
      eventLabel({ type: 'manager.transfer-declined', payload: { ...request, hasReason: true } }),
      eventLabel({ type: 'manager.transfer-expired', payload: request }),
      eventLabel({
        type: 'manager.transfer-settle-failed',
        payload: { ...request, attempt: 1, reason: 'x' },
      }),
      eventLabel({
        type: 'manager.transfer-ended',
        payload: { ...request, reason: 'settle-failed', detail: 'x' },
      }),
      eventLabel({
        type: 'manager.transfer-ended',
        payload: { ...request, reason: 'operator', detail: 'x' },
      }),
      eventLabel({ type: 'manager.transfer-note-withheld', payload: request }),
      eventLabel({ type: 'manager.transfer-notice', payload: { ...request, delivered: true } }),
      eventLabel({
        type: 'manager.transfer-notice',
        payload: { ...request, delivered: false, reason: 'nobody' },
      }),
    ]).toEqual([
      'handover to priya@co.example asked',
      'handover to priya@co.example cancelled',
      'handover to priya@co.example cancelled at the retire',
      'handover to priya@co.example cancelled for another address',
      'priya@co.example declined the handover',
      'handover to priya@co.example expired',
      'handover to priya@co.example not finished yet',
      'handover to priya@co.example ended, it could not finish',
      'handover to priya@co.example ended by the operator',
      'handover note to priya@co.example withheld',
      'handover notice to priya@co.example sent',
      'handover notice to priya@co.example not sent',
    ]);
  });

  it('says why each held plan waits, by its reason', (): void => {
    const held = (payload: Record<string, unknown>): string =>
      eventLabel({ type: 'work.plan-held', payload: { workItemId: 'w1', ...payload } });
    expect(held({ reason: 'skip-overruled', waived: 'quality-fit' })).toBe(
      'plan held for you: you waived the skip',
    );
    expect(held({ reason: 'plan-rejected-for-this-item' })).toBe(
      "plan held for you: a colleague's plan for this ticket was rejected",
    );
    expect(held({ reason: 'obligations-failed-open', failure: 'model unavailable' })).toBe(
      'plan held for you: its reads and writes could not be checked',
    );
    expect(
      held({ reason: 'drafted-without-record', surfaceSlug: 'linear', cause: 'not-connected' }),
    ).toBe('plan held for you: it was drafted without reading its ticket or thread');
    expect(held({ reason: 'approved-by-predecessor' })).toBe(
      'plan held for you: approved by your predecessor; approve it again',
    );
    expect(held({ reason: 'a reason from a later build' })).toBe(
      'plan held for you: it waits for your decision',
    );
  });

  it('labels the eleven wave 3 types the review found printed raw (m37)', (): void => {
    const labels = [
      eventLabel({
        type: 'work.plan-held',
        payload: { workItemId: 'w1', reason: 'skip-overruled', waived: 'scope' },
      }),
      eventLabel({ type: 'work.waiting-for-charter', payload: { workItemId: 'w1' } }),
      eventLabel({
        type: 'work.decision-request-asked',
        payload: { workItemId: 'w1', kind: 'plan' },
      }),
      eventLabel({
        type: 'work.decision-request-resent',
        payload: { workItemId: 'w1', decisionId: 'd1', kind: 'actions', reason: 'manager changed' },
      }),
      eventLabel({
        type: 'manager.changed',
        payload: { via: 'dashboard', bossEmail: 'ana@kestrel.example' },
      }),
      eventLabel({ type: 'surface.reopened', payload: { surfaceId: 's1', reason: 'renewed' } }),
      eventLabel({
        type: 'surface.configuration-token-revoked',
        payload: { surfaceId: 's1', atProvider: true },
      }),
      eventLabel({ type: 'surface.app-unrecorded', payload: { surfaceId: 's1', appId: 'A1' } }),
      eventLabel({ type: 'agent.zone-changed', payload: { from: 'UTC', to: 'Asia/Singapore' } }),
      eventLabel({
        type: 'charter.question-answered',
        payload: { questionId: 'q1', via: 'plan-approval', amended: true },
      }),
      eventLabel({ type: 'work.skipped', payload: { workItemId: 'w1', reason: 'out of scope' } }),
    ];
    expect(labels).toEqual([
      'plan held for you: you waived the skip',
      'waiting for you to approve the charter',
      'plan request asked on the chat surface',
      'held actions request sent again (manager changed)',
      'manager changed to ana@kestrel.example on the dashboard',
      'connection reopened (renewed)',
      'app configuration token revoked at the provider',
      'a registered app was not recorded: remove it at the provider',
      "the employee's day moved from UTC to Asia/Singapore",
      'charter question answered with a plan approval, charter amended',
      'skipped (out of scope)',
    ]);
  });

  it('labels the adoption of the owner’s own address apart from a change on the dashboard (D17)', (): void => {
    expect(
      eventLabel({
        type: 'manager.changed',
        payload: { via: 'adopted', bossEmail: 'lead@kestrel.example' },
      }),
    ).toBe('the owner made themselves the manager (lead@kestrel.example)');
    expect(eventLabel({ type: 'manager.changed', payload: { via: 'adopted' } })).toBe(
      'the owner made themselves the manager',
    );
  });

  it('labels a handover with both managers and the connections it cut', (): void => {
    expect(
      eventLabel({
        type: 'manager.transferred',
        payload: {
          fromAddress: 'sam@revops.example',
          toAddress: 'ana@kestrel.example',
          surfacesCut: ['linear'],
        },
      }),
    ).toBe('handed over from sam@revops.example to ana@kestrel.example, 1 connection cut');
  });

  it('labels the two types the schema step added, and the access clock', (): void => {
    expect(
      eventLabel({
        type: 'work.evaluation-parked',
        payload: { workItemId: 'w1', attempts: 3, reason: 'evaluation-attempts-spent' },
      }),
    ).toBe('parked: its evaluation stopped 3 times · waits for your Retry');
    expect(
      eventLabel({
        type: 'work.evaluation-parked',
        payload: { workItemId: 'w1', attempts: 3, reason: 'scope-judgement-unavailable' },
      }),
    ).toBe(
      'parked: the scope check could not reach the model in 3 attempts · Check for new work asks again',
    );
    expect(
      eventLabel({
        type: 'surface.tools-approved',
        payload: {
          surfaceId: 's1',
          tools: ['list_issues', 'save_comment'],
          added: ['save_comment'],
          removed: ['delete_issue'],
        },
      }),
    ).toBe('approved tools changed: added save_comment; removed delete_issue');
    expect(
      eventLabel({ type: 'surface.expiring', payload: { surfaceId: 's1', expiresAt: 1 } }),
    ).toBe('access ends within a week: renew it on the card');
    expect(eventLabel({ type: 'surface.expired', payload: { surfaceId: 's1' } })).toBe(
      'access ended: the card needs renewing',
    );
    expect(
      eventLabel({
        type: 'surface.access-set',
        payload: { surfaceId: 's1', by: 'manager', days: 30, expiresAt: 1, renewed: true },
      }),
    ).toBe('access renewed by the manager: 30 days');
    expect(
      eventLabel({
        type: 'surface.access-set',
        payload: { surfaceId: 's1', by: 'upgrade', days: 90, expiresAt: 1 },
      }),
    ).toBe('access set by the upgrade: 90 days');
  });

  it('says which credential the documentation dropped and how many cards need one again', (): void => {
    expect(
      eventLabel({
        type: 'credential.superseded',
        payload: {
          credentialId: 'c1',
          label: 'linear service token',
          sourceId: 'd1',
          page: 'runbooks/linear.md',
          surfaceIds: ['s1', 's2'],
        },
      }),
    ).toBe(
      'credential "linear service token" no longer in the documentation (runbooks/linear.md); land one again on 2 cards',
    );
  });

  it('says whether a failed run stopped, and names the slugs of an ambiguous charter match', (): void => {
    expect(
      eventLabel({
        type: 'work.failed',
        payload: { workItemId: 'w1', stopped: true, reason: 'stopped: x' },
      }),
    ).toBe('run stopped');
    expect(eventLabel({ type: 'work.failed', payload: { workItemId: 'w1', reason: 'x' } })).toBe(
      'run failed (x)',
    );
    expect(
      eventLabel({
        type: 'surface.charter-match-ambiguous',
        payload: {
          namedSystem: 'Looker',
          class: 'analytics',
          candidateSlugs: ['looker-finance-tile', 'looker-sales-tile'],
        },
      }),
    ).toBe(
      "the charter's Looker matches more than one surface: looker-finance-tile, looker-sales-tile",
    );
  });

  it('labels the model-call and restart events in words (P7-18)', (): void => {
    expect(
      eventLabel({
        type: 'work.model-call',
        payload: { stage: 'draft', outcome: 'failed', attempts: 5, statusCode: 503 },
      }),
    ).toBe('model call · plan draft · failed after 5 attempts (HTTP 503)');
    expect(
      eventLabel({
        type: 'work.model-call',
        payload: { stage: 'evaluation', outcome: 'ok', attempts: 1 },
      }),
    ).toBe('model call · evaluation · ok');
    expect(
      eventLabel({ type: 'work.scope-judgement-unavailable', payload: { cause: 'timeout' } }),
    ).toBe('scope judgement unavailable (timeout) · the item waits and is judged again');
    expect(eventLabel({ type: 'work.draft-resumed', payload: { attempt: 2 } })).toBe(
      'plan draft restarted after it died (restart 2)',
    );
    expect(
      eventLabel({
        type: 'work.execution-resumed',
        payload: { attempt: 1, reason: 'model endpoint timed out' },
      }),
    ).toBe(
      'execution restarted after it failed outside the item (restart 1): model endpoint timed out',
    );
  });

  it('labels the version a skill registered as, and a re-check due with its reason (10-K)', (): void => {
    expect(
      eventLabel({
        type: 'skill.registered',
        payload: { name: 'kanban-comment-and-close', version: 2 },
      }),
    ).toBe('skill registered: kanban-comment-and-close v2');
    expect(
      eventLabel({
        type: 'skill.recheck-due',
        payload: { name: 'kanban-comment-and-close', reason: 'v3 is verified; this runs v2' },
      }),
    ).toBe('skill re-check due: kanban-comment-and-close (v3 is verified; this runs v2)');
  });

  it('labels a dismissal as the manager setting a stopped item aside (m16)', (): void => {
    expect(eventLabel({ type: 'work.dismissed', payload: { workItemId: 'w1' } })).toBe(
      'dismissed by the manager',
    );
  });

  it("says what an evaluation decided in the manager's words, not the verdict's name (walk m15)", (): void => {
    const evaluated = (decision: unknown): string =>
      eventLabel({ type: 'work.evaluated', payload: { workItemId: 'w1', decision } });
    expect(evaluated('claim')).toBe('judged part of the job');
    expect(evaluated('needs-skill')).toBe('judged part of the job, needs a skill first');
    expect(evaluated('skip')).toBe('judged not part of the job');
    expect(evaluated('queue')).toBe('judged part of the job, queued behind its open work');
    expect(evaluated('defer')).toBe(
      'judged part of the job, waiting on a connection or a permission',
    );
    expect(evaluated('pending-reevaluation')).toBe('to be judged again: its skill is ready');
    // A verdict no release makes any more is printed as stored; a row with none says evaluated.
    expect(evaluated('retired-verdict')).toBe('evaluated: retired-verdict');
    expect(evaluated(undefined)).toBe('evaluated');
    expect(evaluated('constructor')).toBe('evaluated: constructor');
  });

  it('prints a type only an older release wrote as it was stored', (): void => {
    expect(eventLabel({ type: 'work.legacy-thing', payload: { x: 1 } })).toBe('work.legacy-thing');
  });
});

describe('the live feed names the item an event is about', (): void => {
  it("reads the item's title from the queue, and nothing for an event about no listed item", (): void => {
    const titles = new Map([['w1', 'Close REVOPS-5']]);
    expect(eventItemTitle({ payload: { workItemId: 'w1' } }, titles)).toBe('Close REVOPS-5');
    expect(eventItemTitle({ payload: { workItemId: 'w9' } }, titles)).toBeUndefined();
    expect(eventItemTitle({ payload: { surfaceId: 's1' } }, titles)).toBeUndefined();
    expect(eventItemTitle({ payload: null }, titles)).toBeUndefined();
  });
});

describe('what a record line says an event did', (): void => {
  it('marks what landed, what was refused, what was set aside and what waits on the manager', (): void => {
    expect(recordKindOf({ type: 'work.completed' })).toBe('landed');
    expect(recordKindOf({ type: 'charter.approved' })).toBe('landed');
    expect(recordKindOf({ type: 'work.actions-rejected' })).toBe('refused');
    expect(recordKindOf({ type: 'skill.verification-failed' })).toBe('refused');
    expect(recordKindOf({ type: 'work.skipped' })).toBe('withheld');
    expect(recordKindOf({ type: 'work.actions-pending' })).toBe('held');
    expect(recordKindOf({ type: 'skill.proposed' })).toBe('held');
  });

  it('draws every line the Refused and withheld chip lists as refused or set aside, never noted (m34)', (): void => {
    for (const type of eventTypesIn('refused')) {
      expect(['refused', 'withheld'], type).toContain(recordKindOf({ type }));
    }
  });

  it('draws a declined handover as refused, a cancelled or expired one as set aside, and an ask as noted', (): void => {
    expect(recordKindOf({ type: 'manager.transfer-declined' })).toBe('refused');
    expect(recordKindOf({ type: 'manager.transfer-cancelled' })).toBe('withheld');
    expect(recordKindOf({ type: 'manager.transfer-expired' })).toBe('withheld');
    expect(recordKindOf({ type: 'manager.transfer-ended' })).toBe('withheld');
    expect(recordKindOf({ type: 'manager.transfer-asked' })).toBe('noted');
  });

  it('notes a failed run and a past draft rather than calling them refused or still held', (): void => {
    expect(recordKindOf({ type: 'work.failed' })).toBe('noted');
    expect(recordKindOf({ type: 'work.plan-drafted' })).toBe('noted');
    expect(recordKindOf({ type: 'charter.drafted' })).toBe('noted');
  });

  it('notes every other event the contract lists, and one it does not know', (): void => {
    expect(recordKindOf({ type: 'agent.deployed' })).toBe('noted');
    expect(recordKindOf({ type: 'work.model-call' })).toBe('noted');
    expect(recordKindOf({ type: 'not.a-type' })).toBe('noted');
    for (const type of EVENT_TYPES) {
      expect(['landed', 'refused', 'withheld', 'held', 'noted']).toContain(recordKindOf({ type }));
    }
  });
});
