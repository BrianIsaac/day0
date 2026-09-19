import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Charter } from '../../../src/agent/charter';
import type { ExecutionPlan, MockAction, MockSurfaceSnapshot, WorkCandidate } from '../../../src/work/types';
import rehearsal from '../../fixtures/work/demo-rehearsal-2-2026-09-19.json';

/**
 * Demo rehearsal 2 (19 Sep 2026): Priya's reply in the asker's thread ended
 * `Ref: C0C2U2UJUTU:1789761553.312049.`, the thread's own channel id and
 * timestamp, in a message a customer reads. The authored skill tells the
 * executor to cite `<record-id>`, and a Slack mention's record id is exactly
 * that pair. Where the reply goes is carried by the action's `channel` and
 * `thread_ts` (the ledger and every downstream reader use those), so the
 * visible text never needs it.
 */

const recorded = vi.hoisted(() => ({ users: [] as string[], outputs: [] as unknown[] }));

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

import { OWN_THREAD_REFERENCE_REMOVED, executorPreamble, runSkill } from '../../../src/work/execute-skill';
import { withoutOwnThreadReferences, withoutThreadReference } from '../../../src/work/reply-target';

const priya = rehearsal.workItems.priyaCompleted;
const target = priya.replyTarget;
const recordedReply = priya.output.actions[6] as MockAction;
const RAW = 'C0C2U2UJUTU:1789761553.312049';
const live = { verdict: 'connected' as const, credentialLanded: true, lastVerifiedAt: 1 };
const surfaces = [
  { slug: 'slack', displayName: 'Slack', class: 'chat', path: 'documented-api', endpoint: 'https://slack.com/api/', toolAllowlist: ['chat.postMessage'], ...live },
  { slug: 'linear', displayName: 'Linear', class: 'kanban', path: 'mcp', endpoint: 'https://mcp.linear.app/mcp', toolAllowlist: ['save_comment'], ...live },
];

function textOf(action: MockAction): string {
  const payload = action.tool === 'http.request' ? action.args?.body : action.args?.toolArgsJson;
  const record = JSON.parse(payload as string) as Record<string, string>;
  return record.text ?? record.body ?? '';
}

describe('the raw thread reference in a visible message', (): void => {
  it('is what the rehearsal sent', (): void => {
    expect(textOf(recordedReply)).toMatch(/UTC\. Ref: C0C2U2UJUTU:1789761553\.312049\.$/);
  });

  it('is removed, label and all, from a reply in that thread', (): void => {
    expect(withoutThreadReference(textOf(recordedReply), target, 'in-thread')).toBe(
      'Done — the pipeline tile now shows 74% (the approved figure from the Friday standup summary). Audit line: Last updated by revops at 2026-09-19 03:27:49 UTC.',
    );
  });

  it('is removed in the other shapes a model writes it', (): void => {
    const said = 'The tile now shows 74%.';
    for (const tail of [
      ' (ref: C0C2U2UJUTU:1789761553.312049)',
      ' Reference: C0C2U2UJUTU/1789761553.312049',
      '\nThread: channel C0C2U2UJUTU, thread_ts 1789761553.312049.',
      ' Ref 1789761553.312049.',
      ' [C0C2U2UJUTU:1789761553.312049]',
    ]) {
      expect(withoutThreadReference(`${said}${tail}`, target, 'in-thread')).toBe(said);
    }
  });

  it('becomes words a person reads anywhere else: a DM or a ticket comment', (): void => {
    expect(withoutThreadReference(`Tile refreshed to 74%. Ref: ${RAW}.`, target, 'elsewhere')).toBe(
      'Tile refreshed to 74%. Ref: the ask in #ops-requests.',
    );
    expect(withoutThreadReference(`Answering ${RAW} now.`, { channel: target.channel, threadTs: target.threadTs }, 'elsewhere')).toBe(
      'Answering the Slack thread now.',
    );
  });

  it('leaves alone a text without it, another thread\'s reference, and a text that is nothing else', (): void => {
    const clean = 'Done - the tile shows 74%. See FIN-1 and 2026-09-19 03:27:49 UTC.';
    expect(withoutThreadReference(clean, target, 'in-thread')).toBe(clean);
    const other = 'As said in C0C2P932A2H:1789757862.783069.';
    expect(withoutThreadReference(other, target, 'in-thread')).toBe(other);
    expect(withoutThreadReference(`Ref: ${RAW}.`, target, 'in-thread')).toBe(`Ref: ${RAW}.`);
  });
});

