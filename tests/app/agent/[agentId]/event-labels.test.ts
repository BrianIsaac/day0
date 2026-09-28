import { describe, expect, it } from 'vitest';
import { eventLabel } from '../../../../app/agent/[agentId]/event-labels';
import { EVENT_TYPES } from '../../../../src/events/contract';

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

  it('prints a type only an older release wrote as it was stored', (): void => {
    expect(eventLabel({ type: 'work.legacy-thing', payload: { x: 1 } })).toBe('work.legacy-thing');
  });
});
