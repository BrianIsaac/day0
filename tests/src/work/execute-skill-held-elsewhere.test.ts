import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import { HELD_ELSEWHERE_LIMIT, heldElsewhereLines, heldElsewhereRows, type HeldExternalItem } from '../../../src/work/claim-key';
import type { ExecutionPlan, MockAction, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';

/**
 * Finding D of the 19 September full run, from the executor's side. The
 * `#finance-close` ask authored its thread reply and its note on FIN-1 in one
 * phase, before any apply, so nothing told it that FIN-1 had a work item of
 * its own. The executor is told before it authors which external items other
 * work items hold and what has landed on them. Real mode only: the mock
 * prompts carry none of it.
 */

const recorded = vi.hoisted(() => ({
  users: [] as string[],
  outputs: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  MODEL_CONFIG: 'openai/mock',
  MODEL_PROVIDER_MAX_RETRIES: 2,
  agentJson: async <T>(args: { user: string }): Promise<T> => {
    recorded.users.push(args.user);
    const next = recorded.outputs.shift();
    if (!next) throw new Error('test did not provide another structured executor response');
    return next as T;
  },
}));

import { runDependentSkill, runSkill } from '../../../src/work/execute-skill';

const charter: Charter = {
  version: '0.0',
  source: 'test',
  whyThisHire: 'Keep the close moving.',
  proposedFunction: 'Finance operations: keep the month-end close on track.',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Answer close status asks.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-19T00:00:00.000Z',
};

/** The ask as the run seeded it. */
const ask: WorkCandidate = {
  sourceCategory: 'event-stream',
  sourceSystem: 'slack',
  externalId: 'C0C2P932A2H:1789757862.783069',
  title: 'Slack mention in #finance-close',
  contentSummary: '@Day0 can you post where the September close stands?',
  contentRefs: [],
  replyTarget: { channel: 'C0C2P932A2H', threadTs: '1789757862.783069' },
  observedAt: new Date('2026-09-19T03:03:00.000Z'),
};

const plan: ExecutionPlan = {
  summary: 'Read the September close tickets and answer in the thread.',
  steps: ['Read the September close tickets.', 'Reply in the thread with where the close stands.'],
  expectedOutputType: 'message',
  riskNotes: '',
  reversibility: 'reversible',
  estimatedMinutes: 2,
};

const mockEnv = {
  howToGuides: [],
  teamDocs: [],
  spreadsheets: [],
  slackChannels: [],
  tweets: [],
  tickets: [],
} as unknown as MockSurfaceSnapshot;

const FIRST_NOTE_ID = 'f35414fd-91b6-44cf-9541-74b932b98363';
const TICKET_TITLE = 'Post the September close status note';

const waiting: HeldExternalItem = {
  externalId: 'FIN-1', sourceSystem: 'linear', holderName: 'Mateo', sameEmployee: true,
  title: TICKET_TITLE, state: 'discovered', unclaimed: true,
};
const landed: HeldExternalItem = {
  externalId: 'REVOPS-27', externalAlias: '0b6e0a52-5d0e-4f0f-9d0a-3a0f6a1c2b7e', sourceSystem: 'linear',
  holderName: 'Priya', sameEmployee: false, title: 'Refresh the pipeline coverage tile', state: 'completed',
  landedComment: FIRST_NOTE_ID,
};

const phaseOne = { draft: 'Answering.', notes: '', needsDependentPhase: false, deferredActions: [], actions: [], procedureTrails: [] };
const skill = { name: 'chat-reply', description: 'Reply.', body: '# Skill' };

describe('heldElsewhereLines', (): void => {
  it('is empty when nothing is held elsewhere', (): void => {
    expect(heldElsewhereLines(undefined)).toEqual([]);
    expect(heldElsewhereLines([])).toEqual([]);
  });

  it('names each item, who has it, its work item and state, and what has landed', (): void => {
    const text = heldElsewhereLines([waiting, landed]).join('\n');
    expect(text).toContain('--- External items other work items hold (2) ---');
    expect(text).toContain(`linear · FIN-1 · this employee · "${TICKET_TITLE}" (discovered, not claimed yet) · nothing landed yet`);
    expect(text).toContain(`linear · REVOPS-27 (also ${landed.externalAlias}) · Priya · "Refresh the pipeline coverage tile" (completed) · landed comment ${FIRST_NOTE_ID}`);
    expect(text).toContain('has its own work item');
    expect(text).toContain('it will be posted there');
  });

  it('is bounded: at most the limit of rows, each title cut, and the count says so', (): void => {
    const many = Array.from({ length: HELD_ELSEWHERE_LIMIT + 5 }, (_, index): HeldExternalItem => ({
      ...waiting, externalId: `FIN-${index + 1}`, title: 'x'.repeat(400),
    }));
    const lines = heldElsewhereLines(many);
    expect(lines.filter((line) => /^ {2}\d+\. /.test(line))).toHaveLength(HELD_ELSEWHERE_LIMIT);
    expect(lines.join('\n')).toContain(`(${many.length}, first ${HELD_ELSEWHERE_LIMIT} shown)`);
    expect(Math.max(...lines.map((line) => line.length))).toBeLessThan(700);
  });

  it('offers the rows alone as evidence: the rule beside them is an instruction and vouches for nothing', (): void => {
    const rows = heldElsewhereRows([waiting, landed]);
    expect(rows).toHaveLength(2);
    expect(rows.join('\n')).toContain(`landed comment ${FIRST_NOTE_ID}`);
    expect(rows.join('\n')).not.toContain('Do not author');
    expect(heldElsewhereLines([waiting, landed]).filter((line) => rows.includes(line))).toEqual(rows);
  });

  it('carries no secret-shaped value a title quotes', (): void => {
    const secret = ['xoxb', '2847561930', '5529104736', 'aBcDeFgHiJkLmNoPqRsTuVwX'].join('-');
    const text = heldElsewhereLines([{ ...waiting, title: `Rotate the bot token ${secret}` }]).join('\n');
    expect(text).not.toContain(secret);
    expect(text).toContain('Rotate the bot token');
  });
});

describe('the external items other work items hold, in the executor prompts', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('tells phase one before it authors, in real mode', async (): Promise<void> => {
    recorded.outputs.push(phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: [], heldElsewhere: [waiting, landed] });
    const user = recorded.users[0]!;
    expect(user).toContain('--- External items other work items hold (2) ---');
    expect(user).toContain(`FIN-1 · this employee · "${TICKET_TITLE}"`);
    expect(user).toContain(`landed comment ${FIRST_NOTE_ID}`);
    expect(user.indexOf('--- External items other work items hold')).toBeLessThan(user.indexOf('--- Candidate ---'));
  });

  it('tells the closing phase too', async (): Promise<void> => {
    recorded.outputs.push({
      draft: 'Closing.', notes: '', actions: [], procedureTrails: [],
      planStepOutcomes: [
        { step: 1, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' },
        { step: 2, status: 'blocked', basis: 'ledger', evidence: 'nothing landed yet' },
      ],
    });
    await runDependentSkill({
      skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: [], heldElsewhere: [landed],
      initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [], procedureTrails: [] },
      initialLedger: [],
    });
    expect(recorded.users[0]).toContain('--- External items other work items hold (1) ---');
  });

  it('leaves the mock prompts byte-identical whether or not a list is passed', async (): Promise<void> => {
    const now = Date.parse('2026-09-19T03:03:42.000Z');
    // The mock contract refuses this empty set after its one repair; only the prompts are read here.
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'mock', now }).catch((): undefined => undefined);
    const without = [...recorded.users];
    recorded.users.length = 0;
    recorded.outputs.length = 0;
    recorded.outputs.push(phaseOne, phaseOne);
    await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'mock', now, heldElsewhere: [waiting, landed] }).catch((): undefined => undefined);
    expect(without.length).toBeGreaterThan(0);
    expect(recorded.users).toEqual(without);
    expect(recorded.users.join('\n')).not.toContain('other work items hold');
  });

  it('lets a phase-one reply cite the note the ticket\'s own item landed, without sending it back as unsupported', async (): Promise<void> => {
    const reply = {
      tool: 'http.request' as const,
      args: {
        surface: 'slack', method: 'POST' as const, path: '/chat.postMessage',
        headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}' }),
        body: JSON.stringify({
          channel: 'C0C2P932A2H', thread_ts: '1789757862.783069',
          text: `FIN-1 close status note posted as comment ${FIRST_NOTE_ID} by its own work item.`,
        }),
      },
    };
    const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
    const surfaces = [
      { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], ...live },
    ];
    const posted: HeldExternalItem = { ...waiting, state: 'completed', unclaimed: undefined, landedComment: FIRST_NOTE_ID };
    const authored = { ...phaseOne, actions: [reply] };

    recorded.outputs.push(authored, authored);
    const unsupported = await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: surfaces as never });
    expect(recorded.users).toHaveLength(2);
    expect(unsupported.actions).toEqual([]);

    recorded.users.length = 0;
    recorded.outputs.length = 0;
    recorded.outputs.push(authored);
    const supported = await runSkill({ skill, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: surfaces as never, heldElsewhere: [posted] });
    expect(recorded.users).toHaveLength(1);
    expect(supported.actions).toEqual([reply]);
  });
});

