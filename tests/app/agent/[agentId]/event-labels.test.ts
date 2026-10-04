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
      'handover declined by priya@co.example',
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

  it('labels the access request and the organisation connection ledger (11-AO)', (): void => {
    expect(
      eventLabel({
        type: 'surface.access-requested',
        payload: { surfaceId: 's1', scopes: ['linear:read', 'linear:write'] },
      }),
    ).toBe('access requested from IT: linear:read, linear:write');
    const named = { organisationConnectionId: 'c1', system: 'slack', displayName: 'Slack' };
    expect(eventLabel({ type: 'organisation.connection-landed', payload: named })).toBe(
      'Slack connected for the organisation',
    );
    expect(eventLabel({ type: 'organisation.connection-rotated', payload: named })).toBe(
      "Slack: the organisation connection's secret rotated",
    );
    expect(
      eventLabel({
        type: 'organisation.connection-corrected',
        payload: { ...named, via: 'setup-cli', redirectCorrected: true, scopes: ['chat:write'] },
      }),
    ).toBe("Slack: the organisation connection's recorded redirect and scopes corrected");
    // The round review's m13: an MCP connection landed with no issuer has it recorded in place.
    expect(
      eventLabel({
        type: 'organisation.connection-corrected',
        payload: {
          organisationConnectionId: 'c2',
          system: 'mcp:auth.acme.test',
          displayName: 'auth.acme.test',
          via: 'setup-cli',
          issuerRecorded: true,
        },
      }),
    ).toBe("auth.acme.test: the organisation connection's recorded issuer corrected");
    expect(
      eventLabel({
        type: 'organisation.connection-revoked',
        payload: { ...named, reason: 'the workspace moved' },
      }),
    ).toBe('Slack: the organisation connection revoked (the workspace moved)');
    expect(
      eventLabel({
        type: 'organisation.revoked-at-source',
        payload: {
          credentialId: 'k1',
          system: 'slack',
          end: 'retire',
          outcome: 'app-deleted',
          attempt: 1,
        },
      }),
    ).toBe('Slack organisation connection: Slack app deleted in Slack');
  });

  it("labels Day0's uses of the Slack configuration token and the re-join after a renewal (11-AS)", (): void => {
    const used = { organisationConnectionId: 'c1', system: 'slack', displayName: 'Slack' };
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'tooling.tokens.rotate', outcome: 'done' },
      }),
    ).toBe('Slack configuration token renewed');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: {
          ...used,
          method: 'tooling.tokens.rotate',
          outcome: 'failed',
          reason: 'invalid_refresh_token',
        },
      }),
    ).toBe('Slack configuration token not renewed (invalid_refresh_token)');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'tooling.tokens.rotate', outcome: 'superseded' },
      }),
    ).toBe('Slack configuration token renewed twice at once: the other renewal kept');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'auth.revoke', outcome: 'done' },
      }),
    ).toBe('Slack configuration token revoked at Slack');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'auth.revoke', outcome: 'already-revoked' },
      }),
    ).toBe('Slack configuration token had already ended at Slack');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'auth.revoke', outcome: 'unrecognised' },
      }),
    ).toBe('Slack configuration token not recognised by Slack');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'auth.revoke', outcome: 'done', unchecked: true },
      }),
    ).toBe('Slack configuration token revoked at Slack, not confirmed afterwards');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'auth.revoke', outcome: 'already-revoked', unchecked: true },
      }),
    ).toBe('Slack configuration token had already ended at Slack, not confirmed afterwards');
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: { ...used, method: 'apps.manifest.create', outcome: 'done', appId: 'A123' },
      }),
    ).toBe("an employee's Slack app A123 created with the configuration token");
    expect(
      eventLabel({
        type: 'organisation.configuration-used',
        payload: {
          ...used,
          method: 'apps.manifest.create',
          outcome: 'failed',
          reason: 'invalid_auth',
        },
      }),
    ).toBe("an employee's Slack app not created (invalid_auth)");
    expect(
      eventLabel({
        type: 'surface.channels-rejoined',
        payload: { surfaceId: 's1', joined: ['#revops'], needsPerson: ['#revops-leads'] },
      }),
    ).toBe('re-joined #revops; #revops-leads needs a person to add it');
    expect(
      eventLabel({
        type: 'surface.channels-rejoined',
        payload: { surfaceId: 's1', joined: [], needsPerson: ['#revops', '#revops-leads'] },
      }),
    ).toBe('#revops, #revops-leads need a person to add it');
    expect(
      eventLabel({
        type: 'surface.channels-rejoined',
        payload: { surfaceId: 's1', joined: [], needsPerson: [] },
      }),
    ).toBe('no channel to re-join');
  });

  it("labels the shared token as revoked with the organisation's revoke of its connection, and its own ledger line as the organisation's token (R41V-1)", (): void => {
    const ended = { credentialId: 'k1', system: 'linear', outcome: 'shared' } as const;
    expect(
      eventLabel({
        type: 'credential.revoked-at-source',
        payload: { ...ended, surfaceId: 's1', end: 'organisation-revoked' },
      }),
    ).toBe("shared app token: revoked at Linear with the organisation's connection");
    expect(
      eventLabel({
        type: 'credential.revoked-at-source',
        payload: { ...ended, surfaceId: 's1', end: 'retire' },
      }),
    ).toBe('shared app token: not revoked at Linear');
    expect(
      eventLabel({
        type: 'organisation.revoked-at-source',
        payload: {
          credentialId: 'k2',
          system: 'linear',
          end: 'organisation-revoked',
          outcome: 'token-revoked',
          attempt: 1,
          shared: true,
        },
      }),
    ).toBe('Linear shared app token revoked at Linear');
  });

  it('labels each answer to a decision reply by what it said, a replaced request included (12-S3)', (): void => {
    const answered = (kind: string): string =>
      eventLabel({
        type: 'work.decision-acknowledging',
        payload: { workItemId: 'w1', decisionId: 'abc234', messageTs: '1.2', kind },
      });
    expect(answered('received')).toBe('a decision reply acknowledged');
    expect(answered('unknown')).toBe('a reply with no open request answered');
    expect(answered('replaced')).toBe(
      'a reply to a replaced request answered with the request that replaced it',
    );
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

  it('says a page swap bound the new value on the cards the old one held (N23; 12-S3)', (): void => {
    expect(
      eventLabel({
        type: 'credential.superseded',
        payload: {
          credentialId: 'c1',
          label: 'linear service token',
          sourceId: 'd1',
          page: 'runbooks/linear.md',
          surfaceIds: [],
          reboundSurfaceIds: ['s1'],
        },
      }),
    ).toBe(
      'credential "linear service token" replaced in the documentation (runbooks/linear.md); the new value bound on 1 card',
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

  it('labels an adoption offered and an adoption made with the version and its author (10-A)', (): void => {
    expect(
      eventLabel({
        type: 'skill.adoption-offered',
        payload: { name: 'kanban-comment-and-close', version: 2, authorName: 'Priya' },
      }),
    ).toBe('skill adoption offered: kanban-comment-and-close v2 by Priya');
    expect(
      eventLabel({
        type: 'skill.adopted',
        payload: { name: 'kanban-comment-and-close', version: 2, authorName: 'Priya' },
      }),
    ).toBe('skill adopted: kanban-comment-and-close v2 by Priya');
    expect(
      eventLabel({ type: 'skill.adopted', payload: { name: 'kanban-comment-and-close' } }),
    ).toBe('skill adopted: kanban-comment-and-close');
  });

  it('labels a revision written beside the running skill, and an older in-place one as it was (10-C)', (): void => {
    expect(
      eventLabel({
        type: 'skill.revision-requested',
        payload: { name: 'kanban-comment-and-close', revisionId: 's2' },
      }),
    ).toBe('skill revision asked for: kanban-comment-and-close');
    expect(
      eventLabel({
        type: 'skill.revision-requested',
        payload: { name: 'kanban-comment-and-close' },
      }),
    ).toBe('skill sent back to be written again: kanban-comment-and-close');
  });

  it('labels a retire, a withdrawal from every employee and a Give up (10-C)', (): void => {
    expect(
      eventLabel({
        type: 'skill.retired',
        payload: { name: 'kanban-comment-and-close', reason: 'it closes the wrong tickets' },
      }),
    ).toBe('skill retired: kanban-comment-and-close (it closes the wrong tickets)');
    expect(
      eventLabel({
        type: 'skill.retired',
        payload: { name: 'kanban-comment-and-close', reason: 'stale', withdrawn: true },
      }),
    ).toBe('skill retired, withdrawn from every employee: kanban-comment-and-close (stale)');
    expect(
      eventLabel({
        type: 'skill.revoked',
        payload: {
          name: 'kanban-comment-and-close',
          version: 2,
          reason: 'stale',
          holders: [
            { skillId: 's1', agentId: 'a1', agentName: 'Priya' },
            { skillId: 's2', agentId: 'a2', agentName: 'Mateo' },
          ],
        },
      }),
    ).toBe(
      'skill withdrawn from every employee: kanban-comment-and-close v2, Priya, Mateo (stale)',
    );
    expect(
      eventLabel({
        type: 'skill.given-up',
        payload: {
          name: 'analytics-refresh-value',
          reason: 'given up after 2 attempts',
          attempts: 2,
        },
      }),
    ).toBe('skill given up: analytics-refresh-value after 2 attempts');
    expect(
      eventLabel({
        type: 'skill.rejected',
        payload: { name: 'kanban-comment-and-close', offerWithdrawn: { version: 1 } },
      }),
    ).toBe('skill adoption ended, version withdrawn: kanban-comment-and-close');
    expect(
      eventLabel({
        type: 'skill.authoring-claimed',
        payload: { name: 'kanban-comment-and-close', purpose: 'verify-stored' },
      }),
    ).toBe('skill check started: kanban-comment-and-close');
    expect(
      eventLabel({
        type: 'skill.rechecked',
        payload: { name: 'kanban-comment-and-close', version: 2 },
      }),
    ).toBe('skill re-checked: kanban-comment-and-close v2');
    expect(
      eventLabel({
        type: 'skill.superseded',
        payload: { name: 'kanban-comment-and-close', version: 3 },
      }),
    ).toBe('skill superseded by its revision: kanban-comment-and-close v3');
    expect(
      eventLabel({
        type: 'work.waiting-for-skill',
        payload: { name: 'kanban-comment-and-close', reason: 'its skill was retired' },
      }),
    ).toBe('waiting for a skill again: kanban-comment-and-close (its skill was retired)');
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
    expect(recordKindOf({ type: 'skill.retired' })).toBe('withheld');
    expect(recordKindOf({ type: 'skill.revoked' })).toBe('withheld');
    expect(recordKindOf({ type: 'skill.given-up' })).toBe('withheld');
    expect(recordKindOf({ type: 'work.waiting-for-skill' })).toBe('held');
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

describe('the labels of an end of access at the vendor (11-AR)', (): void => {
  it('labels each outcome by the system, naming the channel memberships a revoked bot lost', (): void => {
    const label = (payload: Record<string, unknown>): string =>
      eventLabel({ type: 'credential.revoked-at-source', payload });
    expect(
      label({ system: 'slack', outcome: 'token-revoked', channelMembershipsRemoved: true }),
    ).toBe('revoked at Slack; its channel memberships were removed');
    expect(label({ system: 'slack', outcome: 'app-deleted' })).toBe('Slack app deleted in Slack');
    expect(label({ system: 'slack', outcome: 'app-uninstalled' })).toBe(
      'Slack app uninstalled from Slack',
    );
    expect(label({ system: 'linear', outcome: 'already-gone' })).toBe('already revoked at Linear');
    expect(
      label({ system: 'linear', outcome: 'retrying', reason: 'Linear answered HTTP 503.' }),
    ).toBe('revocation at Linear failed, trying again (Linear answered HTTP 503)');
    expect(label({ system: 'linear', outcome: 'failed', reason: 'Linear refused: x' })).toBe(
      "revocation at Linear failed (Linear refused: x); Day0's copy deleted",
    );
    expect(label({ system: 'zendesk', outcome: 'not-supported' })).toBe(
      "not revoked at zendesk: no revocation call; Day0's copy deleted",
    );
    expect(label({ system: 'linear', outcome: 'shared' })).toBe(
      'shared app token: not revoked at Linear',
    );
    expect(label({ system: 'slack', outcome: 'not-at-vendor' })).toBe('nothing changed at Slack');
    expect(label({ system: 'Zendesk', outcome: 'pasted-key' })).toBe(
      'pasted key: never sent to Zendesk; revoke it there',
    );
  });

  it('labels a disconnection by who made it', (): void => {
    expect(eventLabel({ type: 'surface.disconnected', payload: { by: 'manager' } })).toBe(
      'disconnected by the manager',
    );
    expect(
      eventLabel({
        type: 'surface.disconnected',
        payload: { by: 'organisation', reason: 'revoked by IT' },
      }),
    ).toBe("disconnected: the organisation's connection was revoked (revoked by IT)");
  });
});
