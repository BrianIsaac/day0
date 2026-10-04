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
    expect(said('manager.transfer-settle-failed', { attempt: 2, reason: 'too many' })).toBe(
      'Maya could not be moved to priya@company.com yet (attempt 2); Day0 tries again each minute.',
    );
    expect(
      said('manager.transfer-ended', {
        reason: 'settle-failed',
        detail: 'This employee has more than 1000 connections, more than one handover can move.',
      }),
    ).toBe(
      'The handover to priya@company.com could not finish and was ended: This employee has more than 1000 connections, more than one handover can move; Maya stays with sam@company.com.',
    );
    expect(said('manager.transfer-ended', { reason: 'operator', detail: 'stuck' })).toBe(
      'The handover to priya@company.com was ended by the operator: stuck; Maya stays with sam@company.com.',
    );
    expect(said('manager.transfer-note-withheld', {})).toBe(
      'Your note to priya@company.com was withheld: Day0 could not check it for stored credentials.',
    );
    expect(said('manager.transfer-notice', { delivered: true })).toBe(
      'Maya told priya@company.com in Slack that they were asked to take Maya on.',
    );
    expect(
      said('manager.transfer-notice', {
        delivered: false,
        reason: 'the named address is a guest in the workspace',
      }),
    ).toBe(
      'Maya did not tell priya@company.com in Slack about the handover: the named address is a guest in the workspace.',
    );
  });

  it('says where a handed-over employee went, and what waits for its new manager to connect', (): void => {
    expect(
      recordWords(
        {
          type: 'manager.transferred',
          payload: {
            fromAddress: 'sam@revops.example',
            toAddress: 'ana@kestrel.example',
            surfacesCut: ['linear', 'slack'],
          },
        },
        { name: 'Mira' },
      ),
    ).toBe(
      'Mira moved from sam@revops.example to ana@kestrel.example; 2 connections were cut and wait to be approved and connected again.',
    );
    expect(
      recordWords(
        {
          type: 'manager.transferred',
          payload: { toAddress: 'ana@kestrel.example', surfacesCut: [] },
        },
        { name: 'Mira' },
      ),
    ).toBe('Mira moved to ana@kestrel.example.');
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

  it('says the library version a skill registered as, and why a skill is due a re-check (10-K)', (): void => {
    expect(
      recordWords(
        { type: 'skill.registered', payload: { name: 'kanban-comment-and-close', version: 2 } },
        subject,
      ),
    ).toBe('The skill kanban-comment-and-close passed its check and can be called as version 2.');
    expect(
      recordWords(
        { type: 'skill.registered', payload: { name: 'kanban-comment-and-close' } },
        subject,
      ),
    ).toBe('The skill kanban-comment-and-close passed its check and can be called.');
    expect(
      recordWords(
        {
          type: 'skill.recheck-due',
          payload: { name: 'kanban-comment-and-close', reason: 'its check was not kept' },
        },
        subject,
      ),
    ).toBe('The skill kanban-comment-and-close is due a re-check: its check was not kept.');
  });

  it('says whose skill was offered for adoption, and that adopting it checks it again first (10-A)', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.adoption-offered',
          payload: { name: 'kanban-comment-and-close', version: 2, authorName: 'Priya' },
        },
        subject,
      ),
    ).toBe(
      'Mira was offered version 2 of the skill kanban-comment-and-close, written by Priya, to adopt.',
    );
    expect(
      recordWords(
        {
          type: 'skill.adopted',
          payload: { name: 'kanban-comment-and-close', version: 2, authorName: 'Priya' },
        },
        subject,
      ),
    ).toBe(
      'You adopted version 2 of the skill kanban-comment-and-close, written by Priya, for Mira; the sandbox checks it again for Mira before it runs.',
    );
  });

  it('says a revision is written beside the running skill, and an older in-place one as it was (10-C)', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.revision-requested',
          payload: { name: 'kanban-comment-and-close', revisionId: 's2' },
        },
        subject,
      ),
    ).toBe(
      'You asked for a revision of the skill kanban-comment-and-close; it keeps running until the revision registers.',
    );
    expect(
      recordWords(
        { type: 'skill.revision-requested', payload: { name: 'kanban-comment-and-close' } },
        subject,
      ),
    ).toBe('You sent the skill kanban-comment-and-close back to be written again.');
  });

  it('says a retire, a withdrawal from every employee and a Give up in the manager’s words (10-C)', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.retired',
          payload: { name: 'kanban-comment-and-close', reason: 'it closes the wrong tickets' },
        },
        subject,
      ),
    ).toBe('The skill kanban-comment-and-close was retired: it closes the wrong tickets.');
    expect(
      recordWords(
        {
          type: 'skill.retired',
          payload: {
            name: 'kanban-comment-and-close',
            reason: 'it closes the wrong tickets',
            withdrawn: true,
          },
        },
        subject,
      ),
    ).toBe(
      'The skill kanban-comment-and-close was retired when you withdrew it from every employee: it closes the wrong tickets.',
    );
    expect(
      recordWords(
        {
          type: 'skill.revoked',
          payload: {
            name: 'kanban-comment-and-close',
            version: 2,
            reason: 'it closes the wrong tickets',
            holders: [
              { skillId: 's1', agentId: 'a1', agentName: 'Priya' },
              { skillId: 's2', agentId: 'a2', agentName: 'Mateo' },
            ],
          },
        },
        subject,
      ),
    ).toBe(
      'You withdrew version 2 of the skill kanban-comment-and-close from every employee who held it (Priya, Mateo): it closes the wrong tickets.',
    );
    expect(
      recordWords(
        {
          type: 'skill.given-up',
          payload: {
            name: 'analytics-refresh-value',
            reason: 'given up after 3 attempts',
            attempts: 3,
          },
        },
        subject,
      ),
    ).toBe('You gave up on the skill analytics-refresh-value after 3 attempts.');
    expect(
      recordWords(
        {
          type: 'skill.rejected',
          payload: { name: 'kanban-comment-and-close', offerWithdrawn: { version: 1 } },
        },
        subject,
      ),
    ).toBe(
      'The adoption of the skill kanban-comment-and-close ended: version 1 was withdrawn from every employee.',
    );
    expect(
      recordWords(
        { type: 'skill.rechecked', payload: { name: 'kanban-comment-and-close', version: 2 } },
        subject,
      ),
    ).toBe(
      'The skill kanban-comment-and-close passed its re-check as version 2 and keeps running.',
    );
    expect(
      recordWords(
        { type: 'skill.superseded', payload: { name: 'kanban-comment-and-close', version: 3 } },
        subject,
      ),
    ).toBe('The skill kanban-comment-and-close was replaced by its revision, version 3.');
    expect(
      recordWords(
        {
          type: 'work.waiting-for-skill',
          payload: {
            workItemId: 'w1',
            name: 'kanban-comment-and-close',
            reason:
              'the skill kanban-comment-and-close was retired, so this waits for a skill again',
            previousState: 'plan-approved',
          },
        },
        { name: 'Mira', item: 'Close REVOPS-1' },
      ),
    ).toBe(
      '“Close REVOPS-1” went back to waiting for the skill kanban-comment-and-close: the skill kanban-comment-and-close was retired, so this waits for a skill again.',
    );
  });

  it('says each answer to a decision reply by what it said, a replaced request included (12-S3)', (): void => {
    const answered = (kind: string): string =>
      recordWords(
        {
          type: 'work.decision-acknowledging',
          payload: { workItemId: 'w1', decisionId: 'abc234', messageTs: '1.2', kind },
        },
        { name: 'Mira', item: 'Refresh pipeline coverage view' },
      );
    expect(answered('received')).toBe(
      'Mira acknowledged your reply for “Refresh pipeline coverage view”.',
    );
    expect(answered('unknown')).toBe('A reply with no open request was answered.');
    expect(answered('replaced')).toBe(
      'Mira answered your reply to a replaced request for “Refresh pipeline coverage view” with the request that replaced it.',
    );
  });

  it('says which credential left the documentation, and a page swap that bound the new value (N23; 12-S3)', (): void => {
    const payload = {
      credentialId: 'c1',
      label: 'linear service token',
      sourceId: 'd1',
      page: 'runbooks/linear.md',
    };
    expect(
      recordWords(
        { type: 'credential.superseded', payload: { ...payload, surfaceIds: ['s1', 's2'] } },
        { name: 'Mira' },
      ),
    ).toBe(
      'The credential \u201clinear service token\u201d is no longer in the documentation (runbooks/linear.md); land one again on 2 cards.',
    );
    expect(
      recordWords(
        {
          type: 'credential.superseded',
          payload: { ...payload, surfaceIds: [], reboundSurfaceIds: ['s1'] },
        },
        { name: 'Mira' },
      ),
    ).toBe(
      'The documentation replaced the credential \u201clinear service token\u201d (runbooks/linear.md); Day0 bound its new value on 1 card.',
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

  it('says a plan handed over before it started waits for the new manager’s approval (D13)', (): void => {
    expect(
      recordWords(
        {
          type: 'work.plan-held',
          payload: { workItemId: 'w1', reason: 'approved-by-predecessor' },
        },
        subject,
      ),
    ).toBe(
      'The plan for “Draft response for new tier-two RevOps ask” is held for you: your predecessor approved it, so approve it again.',
    );
  });

  it('says a plan approved under autonomous actions was not the manager pressing Approve', (): void => {
    expect(
      recordWords({ type: 'work.plan-approved', payload: { by: 'autonomous' } }, { name: 'Mira' }),
    ).toBe('The plan was approved under autonomous actions.');
  });

  it('says who paused the employee and why, and who resumed it (12-P)', (): void => {
    expect(
      recordWords({ type: 'agent.paused', payload: { reason: 'Quarter close.' } }, subject),
    ).toBe('You paused Mira: Quarter close.');
    expect(recordWords({ type: 'agent.paused', payload: {} }, subject)).toBe('You paused Mira.');
    expect(recordWords({ type: 'agent.resumed', payload: { pausedAt: 1 } }, subject)).toBe(
      'You resumed Mira.',
    );
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

describe('the access request and the organisation connection ledger in the record (11-AO)', (): void => {
  it('says the manager asked IT for access, naming the scopes', (): void => {
    expect(
      recordWords(
        {
          type: 'surface.access-requested',
          payload: {
            surfaceId: 's1',
            system: 'linear',
            reason: 'no-connection',
            scopes: ['linear:read', 'linear:write'],
            text: 'request',
          },
        },
        { ...subject, connection: 'Linear' },
      ),
    ).toBe('You asked IT for access to the Linear connection (linear:read, linear:write).');
  });

  it('says what happened to an organisation connection and who did it, with a revoke’s reason', (): void => {
    const named = {
      organisationConnectionId: 'c1',
      system: 'slack',
      displayName: 'Slack',
    };
    expect(
      recordWords(
        {
          type: 'organisation.connection-landed',
          payload: { ...named, via: 'organisation-page', kind: 'slack-configuration' },
        },
        subject,
      ),
    ).toBe('Slack was connected for the organisation by an administrator.');
    expect(
      recordWords(
        { type: 'organisation.connection-rotated', payload: { ...named, via: 'setup-cli' } },
        subject,
      ),
    ).toBe("The organisation's Slack connection was given a new secret by the setup command.");
    expect(
      recordWords(
        {
          type: 'organisation.connection-corrected',
          payload: {
            ...named,
            via: 'setup-cli',
            redirectCorrected: true,
            scopes: ['chat:write', 'im:write'],
            previousScopes: ['chat:write'],
          },
        },
        subject,
      ),
    ).toBe(
      "The organisation's Slack connection had its recorded redirect and scopes (now chat:write, im:write) corrected by the setup command.",
    );
    expect(
      recordWords(
        {
          type: 'organisation.connection-corrected',
          payload: { ...named, via: 'setup-cli', issuerRecorded: true },
        },
        subject,
      ),
    ).toBe("The organisation's Slack connection had its issuer recorded by the setup command.");
    expect(
      recordWords(
        {
          type: 'organisation.connection-revoked',
          payload: { ...named, via: 'organisation-page', reason: 'the workspace moved.' },
        },
        subject,
      ),
    ).toBe(
      "The organisation's Slack connection was revoked by an administrator: the workspace moved.",
    );
    const attempt = { credentialId: 'k1', system: 'slack', end: 'retire', attempt: 1 };
    expect(
      recordWords(
        { type: 'organisation.revoked-at-source', payload: { ...attempt, outcome: 'app-deleted' } },
        subject,
      ),
    ).toBe(
      "An employee's Slack app was deleted in Slack with the organisation's Slack connection.",
    );
    expect(
      recordWords(
        {
          type: 'organisation.revoked-at-source',
          payload: { ...attempt, outcome: 'failed', reason: 'invalid_auth' },
        },
        subject,
      ),
    ).toBe(
      "Revoking an employee's access at Slack with the organisation's Slack connection failed: invalid_auth.",
    );
  });

  it("says the organisation's shared Linear token was revoked with its connection, not an employee's access (R41V-1)", (): void => {
    const shared = {
      credentialId: 'k2',
      system: 'linear',
      end: 'organisation-revoked',
      attempt: 1,
      shared: true,
    };
    const line = (payload: Record<string, unknown>): string =>
      recordWords(
        { type: 'organisation.revoked-at-source', payload: { ...shared, ...payload } },
        subject,
      );
    expect(line({ outcome: 'token-revoked' })).toBe(
      "Day0 revoked the organisation's shared Linear app token at Linear and deleted its copy.",
    );
    expect(line({ outcome: 'already-gone' })).toBe(
      "The organisation's shared Linear app token was already revoked at Linear; Day0 deleted its copy.",
    );
    expect(line({ outcome: 'failed', reason: 'Linear answered HTTP 503.' })).toBe(
      "Revoking the organisation's shared Linear app token at Linear failed: Linear answered HTTP 503; Day0's copy was deleted, and the token lapses 30 days after it was issued.",
    );
  });
});

describe("what Day0's uses of the Slack configuration token and the re-join say in the record (11-AS)", (): void => {
  const subject = { name: 'Leo', connection: 'Slack' };
  const used = { organisationConnectionId: 'c1', system: 'slack', displayName: 'Slack' };

  it('tells a revoke at Slack from a token Slack had already ended, and tells IT to keep the generating sign-in closed, since only its lapse ends its refresh token (R41V-10, R41X-8)', (): void => {
    const revoked = (payload: Record<string, unknown>): string =>
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'auth.revoke', ...payload },
        },
        subject,
      );
    const advice =
      'nothing ends its refresh token but its lapse: until then whoever copied it while its row ' +
      'was listed on api.slack.com can mint a token with it, so IT keeps the sign-in of the ' +
      'account that generated it closed.';
    expect(revoked({ outcome: 'done' })).toBe(
      "Day0 revoked the organisation's Slack configuration token at Slack and deleted its copy, " +
        `once it was taken out of use; ${advice}`,
    );
    expect(revoked({ outcome: 'already-revoked', reason: 'Slack answered token_revoked' })).toBe(
      "The organisation's Slack configuration token had already ended at Slack when Day0 " +
        `asked: Slack answered token_revoked; Day0 deleted its copy, and ${advice}`,
    );
    expect(revoked({ outcome: 'done', unkept: true })).toBe(
      'Day0 revoked a configuration token Slack issued to a renewal that finished after the ' +
        `connection was revoked, which it kept nowhere; ${advice}`,
    );
    expect(revoked({ outcome: 'failed', reason: 'Slack auth.revoke returned HTTP 503.' })).toBe(
      "Revoking the organisation's Slack configuration token at Slack failed: Slack auth.revoke " +
        `returned HTTP 503; Day0's copy was deleted, and ${advice}`,
    );
  });

  it("never tells IT that deleting the token's row ends the refresh token, which only its lapse ends (R41X-8)", (): void => {
    for (const outcome of ['done', 'already-revoked', 'unrecognised', 'failed']) {
      const line = recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'auth.revoke', outcome },
        },
        subject,
      );
      expect(line, outcome).not.toMatch(/\bdeletes? the token's row\b/);
      expect(line, outcome).toContain('nothing ends its refresh token but its lapse');
      expect(line, outcome).toContain('whoever copied it while its row was listed');
      expect(line, outcome).toContain(
        'so IT keeps the sign-in of the account that generated it closed.',
      );
    }
  });

  it("says a revoke Slack's auth.test could not check was not checked (the round review's m2)", (): void => {
    const revoked = (payload: Record<string, unknown>): string =>
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'auth.revoke', unchecked: true, ...payload },
        },
        subject,
      );
    const advice =
      'nothing ends its refresh token but its lapse: until then whoever copied it while its row ' +
      'was listed on api.slack.com can mint a token with it, so IT keeps the sign-in of the ' +
      'account that generated it closed.';
    const notChecked = 'though Slack could not be asked afterwards whether it still works';
    expect(revoked({ outcome: 'done' })).toBe(
      "Day0 revoked the organisation's Slack configuration token at Slack and deleted its copy, " +
        `once it was taken out of use, ${notChecked}; ${advice}`,
    );
    expect(revoked({ outcome: 'already-revoked', reason: 'Slack answered token_revoked' })).toBe(
      "The organisation's Slack configuration token had already ended at Slack when Day0 " +
        `asked: Slack answered token_revoked, ${notChecked}; Day0 deleted its copy, and ${advice}`,
    );
    expect(revoked({ outcome: 'done', unkept: true })).toBe(
      'Day0 revoked a configuration token Slack issued to a renewal that finished after the ' +
        `connection was revoked, which it kept nowhere, ${notChecked}; ${advice}`,
    );
  });

  it("tells a token Slack did not recognise from one Slack had ended (the round review's m3)", (): void => {
    const revoked = (payload: Record<string, unknown>): string =>
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'auth.revoke', ...payload },
        },
        subject,
      );
    const advice =
      'nothing ends its refresh token but its lapse: until then whoever copied it while its row ' +
      'was listed on api.slack.com can mint a token with it, so IT keeps the sign-in of the ' +
      'account that generated it closed.';
    expect(revoked({ outcome: 'unrecognised', reason: 'Slack answered invalid_auth' })).toBe(
      "Slack did not recognise the organisation's Slack configuration token when Day0 asked to " +
        'revoke it: Slack answered invalid_auth. Day0 cannot tell whether Slack had ended it ' +
        `or never knew it; Day0 deleted its copy, and ${advice}`,
    );
  });

  it("says each call on the organisation's ledger without naming an employee", (): void => {
    expect(
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'tooling.tokens.rotate', outcome: 'done' },
        },
        subject,
      ),
    ).toBe("Day0 renewed the organisation's Slack configuration token with its refresh token.");
    expect(
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: {
            ...used,
            method: 'tooling.tokens.rotate',
            outcome: 'failed',
            reason: 'invalid_refresh_token',
          },
        },
        subject,
      ),
    ).toBe(
      "Day0 could not renew the organisation's Slack configuration token: invalid_refresh_token.",
    );
    expect(
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'tooling.tokens.rotate', outcome: 'superseded' },
        },
        subject,
      ),
    ).toBe(
      "Day0 renewed the organisation's Slack configuration token twice at once and kept the other renewal's token.",
    );
    expect(
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: { ...used, method: 'apps.manifest.create', outcome: 'done', appId: 'A123' },
        },
        subject,
      ),
    ).toBe(
      "Day0 created an employee's own Slack app (A123) with the organisation's Slack configuration token.",
    );
    expect(
      recordWords(
        {
          type: 'organisation.configuration-used',
          payload: {
            ...used,
            method: 'apps.manifest.create',
            outcome: 'failed',
            reason: 'invalid_auth',
          },
        },
        subject,
      ),
    ).toBe(
      "Creating an employee's own Slack app with the organisation's Slack configuration token failed: invalid_auth.",
    );
  });

  it('says which channels the employee re-joined itself and which need a person', (): void => {
    expect(
      recordWords(
        {
          type: 'surface.channels-rejoined',
          payload: {
            surfaceId: 's1',
            joined: ['#revops', '#revops-asks'],
            needsPerson: ['#revops-leads'],
          },
        },
        subject,
      ),
    ).toBe(
      'After the renewal Leo re-joined #revops and #revops-asks in Slack itself; #revops-leads needs someone in it to add Leo.',
    );
    expect(
      recordWords(
        {
          type: 'surface.channels-rejoined',
          payload: {
            surfaceId: 's1',
            joined: [],
            needsPerson: ['#revops'],
            reason: 'missing_scope',
          },
        },
        subject,
      ),
    ).toBe(
      'After the renewal Leo re-joined no channel in Slack itself (Slack answered missing_scope); #revops needs someone in it to add Leo.',
    );
    expect(
      recordWords(
        {
          type: 'surface.channels-rejoined',
          payload: { surfaceId: 's1', joined: ['#revops'], needsPerson: [] },
        },
        subject,
      ),
    ).toBe('After the renewal Leo re-joined #revops in Slack itself.');
    expect(
      recordWords(
        {
          type: 'surface.channels-rejoined',
          payload: { surfaceId: 's1', joined: [], needsPerson: ['#revops-leads', '#finance'] },
        },
        subject,
      ),
    ).toBe(
      'After the renewal Leo re-joined no channel in Slack itself; #revops-leads and #finance need someone in them to add Leo.',
    );
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

describe('the record after a handover (decisions 4 and 5, the wave 10 review, M8)', (): void => {
  /** An event older than the reader's tenure: the manager then was sam@company.com. */
  const earlier = {
    name: 'Mira',
    item: 'Draft response for new tier-two RevOps ask',
    manager: { kind: 'earlier', address: 'sam@company.com' },
    reader: 'lead@company.com',
  } as const;

  it.each(EVENT_TYPES)(
    'says %s without "you" or "your" when the manager then was another',
    (type): void => {
      for (const payload of [
        {},
        { name: 'chat-thread-reply', fromAddress: 'x@company.com' },
        FULL,
        { ...FULL, via: 'plan-approval', decidedVia: 'channel', reason: 'skip-overruled' },
      ]) {
        const words = recordWords({ type, payload }, earlier);
        expect(words).not.toMatch(/\byou(rs?|rself)?\b/i);
        expect(words).toMatch(/^[A-Z0-9“]/);
        // The manager then is named once a sentence, and "they" after that.
        expect(words.split('sam@company.com').length - 1).toBeLessThanOrEqual(1);
      }
    },
  );

  it('names the manager then as the one who decided, never opening on an address', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.approved',
          payload: { name: 'kanban-comment-and-close', scopes: ['linear:write'] },
        },
        earlier,
      ),
    ).toBe(
      "Mira's manager then, sam@company.com, approved the skill kanban-comment-and-close, granting linear:write.",
    );
    expect(
      recordWords(
        { type: 'permission.granted', payload: { scope: 'linear:write', source: 'skill' } },
        earlier,
      ),
    ).toBe('Mira was granted linear:write with a skill sam@company.com approved.');
    // The reader's own decisions still read "You".
    expect(
      recordWords(
        { type: 'skill.approved', payload: { name: 'kanban-comment-and-close' } },
        { ...earlier, manager: { kind: 'reader' } },
      ),
    ).toBe('You approved the skill kanban-comment-and-close.');
  });

  it('says an adoption under the manager then names its author as a colleague under the previous manager', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.adopted',
          payload: { name: 'kanban-comment-and-close', version: 1, authorName: 'Priya' },
        },
        earlier,
      ),
    ).toBe(
      "Mira's manager then, sam@company.com, adopted version 1 of the skill kanban-comment-and-close, written by a colleague under the previous manager, for Mira; the sandbox checks it again for Mira before it runs.",
    );
    expect(
      recordWords(
        {
          type: 'skill.adoption-offered',
          payload: { name: 'kanban-comment-and-close', version: 1, authorName: 'Priya' },
        },
        earlier,
      ),
    ).not.toContain('Priya');
  });

  it('says the move turned autonomous actions off and set run notes, whoever reads it', (): void => {
    for (const about of [earlier, { ...earlier, manager: { kind: 'reader' } } as const]) {
      expect(
        recordWords(
          {
            type: 'agent.autonomy-changed',
            payload: { from: true, to: false, reason: 'handed over to a new manager' },
          },
          about,
        ),
      ).toBe('Autonomous actions were turned off when Mira was handed over.');
      expect(
        recordWords(
          {
            type: 'agent.notifications-changed',
            payload: { from: 'digest', to: 'per-run', reason: 'handed over to a new manager' },
          },
          about,
        ),
      ).toBe('Run notes went back to one per run when Mira was handed over.');
    }
  });

  it('names the manager then who paused or resumed the employee', (): void => {
    expect(recordWords({ type: 'agent.paused', payload: {} }, earlier)).toBe(
      "Mira's manager then, sam@company.com, paused Mira.",
    );
    expect(recordWords({ type: 'agent.resumed', payload: {} }, earlier)).toBe(
      "Mira's manager then, sam@company.com, resumed Mira.",
    );
  });

  it('says a withheld handover note to the manager it was addressed to as addressed to them', (): void => {
    const withheld = {
      type: 'manager.transfer-note-withheld',
      payload: { fromAddress: 'sam@company.com', toAddress: 'lead@company.com' },
    } as const;
    expect(recordWords(withheld, earlier)).toBe(
      'The note from sam@company.com to you was withheld: Day0 could not check it for stored credentials.',
    );
    expect(
      recordWords(withheld, {
        name: 'Mira',
        manager: { kind: 'reader' },
        reader: 'sam@company.com',
      }),
    ).toBe(
      'Your note to lead@company.com was withheld: Day0 could not check it for stored credentials.',
    );
  });
});