/**
 * The second full run (19 September, second sitting). The `#finance-close`
 * ask's closing phase was told FIN-1 had its own work item (the row was
 * `claimed` when the phase was authored) and still authored the reply beside
 * two writes to FIN-1, as its approved plan's steps 4 and 5 said to. The guard
 * withheld the writes; the reply was the status lines alone. The actions below
 * are the ones that phase authored, from the work item's row in the export.
 */
describe('the reply authored beside a write another work item holds (19 Sep, the #finance-close ask)', (): void => {
  const STATUS_LINES = 'Accruals booked: FIN-2 Accruals booked for September, Done\nBank reconciliation: FIN-3 Bank reconciliation for September, In Progress\nNot done yet: Bank reconciliation (FIN-3, In Progress)';
  const runAsk: WorkCandidate = {
    ...ask,
    externalId: 'C0C2P932A2H:1789761522.764859',
    contentSummary: '<@U0BTFK6FLNL> can you post where the September close stands?',
    replyTarget: { channel: 'C0C2P932A2H', threadTs: '1789761522.764859' },
  };
  const runPlan: ExecutionPlan = {
    ...plan,
    steps: [
      "Read the FIN / September close tickets in Linear (list_issues, then get_issue as needed) to find the step tickets and the status ticket titled 'Post the September close status note'.",
      'Compose the status note per the runbook format.',
      'Emit a chat.postMessage reply into the originating #finance-close thread (channel C0C2P932A2H, thread_ts 1789761522.764859) with the note lines.',
      'Emit a save_comment on the status ticket with the note as the body.',
      'Emit a save_issue moving the status ticket to Done, only after the note comment is posted and approved.',
    ],
  };
  const listIssues = { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'list_issues', toolArgsJson: JSON.stringify({ team: 'FIN', project: 'September close', limit: 50 }) } };
  const replyWith = (text: string) => ({
    tool: 'http.request' as const,
    args: {
      surface: 'slack', method: 'POST' as const, path: '/chat.postMessage',
      headersJson: JSON.stringify({ Authorization: 'Bearer {{secret}}', 'Content-Type': 'application/json; charset=utf-8' }),
      body: JSON.stringify({ channel: 'C0C2P932A2H', thread_ts: '1789761522.764859', text }),
    },
  });
  const saveComment = { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'FIN-1', body: STATUS_LINES }) } };
  const saveIssue = { tool: 'mcp.call' as const, args: { surface: 'linear', tool: 'save_issue', toolArgsJson: JSON.stringify({ id: 'FIN-1', state: 'Done' }) } };
  const outcomes = runPlan.steps.map((_step, index) => ({ step: index + 1, status: 'satisfied', basis: 'ledger', evidence: 'Applied ledger row 0: list_issues on linear returned FIN-2 and FIN-3.' }));
  const authoredInTheRun = { draft: 'September close status note.', notes: '', procedureTrails: [], planStepOutcomes: outcomes, actions: [replyWith(STATUS_LINES), saveComment, saveIssue] };
  const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
  const surfaces = [
    { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], ...live },
    { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp', toolAllowlist: ['list_issues', 'save_comment', 'save_issue'], ...live },
  ];
  const claimedTicket: HeldExternalItem = { ...waiting, state: 'claimed', unclaimed: undefined };
  const closing = (heldElsewhere: HeldExternalItem[], corrections: string[] = []) => runDependentSkill({
    skill, plan: runPlan, candidate: runAsk, charter, mockEnv, mode: 'real', surfaces: surfaces as never, heldElsewhere,
    initialOutput: { draft: '', notes: '', needsDependentPhase: true, actions: [listIssues], procedureTrails: [] },
    initialLedger: [{
      tool: 'mcp.call', ok: true, idempotencyKey: 'k:0',
      effect: 'list_issues on linear · {"issues":[{"id":"FIN-2","title":"Accruals booked for September","status":"Done"},{"id":"FIN-3","title":"Bank reconciliation for September","status":"In Progress"},{"id":"FIN-1","title":"Post the September close status note","status":"Todo"}]}',
    }],
    onAuditCorrection: async (_indices, reason): Promise<void> => { corrections.push(reason); },
  });
  const repliesOf = (actions: readonly MockAction[]): string[] =>
    actions.filter((action) => action.args.surface === 'slack').map((action) => (JSON.parse(String(action.args.body)) as { text: string }).text);

  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  it('sends the set back when its reply does not say where the note is, naming the item, its work item and what to say', async (): Promise<void> => {
    const said = `${STATUS_LINES}\nFIN-1 has its own work item with me, so the status note will be posted there.`;
    recorded.outputs.push(authoredInTheRun, { ...authoredInTheRun, actions: [replyWith(said), saveComment, saveIssue] });
    const output = await closing([claimedTicket]);

    expect(recorded.users).toHaveLength(2);
    expect(recorded.users[1]).toContain('the reply does not say where it is');
    expect(recorded.users[1]).toContain(`FIN-1 has its own work item with this employee, "${TICKET_TITLE}" (claimed)`);
    expect(repliesOf(output.actions)).toEqual([said]);
  });

  it('says it for an executor that still does not, in the reply itself, and records the correction', async (): Promise<void> => {
    const corrections: string[] = [];
    recorded.outputs.push(authoredInTheRun, authoredInTheRun);
    const output = await closing([claimedTicket], corrections);

    const [reply] = repliesOf(output.actions);
    expect(reply).toContain(STATUS_LINES);
    expect(reply).toContain(`FIN-1 has its own work item ("${TICKET_TITLE}"); what this request asked for on FIN-1 will be posted there.`);
    expect(output.actions).toHaveLength(3);
    expect(corrections.join('\n')).toContain('held-item reply completed');
  });

  it('cites the note once the holder has landed it, and names a colleague who holds the item', async (): Promise<void> => {
    recorded.outputs.push(authoredInTheRun, authoredInTheRun);
    const posted: HeldExternalItem = { ...claimedTicket, state: 'completed', sameEmployee: false, holderName: 'Aiko', landedComment: FIRST_NOTE_ID };
    const [reply] = repliesOf((await closing([posted])).actions);
    expect(reply).toContain(`FIN-1 has its own work item with Aiko ("${TICKET_TITLE}"); it is posted there as comment ${FIRST_NOTE_ID}.`);
  });

  it('reads a reply authored in phase one beside the write the same way (the first sitting\'s shape)', async (): Promise<void> => {
    const corrections: string[] = [];
    const authored = { ...phaseOne, actions: [replyWith(STATUS_LINES), saveComment] };
    recorded.outputs.push(authored, authored);
    const output = await runSkill({
      skill, plan: runPlan, candidate: runAsk, charter, mockEnv, mode: 'real', surfaces: surfaces as never, heldElsewhere: [claimedTicket],
      onAuditCorrection: async (_indices, reason): Promise<void> => { corrections.push(reason); },
    });
    expect(recorded.users[1]).toContain('the reply does not say where it is');
    const replies = repliesOf(output.actions);
    expect(replies).toHaveLength(1);
    expect(replies[0]).toContain('FIN-1 has its own work item');
    expect(corrections.join('\n')).toContain('held-item reply completed');
  });

  it('leaves a set alone when nothing it writes is held elsewhere, or when its reply already says so', async (): Promise<void> => {
    recorded.outputs.push(authoredInTheRun);
    expect(repliesOf((await closing([landed])).actions)).toEqual([STATUS_LINES]);
    expect(recorded.users).toHaveLength(1);
  });
});