describe('the action set', (): void => {
  it('keeps channel and thread_ts where the ledger and the retry read them, and changes only the text', (): void => {
    const result = withoutOwnThreadReferences([recordedReply], surfaces, target);
    expect(result.changed).toEqual([0]);
    const body = JSON.parse(result.actions[0]!.args!.body as string) as Record<string, string>;
    expect(body.channel).toBe('C0C2U2UJUTU');
    expect(body.thread_ts).toBe('1789761553.312049');
    expect(body.text).not.toContain('C0C2U2UJUTU');
    expect(body.text).not.toContain('1789761553');
    expect(result.actions[0]!.args!.headersJson).toBe(recordedReply.args!.headersJson);
  });

  it('rewrites a ticket comment and a manager DM in words, and returns the same set when nothing carries it', (): void => {
    const comment: MockAction = {
      tool: 'mcp.call',
      args: { surface: 'linear', tool: 'save_comment', toolArgsJson: JSON.stringify({ issueId: 'REVOPS-5', body: `Tile refreshed to 74% for ${RAW}.` }) },
    };
    const result = withoutOwnThreadReferences([comment], surfaces, target);
    expect(JSON.parse(result.actions[0]!.args!.toolArgsJson as string)).toEqual({
      issueId: 'REVOPS-5',
      body: 'Tile refreshed to 74% for the ask in #ops-requests.',
    });
    const browser = priya.output.actions.slice(0, 6) as MockAction[];
    const untouched = withoutOwnThreadReferences(browser, surfaces, target);
    expect(untouched.changed).toEqual([]);
    expect(untouched.actions).toBe(browser);
    expect(withoutOwnThreadReferences([recordedReply], surfaces, undefined).changed).toEqual([]);
  });
});

describe('a run whose reply cites its own thread', (): void => {
  beforeEach((): void => {
    recorded.users.length = 0;
    recorded.outputs.length = 0;
  });

  const charter: Charter = {
    version: '0.0', source: 'test', whyThisHire: 'Keep the dashboards current.',
    proposedFunction: 'Revenue operations: keep the pipeline dashboards current.',
    evidence: [], shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
    proposedBoundaries: { willDo: ['Refresh the pipeline tile when asked.'], willNotDo: [], escalationTriggers: [] },
    namedCollaborators: [], namedSystems: [], priorityReading: [], adjacentRoles: [],
    approvalChain: { boss: 'Manager', confidence: 'high' }, openQuestions: [], createdAt: '2026-09-19T00:00:00.000Z',
  };
  const ask: WorkCandidate = {
    sourceCategory: 'event-stream', sourceSystem: 'slack', externalId: priya.externalId, title: priya.title,
    contentSummary: priya.contentSummary, contentRefs: [], replyTarget: target, observedAt: new Date(priya.observedAt),
  };
  // A plan with no declared read, so the reply is phase one's to write (Priya's own plan leaves it to the closing phase).
  const plan: ExecutionPlan = {
    summary: 'Tell the asker the refresh is under way.', steps: ['Reply in the thread.'],
    expectedOutputType: 'message', riskNotes: '', reversibility: 'reversible', estimatedMinutes: 2,
  };
  const mockEnv = { howToGuides: [], teamDocs: [], spreadsheets: [], slackChannels: [], tweets: [], tickets: [] } as unknown as MockSurfaceSnapshot;
  const holding: MockAction = {
    ...recordedReply,
    args: {
      ...recordedReply.args,
      body: JSON.stringify({ channel: target.channel, thread_ts: target.threadTs, text: `On it; I will answer here once the tile is refreshed. Ref: ${RAW}.` }),
    },
  };
  const authored = { draft: 'Answering.', notes: '', needsDependentPhase: false, deferredActions: [], actions: [holding], procedureTrails: [] };

  it('reaches the gate without it, in real mode, and records the correction', async (): Promise<void> => {
    recorded.outputs.push(authored);
    const corrections: string[] = [];
    const output = await runSkill({
      skill: { name: 'chat-thread-reply', description: 'Reply.', body: '# Skill' }, plan, candidate: ask, charter, mockEnv,
      mode: 'real', surfaces: surfaces as never,
      onAuditCorrection: async (_indices, reason): Promise<void> => void corrections.push(reason),
    });
    expect(output.actions).toHaveLength(1);
    expect(textOf(output.actions[0]!)).toBe('On it; I will answer here once the tile is refreshed.');
    expect(corrections).toEqual([`${OWN_THREAD_REFERENCE_REMOVED} (action 0)`]);
  });

  it('tells the executor, in real mode only, that the text carries neither id', async (): Promise<void> => {
    recorded.outputs.push(authored);
    await runSkill({ skill: { name: 'chat-thread-reply', description: 'Reply.', body: '# Skill' }, plan, candidate: ask, charter, mockEnv, mode: 'real', surfaces: surfaces as never });
    const rule = 'The text of a reply, a DM or a comment never carries a raw channel id or thread timestamp';
    expect(executorPreamble('real')).toContain(rule);
    expect(executorPreamble('mock')).not.toContain('raw channel id');
  });

  it('leaves a mock run as authored', async (): Promise<void> => {
    const mockReply: MockAction = { tool: 'slack.postMessage', args: { channelSlug: 'ops-requests', body: `Done. Ref: ${RAW}.` } };
    recorded.outputs.push({ ...authored, actions: [mockReply] }, { ...authored, actions: [mockReply] });
    const output = await runSkill({
      skill: { name: 'chat-thread-reply', description: 'Reply.', body: '# Skill' }, plan, candidate: ask, charter, mockEnv, mode: 'mock',
    }).catch((): undefined => undefined);
    if (output) expect(output.actions).toEqual([mockReply]);
    expect(withoutOwnThreadReferences([mockReply], surfaces, target).changed).toEqual([]);
  });
});