describe('what the record says an authoring claim began (A-m9)', (): void => {
  it('says a check of a stored version is checking, and an authoring is writing', (): void => {
    expect(
      recordWords(
        {
          type: 'skill.authoring-claimed',
          payload: { name: 'kanban-comment-and-close', purpose: 'verify-stored' },
        },
        { name: 'Mira' },
      ),
    ).toBe('Mira started checking the skill kanban-comment-and-close in the sandbox.');
    for (const payload of [
      { name: 'kanban-comment-and-close', purpose: 'author' },
      { name: 'kanban-comment-and-close' },
    ]) {
      expect(recordWords({ type: 'skill.authoring-claimed', payload }, { name: 'Mira' })).toBe(
        'Mira started writing the skill kanban-comment-and-close.',
      );
    }
  });
});

describe('what the record says an end of access did at the vendor (11-AR; the access plan 4.4)', (): void => {
  const leo = { name: 'Leo', connection: 'Slack' };
  const ended = (
    payload: Record<string, unknown>,
    at: { readonly name: string; readonly connection?: string } = leo,
  ): string => recordWords({ type: 'credential.revoked-at-source', payload }, at);

  it('says the bot token was revoked and its channel memberships removed, the app kept', (): void => {
    expect(
      ended({
        system: 'slack',
        surfaceName: 'Slack',
        end: 'expiry',
        outcome: 'token-revoked',
        channelMembershipsRemoved: true,
      }),
    ).toBe(
      'Access to the Slack connection was revoked at Slack; its channel memberships were removed.',
    );
  });

  it("says the employee's own app was deleted in the system, by the card's name once the card is gone", (): void => {
    expect(
      ended(
        { system: 'slack', surfaceName: 'Slack', end: 'retire', outcome: 'app-deleted' },
        { name: 'Leo' },
      ),
    ).toBe("Leo's Slack app was deleted in Slack.");
    expect(
      ended({ system: 'slack', surfaceName: 'Slack', end: 'retire', outcome: 'app-uninstalled' }),
    ).toBe("Leo's Slack app was uninstalled from Slack.");
    // A disconnect-end line says the token (11-AJ join 4); an expiry's still says the access.
    expect(
      ended(
        { system: 'linear', surfaceName: 'Linear', end: 'disconnect', outcome: 'token-revoked' },
        { name: 'Maya' },
      ),
    ).toBe('A token Day0 held for the Linear connection was revoked at Linear.');
    expect(
      ended(
        { system: 'linear', surfaceName: 'Linear', end: 'expiry', outcome: 'token-revoked' },
        { name: 'Maya' },
      ),
    ).toBe('Access to the Linear connection was revoked at Linear.');
  });

  it("says a token a disconnect-end revoked as the token, never as the manager's Disconnect, since a re-authorisation ends the pair it replaces the same way (11-AJ join 4)", (): void => {
    const line = ended(
      { system: 'linear', surfaceName: 'Linear', end: 'disconnect', outcome: 'token-revoked' },
      { name: 'Maya', connection: 'Linear' },
    );
    expect(line).toBe('A token Day0 held for the Linear connection was revoked at Linear.');
    expect(line).not.toMatch(/disconnect|Access to/i);
  });

  it("says a failure in the vendor's words, and whether another attempt follows", (): void => {
    expect(
      ended({
        system: 'linear',
        surfaceName: 'Linear',
        end: 'disconnect',
        outcome: 'retrying',
        reason: 'Linear answered HTTP 503.',
      }),
    ).toBe(
      'Revoking access to the Slack connection at Linear failed and will be tried again: Linear answered HTTP 503.',
    );
    expect(
      ended({
        system: 'linear',
        surfaceName: 'Linear',
        end: 'disconnect',
        outcome: 'failed',
        reason: 'Linear refused: invalid_client',
      }),
    ).toBe(
      "Revoking access to the Slack connection at Linear failed: Linear refused: invalid_client; Day0's copy was deleted.",
    );
  });

  it('says a pasted key was never sent to the vendor, and a shared token was not revoked', (): void => {
    expect(
      ended({
        system: 'Zendesk',
        surfaceName: 'Zendesk',
        end: 'disconnect',
        outcome: 'pasted-key',
      }),
    ).toBe(
      'Day0 stopped using the key pasted for the Slack connection; it was not revoked at Zendesk, so revoke it there if it should end.',
    );
    expect(
      ended({ system: 'linear', surfaceName: 'Linear', end: 'retire', outcome: 'shared' }),
    ).toBe(
      "Access to the Slack connection ended; its shared app token was not revoked at Linear, since the app's other employees use it.",
    );
  });

  it("says the shared token is revoked with the organisation's revoke of its connection, not kept for others (R41V-1)", (): void => {
    expect(
      ended({
        system: 'linear',
        surfaceName: 'Linear',
        end: 'organisation-revoked',
        outcome: 'shared',
      }),
    ).toBe(
      "Access to the Slack connection ended; its shared app token is revoked at Linear with the organisation's connection.",
    );
  });

  it('says what an end that calls no vendor did, in its own words', (): void => {
    expect(
      ended({
        system: 'slack',
        surfaceName: 'Slack',
        end: 'transfer',
        outcome: 'not-at-vendor',
        reason: 'A handover changes nothing at the vendor; the new manager re-approves the system.',
      }),
    ).toBe(
      'Access to the Slack connection ended with nothing changed at Slack: A handover changes nothing at the vendor; the new manager re-approves the system.',
    );
    expect(
      ended({
        system: 'zendesk',
        surfaceName: 'Zendesk',
        end: 'disconnect',
        outcome: 'not-supported',
        reason: "zendesk: no revocation endpoint; Day0's copy is deleted.",
      }),
    ).toBe(
      "Access to the Slack connection could not be revoked at zendesk: zendesk: no revocation endpoint; Day0's copy is deleted.",
    );
    expect(
      ended({ system: 'slack', surfaceName: 'Slack', end: 'disconnect', outcome: 'already-gone' }),
    ).toBe('Access to the Slack connection was already revoked at Slack.');
  });

  it('says who disconnected a connection', (): void => {
    expect(recordWords({ type: 'surface.disconnected', payload: { by: 'manager' } }, leo)).toBe(
      'You disconnected the Slack connection.',
    );
    expect(
      recordWords(
        {
          type: 'surface.disconnected',
          payload: { by: 'organisation', reason: 'Slack was disconnected for everyone by IT' },
        },
        leo,
      ),
    ).toBe(
      "The Slack connection was disconnected when the organisation's connection was revoked: Slack was disconnected for everyone by IT.",
    );
  });
});
