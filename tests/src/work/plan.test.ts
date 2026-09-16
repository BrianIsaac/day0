import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RecordedSpanModel } from '../../fixtures/redaction-double';
import type { Charter } from '../../../src/agent/charter';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { WorkCandidate } from '../../../src/work/types';
import {
  actionModeInstruction,
  CANDIDATE_RECORD_LENGTH,
  candidateRecordRead,
  draftExecutionPlan,
  planPreconditionAudit,
  planSystemPrompt,
  planUserPrompt,
  redactCandidateRecordText,
  renderCandidateRecord,
  SCOPE_NOT_GATE_PLANNER,
  THREAD_READ_LIMIT,
} from '../../../src/work/plan';

describe('plan drafter action mode', (): void => {
  it('states the autonomous mode without supervised approval language', (): void => {
    const prompt = planSystemPrompt(true);
    expect(prompt).toContain(
      'Autonomous actions are ON: every allowed write lands as emitted; do not say an action is queued or awaiting approval.',
    );
    expect(prompt).not.toContain('the boss will approve before you act');
    expect(prompt).not.toContain('Prefer drafts over actions');
  });

  it('states exactly what lands and what waits while autonomous actions are off', (): void => {
    expect(planSystemPrompt(false)).toContain(
      "Autonomous actions are OFF: reads and the manager DM land now; every other write is held for the manager's literal approval - say so.",
    );
    // OFF must not claim that writes apply; ON must not say anything waits.
    expect(actionModeInstruction(false)).toContain('every other write is held');
    expect(actionModeInstruction(false)).not.toMatch(/lands as emitted/);
    expect(actionModeInstruction(true)).not.toMatch(/is held|waits for/);
    expect(planSystemPrompt(false).split(actionModeInstruction(false))).toHaveLength(2);
  });

  it('states that every mock comparison action waits at the exact-action gate', (): void => {
    const instruction = actionModeInstruction(true, 'mock');
    expect(instruction).toContain('Mock comparison mode');
    expect(instruction).toContain('every emitted action is held');
    expect(instruction).not.toContain('lands as emitted');
    expect(planSystemPrompt(false, 'mock')).toContain(instruction);
  });
});

const planRecorded = vi.hoisted(() => ({
  users: [] as string[],
  instructions: [] as string[],
  outputs: [] as unknown[],
  /** The obligations judgement's prompts and scripted replies; unscripted, it fails open. */
  judgementUsers: [] as string[],
  judgements: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string, instructions: string) => {
    planRecorded.instructions.push(instructions);
    return { name };
  },
  agentJson: async <T>(args: { agent: { name: string }; user: string }): Promise<T> => {
    if (args.agent.name === 'day0-plan-obligations') {
      planRecorded.judgementUsers.push(args.user);
      const judgement = planRecorded.judgements.shift();
      if (judgement === undefined) throw new Error('obligations judgement unscripted');
      if (judgement instanceof Error) throw judgement;
      return judgement as T;
    }
    planRecorded.users.push(args.user);
    const queued = planRecorded.outputs.shift();
    if (queued instanceof Error) throw queued;
    return (queued ?? {
      summary: 'Refresh the tile as the runbook says.',
      steps: ['Sign in and set the figure.', 'Read the audit line back.'],
      expectedOutputType: 'ticket-update',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 5,
    }) as T;
  },
}));

const charter: Charter = {
  version: '0.0',
  source: 'day-1 manager 1:1',
  whyThisHire: 'Keep hand-offs moving.',
  proposedFunction: 'Operations coordination',
  evidence: [],
  shortTermGoals: { day30: 'Learn', day60: 'Own', day90: 'Improve' },
  proposedBoundaries: { willDo: ['Keep the tracker current.'], willNotDo: [], escalationTriggers: [] },
  namedCollaborators: [],
  namedSystems: [],
  priorityReading: [],
  adjacentRoles: [],
  approvalChain: { boss: 'Manager', confidence: 'high' },
  openQuestions: [],
  createdAt: '2026-09-03T02:00:00.000Z',
};

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'tracker',
  externalId: 'T-2',
  title: 'Refresh the dashboard tile',
  contentSummary: '',
  contentRefs: ['ticket://T-2'],
  observedAt: new Date('2026-09-03T01:59:00.000Z'),
  priority: 'P3',
  requesterLabel: 'Manager',
};

const now = Date.parse('2026-09-03T02:00:00.000Z');

const surfaces: SurfaceRecord[] = [
  {
    slug: 'dashboard-tile',
    displayName: 'Dashboard tile',
    class: 'analytics',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now - 60_000,
    path: 'browser-driven',
    endpoint: 'http://tile.internal/',
  },
  {
    slug: 'crm',
    displayName: 'Customer records',
    class: 'crm',
    verdict: 'absent',
    credentialLanded: false,
  },
];

const documents = {
  howToGuides: [
    {
      slug: 'how-to-refresh-the-tile',
      title: 'How to refresh the dashboard tile',
      body: 'Sign in, set the coverage figure, save, then read the audit line back.',
    },
  ],
  teamDocs: [
    { slug: 'systems', title: 'Systems', body: 'The dashboard tile has a web UI only.' },
  ],
};

describe('plan drafter grounding', (): void => {
  beforeEach((): void => {
    planRecorded.users.length = 0;
    planRecorded.instructions.length = 0;
  });

  it('tells the planner which evidence it plans from', (): void => {
    const prompt = planSystemPrompt(false);
    expect(prompt).toContain('connected');
    expect(prompt).toContain('documentation');
    expect(prompt).toContain('no connected surface');
  });

  it('gives the planner the surfaces with their verdicts and the loaded documentation', async (): Promise<void> => {
    await draftExecutionPlan({
      candidate,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents,
      now,
    });
    expect(planRecorded.users).toHaveLength(1);
    const user = planRecorded.users[0];
    expect(user).toContain('--- Surfaces ---');
    expect(user).toMatch(/dashboard-tile \(Dashboard tile\).*connected.*browser-driven/);
    expect(user).toMatch(/crm \(Customer records\).*absent/);
    expect(user).toContain('--- How-to guides ---');
    expect(user).toContain('Sign in, set the coverage figure, save, then read the audit line back.');
    expect(user).toContain('--- Team docs (read-only context) ---');
    expect(user).toContain('The dashboard tile has a web UI only.');
    expect(user.indexOf('--- Candidate ---')).toBeLessThan(user.indexOf('--- Surfaces ---'));
  });

  it('gives the planner the candidate references and reply target the executor gets', async (): Promise<void> => {
    await draftExecutionPlan({
      candidate: {
        ...candidate,
        contentRefs: ['ticket://T-2', 'https://tracker.internal/T-2'],
        replyTarget: { channel: 'C1', channelName: 'team-asks', threadTs: '1787.0001' },
      },
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents,
      now,
    });
    const user = planRecorded.users[0];
    expect(user).toContain('Refs: ticket://T-2, https://tracker.internal/T-2');
    expect(user).toContain('Reply target: channel C1 (#team-asks), thread_ts 1787.0001');
    expect(user.indexOf('Refs:')).toBeLessThan(user.indexOf('Body:'));
  });

  it('names the owner the provider returned beside the requester, and nothing when it returned none', (): void => {
    const withOwner = planUserPrompt({
      candidate: { ...candidate, owner: 'Ana', requester: 'Manager' },
      charter,
    });
    expect(withOwner).toContain('From: Manager\nOwner: Ana\nTitle: Refresh the dashboard tile');
    expect(planUserPrompt({ candidate, charter })).not.toContain('Owner:');
  });

  it('keeps the prompt as it was when no surfaces or documentation are given', async (): Promise<void> => {
    await draftExecutionPlan({ candidate, charter, autonomousActions: false, surfaceMode: 'mock' });
    const user = planRecorded.users[0];
    expect(user).not.toContain('--- Surfaces ---');
    expect(user).not.toContain('--- Team docs');
    expect(user).not.toContain('--- How-to guides ---');
    expect(user.endsWith('Draft the execution plan now.')).toBe(true);
  });
});

describe('frozen planner text', (): void => {
  // The hosted demo plans in mock mode from the charter and the candidate
  // alone; both halves of that prompt are byte-for-byte what the recorded
  // beds saw.
  it('keeps the mock planner system prompt byte-identical', (): void => {
    expect(planSystemPrompt(false, 'mock')).toMatchInlineSnapshot(`
      "You are an autonomous workplace agent named Day0.
      You have a charter that defines your role + boundaries.
      A candidate piece of work has landed in front of you and Layer-2 evaluation said it is worth claiming.
      Draft a short execution plan. The live action mode below tells you whether later writes need another manager decision.

      Discipline:
        - Stay inside the charter willDo / willNotDo boundaries. If borderline, narrow the plan to the safest interpretation.
        - Describe review and approval according to the live action mode; never assume the supervised mode.
        - 2-5 short concrete steps.
        - Two kinds of evidence may follow the candidate: the surfaces section says which systems are connected and by what path, and the loaded documentation carries the team's procedures, runbooks and facts. Plan the steps a documented procedure prescribes on a connected surface; plan no action on a system with no connected surface and name it as the gap instead. When the documentation or the candidate settles a question, plan the work rather than a step to clarify it.

      Mock comparison mode: every emitted action is held for the manager's literal approval and only applied after that decision."
    `);
  });

  it('keeps the ungrounded planner user prompt byte-identical', (): void => {
    expect(planUserPrompt({ candidate, charter })).toMatchInlineSnapshot(`
      "Role: Operations coordination

      --- Charter boundaries ---
      willDo: Keep the tracker current.
      willNotDo: 
      escalationTriggers: 

      --- Candidate ---
      Source: tracker / ticket-queue
      From: Manager
      Title: Refresh the dashboard tile
      Refs: ticket://T-2
      Body:


      Draft the execution plan now."
    `);
  });
});

describe('charter adjectives are scope, not gates', (): void => {
  const tileRunbook = {
    howToGuides: [
      {
        slug: 'how-to-refresh-the-tile',
        title: 'How to refresh the dashboard tile',
        body: 'Sign in, set the coverage figure to 74%, save, then read back the visible figure and the audit line.',
      },
    ],
    teamDocs: [
      {
        slug: 'queue',
        title: 'Queue',
        body: 'REVOPS-7 - Priority: Medium. Request: refresh the dashboard tile.',
      },
    ],
  };
  const ticket: WorkCandidate = {
    ...candidate,
    externalId: 'REVOPS-7',
    title: 'Refresh the Looker pipeline tile',
    contentSummary: 'Set the pipeline coverage tile to 74% and read the audit line back.',
  };
  const gated = {
    steps: [
      'Open REVOPS-7 in connected Linear to confirm it is owned and prioritized.',
      'Sign in to the tile and set the figure to 74%.',
      'Read back the visible 74% and the audit line.',
    ],
  };

  beforeEach((): void => {
    planRecorded.users.length = 0;
    planRecorded.instructions.length = 0;
    planRecorded.outputs.length = 0;
  });

  it('puts the invariant in the real planner prompt and keeps it out of the mock one', (): void => {
    for (const line of SCOPE_NOT_GATE_PLANNER) {
      expect(planSystemPrompt(false, 'real')).toContain(line);
      expect(planSystemPrompt(true, 'real')).toContain(line);
      expect(planSystemPrompt(false, 'mock')).not.toContain(line);
    }
    expect(planSystemPrompt(false, 'real')).toContain('that sequence is the plan');
  });

  it('derives candidate properties from the charter wording', (): void => {
    const scoped = { ...charter, proposedFunction: 'Handle unblocked, customer-facing tickets.' };
    expect(planPreconditionAudit({ steps: ['Confirm the ticket is customer-facing.'] },
      ticket, tileRunbook, scoped).flagged).toEqual([1]);
  });

  it('keeps charter properties scoped to candidate clauses and respects procedure requests', (): void => {
    const scoped = { ...charter, proposedBoundaries: { ...charter.proposedBoundaries,
      willDo: ['Handle unblocked, customer-facing requests. Read back the visible figure and audit line.'] } };
    const step = { steps: ['Confirm the ticket is customer-facing.'] };
    expect(planPreconditionAudit(step, ticket, tileRunbook, scoped).flagged).toEqual([1]);
    const asking = { ...tileRunbook, howToGuides: [{ ...tileRunbook.howToGuides[0],
      body: 'Confirm the ticket is customer-facing before refreshing the tile.' }] };
    expect(planPreconditionAudit(step, ticket, asking, scoped).flagged).toEqual([]);
    const forbidding = { ...asking, howToGuides: [{ ...asking.howToGuides[0],
      body: 'Never confirm the ticket is customer-facing before refreshing.' }] };
    expect(planPreconditionAudit(step, ticket, forbidding, scoped).flagged).toEqual([1]);
    expect(planPreconditionAudit({ steps: ['Do not confirm the ticket is customer-facing.',
      'Read back the visible 74% and the audit line.', 'Verify the audit line.'] },
      ticket, undefined, scoped).flagged).toEqual([]);
    expect(planPreconditionAudit(step, { ...ticket, title: 'Refresh a customer-facing ticket' },
      undefined, scoped).flagged).toEqual([]);
    expect(planPreconditionAudit(step, ticket, tileRunbook, charter).flagged).toEqual([]);
  });

  it('reads only the words that describe the candidate, never the systems or the work around it', (): void => {
    const runThrough: Charter = {
      ...charter,
      proposedFunction:
        'Own routine revenue operations work from owned, prioritized Linear tickets for the RevOps team.',
      proposedBoundaries: {
        ...charter.proposedBoundaries,
        willDo: ['Handle owned, prioritized Linear tickets in the Q3 close project.'],
      },
      namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'day-1 1:1' }],
    };
    const linearTicket = { ...ticket, sourceSystem: 'linear' };
    const plan = {
      steps: [
        'Confirm the originating Linear issue ID with the manager.',
        'After approval, post the comment on the confirmed Linear issue, move it to Done, and add an audit note.',
        'Ensure the Q3 close project ticket is moved to Done.',
        'Verify the revenue figure matches the standup deals.',
        'Confirm the RevOps team was told.',
        'Confirm it is owned and prioritized.',
      ],
    };
    expect(planPreconditionAudit(plan, linearTicket, undefined, runThrough).flagged).toEqual([6]);
    const unnamed = { ...runThrough, namedSystems: [] };
    expect(planPreconditionAudit(plan, linearTicket, undefined, unnamed).flagged).toEqual([6]);
    expect(planPreconditionAudit(plan, ticket, undefined, unnamed).flagged).toEqual([1, 2, 6]);
  });

  it('joins premodifiers across commas, and, hyphens and lines, and keeps the floor without a class word', (): void => {
    const scoped = {
      ...charter,
      proposedFunction: 'Handle unblocked and customer-facing\nrequests, plus stale ones.',
    };
    expect(planPreconditionAudit({ steps: ['Check the ticket is unblocked.'] }, ticket, undefined, scoped).flagged).toEqual([1]);
    expect(planPreconditionAudit({ steps: ['Check the ticket is customer facing.'] }, ticket, undefined, scoped).flagged).toEqual([1]);
    expect(planPreconditionAudit({ steps: ['Verify the tile is stale.'] }, ticket, undefined, scoped).flagged).toEqual([1]);
    const wordless = { ...charter, proposedFunction: 'Keep the close moving.' };
    expect(planPreconditionAudit(gated, ticket, undefined, wordless).flagged).toEqual([1]);
  });

  it('repairs a charter-derived gate through the real planner', async (): Promise<void> => {
    const drafted = { summary: 'Refresh the tile.', steps: ['Confirm the ticket is customer-facing.',
      'Refresh the tile.'], expectedOutputType: 'ticket-update', riskNotes: '',
      reversibility: 'reversible', estimatedMinutes: 5 };
    planRecorded.outputs.push(drafted, drafted);
    const result = await draftExecutionPlan({ candidate: ticket,
      charter: { ...charter, proposedFunction: 'Handle unblocked, customer-facing tickets.' },
      autonomousActions: false, surfaceMode: 'real', documents: tileRunbook });
    expect(planRecorded.users).toHaveLength(2);
    expect(result.advisorySteps).toEqual([1]);
  });

  it('flags a verification step when the candidate and the runbook say nothing about the property', (): void => {
    const audit = planPreconditionAudit(gated, ticket, tileRunbook);
    expect(audit.flagged).toEqual([1]);
    expect(audit.issues).toHaveLength(1);
    expect(audit.issues[0]).toContain("step 1 checks the candidate's ownership");
    expect(audit.issues[0]).toContain('adds no verification step');
  });

  it('does not flag it when a loaded procedure asks for the check', (): void => {
    const asking = {
      ...tileRunbook,
      howToGuides: [
        {
          ...tileRunbook.howToGuides[0]!,
          body: `${tileRunbook.howToGuides[0]!.body}\nCheck the ticket is assigned before touching the tile.`,
        },
      ],
    };
    expect(planPreconditionAudit(gated, ticket, asking).flagged).toEqual([]);
    // A procedure that merely mentions the word does not ask for a check.
    const mentioning = {
      ...tileRunbook,
      teamDocs: [
        { slug: 'onboarding', title: 'Onboarding', body: 'Raise unclear ownership in the manager DM.' },
      ],
    };
    expect(planPreconditionAudit(gated, ticket, mentioning).flagged).toEqual([1]);
  });

  it('reads a procedure line that forbids the check as asking for nothing', (): void => {
    const forbidding = {
      ...tileRunbook,
      howToGuides: [
        {
          ...tileRunbook.howToGuides[0]!,
          body: `${tileRunbook.howToGuides[0]!.body}\nNever check the assignee before refreshing the tile; the figure is the whole job.`,
        },
      ],
    };
    expect(planPreconditionAudit(gated, ticket, forbidding).flagged).toEqual([1]);
    const withoutFirst = {
      ...tileRunbook,
      teamDocs: [
        {
          slug: 'queue-policy',
          title: 'Queue policy',
          body: 'Refresh the tile without first confirming the owner: ownership is settled at plan approval.',
        },
      ],
    };
    expect(planPreconditionAudit(gated, ticket, withoutFirst).flagged).toEqual([1]);
    // A genuine ask with a negation elsewhere on the line still counts.
    const askingFirmly = {
      ...tileRunbook,
      howToGuides: [
        {
          ...tileRunbook.howToGuides[0]!,
          body: `${tileRunbook.howToGuides[0]!.body}\nCheck the ticket is assigned before touching the tile, and do not skip this.`,
        },
      ],
    };
    expect(planPreconditionAudit(gated, ticket, askingFirmly).flagged).toEqual([]);
  });

  it('does not flag it when the candidate itself is about the property', (): void => {
    const ownershipTicket: WorkCandidate = {
      ...ticket,
      title: 'Reconcile Northstar CRM ownership',
      contentSummary: 'Inspect the CRM for the owner of the opportunity and add the owner to the issue.',
    };
    expect(
      planPreconditionAudit(
        { steps: ['Confirm the current owner in the CRM.', 'Add the owner to the issue.'] },
        ownershipTicket,
        tileRunbook,
      ).flagged,
    ).toEqual([]);
  });

  it('never flags a read-back or a step with no verification verb', (): void => {
    expect(
      planPreconditionAudit(
        {
          steps: [
            'Read back the visible 74% and the audit line.',
            'Comment on the ticket with the priority of the refresh.',
            'Verify the audit line appears under the tile.',
            'Check the figure reads 74%.',
          ],
        },
        ticket,
        tileRunbook,
      ).flagged,
    ).toEqual([]);
    expect(planPreconditionAudit(gated, ticket, undefined).flagged).toEqual([1]);
  });

  it('asks the planner once for a plan without the gate, then keeps a stubborn step as advisory', async (): Promise<void> => {
    const gatedPlan = {
      summary: 'Confirm, then refresh.',
      steps: gated.steps,
      expectedOutputType: 'ticket-update',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 5,
    };
    const cleanPlan = {
      ...gatedPlan,
      summary: 'Refresh the tile.',
      steps: gated.steps.slice(1),
      riskNotes: 'REVOPS-7 shows no assignee; the manager may want to assign it.',
    };
    planRecorded.outputs.push(gatedPlan, cleanPlan);
    const repaired = await draftExecutionPlan({
      candidate: ticket,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents: tileRunbook,
      now,
    });
    expect(planRecorded.users).toHaveLength(2);
    const correction = planRecorded.users[1]!.split('--- Required plan correction ---')[1]!;
    expect(correction).toContain("step 1 checks the candidate's ownership");
    expect(correction).toContain('Previous plan:');
    expect(correction).toContain('Draft the corrected execution plan now.');
    expect(repaired.steps).toEqual(gated.steps.slice(1));
    expect(repaired.advisorySteps).toBeUndefined();
    expect(repaired.riskNotes).toContain('no assignee');

    planRecorded.users.length = 0;
    planRecorded.outputs.push(gatedPlan, gatedPlan);
    const stubborn = await draftExecutionPlan({
      candidate: ticket,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents: tileRunbook,
      now,
    });
    expect(planRecorded.users).toHaveLength(2);
    expect(stubborn.steps).toEqual(gated.steps);
    expect(stubborn.advisorySteps).toEqual([1]);
  });

  it('runs no audit in mock mode', async (): Promise<void> => {
    planRecorded.outputs.push({
      summary: 'Confirm, then refresh.',
      steps: gated.steps,
      expectedOutputType: 'ticket-update',
      riskNotes: '',
      reversibility: 'reversible',
      estimatedMinutes: 5,
    });
    const plan = await draftExecutionPlan({
      candidate: ticket,
      charter,
      autonomousActions: false,
      surfaceMode: 'mock',
    });
    expect(planRecorded.users).toHaveLength(1);
    expect(plan.steps).toEqual(gated.steps);
    expect(plan.advisorySteps).toBeUndefined();
  });
});

describe('the candidate record read before the plan', (): void => {
  const linear: SurfaceRecord = {
    slug: 'linear',
    displayName: 'Linear',
    class: 'kanban',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now - 60_000,
    path: 'mcp',
    endpoint: 'https://mcp.linear.app/mcp',
    toolAllowlist: ['save_comment', 'save_issue', 'get_issue'],
    toolArguments: [
      { tool: 'get_issue', arguments: ['id', 'includeRelations'] },
      { tool: 'save_comment', arguments: ['issueId', 'body'] },
    ],
  };
  const ticket: WorkCandidate = {
    ...candidate,
    sourceSystem: 'linear',
    externalId: 'REVOPS-7',
    contentRefs: ['ticket://REVOPS-7'],
  };

  beforeEach((): void => {
    planRecorded.users.length = 0;
    planRecorded.outputs.length = 0;
  });

  it('reads a ticket-queue candidate with the documented single-record tool under its probed id argument', (): void => {
    expect(candidateRecordRead(ticket, [linear], now)).toEqual({
      surface: 'linear',
      tool: 'get_issue',
      subject: 'record',
      action: {
        tool: 'mcp.call',
        args: { surface: 'linear', tool: 'get_issue', toolArgsJson: '{"id":"REVOPS-7"}' },
      },
    });
    const issueIdOnly: SurfaceRecord = {
      ...linear,
      toolArguments: [{ tool: 'get_issue', arguments: ['issueId'] }],
    };
    expect(candidateRecordRead(ticket, [issueIdOnly], now)?.action.args.toolArgsJson).toBe(
      '{"issueId":"REVOPS-7"}',
    );
    const unprobed: SurfaceRecord = { ...linear, toolArguments: undefined };
    expect(candidateRecordRead(ticket, [unprobed], now)?.action.args.toolArgsJson).toBe(
      '{"id":"REVOPS-7"}',
    );
    const fetchTicket: SurfaceRecord = {
      ...linear,
      toolAllowlist: ['fetch_ticket', 'save_comment'],
      toolArguments: [{ tool: 'fetch_ticket', arguments: ['key'] }],
    };
    expect(candidateRecordRead(ticket, [fetchTicket], now)).toMatchObject({
      tool: 'fetch_ticket',
      action: { args: { toolArgsJson: '{"key":"REVOPS-7"}' } },
    });
  });

  const slack: SurfaceRecord = {
    slug: 'slack',
    displayName: 'Slack',
    class: 'chat',
    verdict: 'connected',
    credentialLanded: true,
    lastVerifiedAt: now - 60_000,
    path: 'documented-api',
    endpoint: 'https://slack.com/api/',
    toolAllowlist: ['chat.postMessage', 'conversations.history', 'conversations.replies'],
  };
  const mention: WorkCandidate = {
    ...candidate,
    sourceCategory: 'event-stream',
    sourceSystem: 'slack',
    externalId: 'C0PUBLIC:1787746453.202809',
    title: 'Slack mention in #revops-asks',
    contentRefs: ['https://app.slack.com/client/T0/C0PUBLIC/thread/C0PUBLIC-1787746453202809'],
    replyTarget: { channel: 'C0PUBLIC', channelName: 'revops-asks', threadTs: '1787746453.202809' },
  };

  it('reads a chat ask\'s thread with the documented thread tool, bounded, under the surface credential', (): void => {
    expect(candidateRecordRead(mention, [linear, slack], now)).toEqual({
      surface: 'slack',
      tool: 'conversations.replies',
      subject: 'thread',
      action: {
        tool: 'http.request',
        args: {
          surface: 'slack',
          method: 'GET',
          path: `/conversations.replies?channel=C0PUBLIC&ts=1787746453.202809&inclusive=true&limit=${THREAD_READ_LIMIT}`,
          headersJson: '{"Authorization":"Bearer {{secret}}"}',
        },
      },
    });
    // A thread that was itself a reply reads from its parent, where the ask's thread lives.
    const threaded = { ...mention, replyTarget: { ...mention.replyTarget!, threadTs: '1787746000.000100' } };
    expect(candidateRecordRead(threaded, [slack], now)?.action.args.path).toContain('ts=1787746000.000100');
    // Only the history tool allowed: the channel up to the ask, same bound.
    const historyOnly: SurfaceRecord = { ...slack, toolAllowlist: ['chat.postMessage', 'conversations.history'] };
    expect(candidateRecordRead(mention, [historyOnly], now)).toMatchObject({
      tool: 'conversations.history',
      subject: 'thread',
      action: {
        args: {
          method: 'GET',
          path: `/conversations.history?channel=C0PUBLIC&latest=1787746453.202809&inclusive=true&limit=${THREAD_READ_LIMIT}`,
        },
      },
    });
  });

  it('reads no thread when the chat surface documents no history tool, is not a documented API, is disconnected, or the ask has no thread', (): void => {
    expect(candidateRecordRead(mention, [{ ...slack, toolAllowlist: ['chat.postMessage'] }], now)).toBeUndefined();
    expect(candidateRecordRead(mention, [{ ...slack, path: 'browser-driven' }], now)).toBeUndefined();
    expect(candidateRecordRead(mention, [{ ...slack, verdict: 'absent' }], now)).toBeUndefined();
    expect(candidateRecordRead({ ...mention, replyTarget: undefined }, [slack], now)).toBeUndefined();
    expect(candidateRecordRead(mention, [linear], now)).toBeUndefined();
  });

  it('carries the thread in the plan prompt, named as a thread, after the candidate', (): void => {
    const user = planUserPrompt({
      candidate: mention,
      charter,
      surfaces: [slack],
      record: {
        surface: 'slack',
        tool: 'conversations.replies',
        subject: 'thread',
        text: 'HTTP 200 · {"ok":true,"messages":[{"ts":"1787746453.202809","text":"<@U0DAY0> are the three deals covered?"}]}',
      },
      now,
    });
    expect(user).toContain('--- Candidate thread, read from slack (conversations.replies) ---');
    expect(user).toContain('are the three deals covered?');
    expect(user.indexOf('--- Candidate ---')).toBeLessThan(user.indexOf('--- Candidate thread'));
    expect(user.indexOf('--- Candidate thread')).toBeLessThan(user.indexOf('--- Surfaces ---'));
    expect(
      renderCandidateRecord({
        surface: 'slack', tool: 'conversations.replies', subject: 'thread', unavailable: 'no grant (slack:read)',
      }).join('\n'),
    ).toContain('thread unavailable: no grant (slack:read)');
  });

  it('reads nothing for an inbox ask, a browser surface, a disconnected surface or a surface with no record tool', (): void => {
    expect(
      candidateRecordRead(
        { ...ticket, sourceCategory: 'inbox', sourceSystem: 'slack' },
        [linear, { ...linear, slug: 'slack', displayName: 'Slack', class: 'chat' }],
        now,
      ),
    ).toBeUndefined();
    expect(candidateRecordRead(ticket, [{ ...linear, path: 'browser-driven' }], now)).toBeUndefined();
    expect(candidateRecordRead(ticket, [{ ...linear, verdict: 'absent' }], now)).toBeUndefined();
    expect(
      candidateRecordRead(ticket, [{ ...linear, toolAllowlist: ['save_comment', 'list_issues'] }], now),
    ).toBeUndefined();
    expect(
      candidateRecordRead(
        ticket,
        [{ ...linear, toolArguments: [{ tool: 'get_issue', arguments: ['includeRelations'] }] }],
        now,
      ),
    ).toBeUndefined();
    expect(candidateRecordRead(ticket, [], now)).toBeUndefined();
  });

  it('renders the record after the candidate and before the surfaces, and the plan is still drafted when it is unavailable', async (): Promise<void> => {
    await draftExecutionPlan({
      candidate: ticket,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents,
      record: {
        surface: 'linear',
        tool: 'get_issue',
        subject: 'record',
        text: 'get_issue on linear · {"identifier":"REVOPS-7","state":"Todo","description":""}',
      },
      now,
    });
    const user = planRecorded.users[0]!;
    expect(user).toContain('--- Candidate record, read from linear (get_issue) ---');
    expect(user).toContain('"identifier":"REVOPS-7","state":"Todo"');
    expect(user.indexOf('--- Candidate ---')).toBeLessThan(user.indexOf('--- Candidate record'));
    expect(user.indexOf('--- Candidate record')).toBeLessThan(user.indexOf('--- Surfaces ---'));

    planRecorded.users.length = 0;
    const plan = await draftExecutionPlan({
      candidate: ticket,
      charter,
      autonomousActions: false,
      surfaceMode: 'real',
      surfaces,
      documents,
      record: {
        surface: 'linear',
        tool: 'get_issue',
        subject: 'record',
        unavailable: 'Tool input validation failed: unknown argument issueId',
      },
      now,
    });
    expect(planRecorded.users[0]).toContain(
      'record unavailable: Tool input validation failed: unknown argument issueId',
    );
    expect(plan.steps).toHaveLength(2);
    expect(planUserPrompt({ candidate: ticket, charter })).not.toContain('Candidate record');
  });

  it('redacts the record with the span model when it is read, applies the floor when rendered, and bounds it', async (): Promise<void> => {
    const text = [
      'get_issue on linear · {"identifier":"REVOPS-7",',
      '"description":"api token: lin_api_0123456789abcdefghijklmnopqrstuvwxyz\nservice password: Zq9!vT2#kL8mNp4rXs7wYb3e"}',
    ].join('');
    const read = await redactCandidateRecordText(text, new RecordedSpanModel());
    expect(read.redaction).toBeUndefined();
    expect(read.text).not.toContain('lin_api_0123456789');
    expect(read.text).not.toContain('Zq9!vT2#kL8mNp4rXs7wYb3e');
    expect(read.text).toContain('"identifier":"REVOPS-7"');
    // Without a model the read still loses the provider token to the structural
    // floor and says only that floor ran.
    const floor = await redactCandidateRecordText(text);
    expect(floor.redaction).toBe('structural-only');
    expect(floor.text).not.toContain('lin_api_0123456789');
    const rendered = renderCandidateRecord({ surface: 'linear', tool: 'get_issue', subject: 'record', text: read.text }).join('\n');
    expect(rendered).not.toContain('Zq9!vT2#kL8mNp4rXs7wYb3e');
    expect(rendered).toContain('"identifier":"REVOPS-7"');
    const long = renderCandidateRecord({
      surface: 'linear',
      tool: 'get_issue',
      subject: 'record',
      text: 'x'.repeat(CANDIDATE_RECORD_LENGTH + 500),
    }).join('\n');
    expect(long.length).toBeLessThan(CANDIDATE_RECORD_LENGTH + 100);
    expect(long.endsWith('…')).toBe(true);
    expect(
      renderCandidateRecord({
        surface: 'linear',
        tool: 'get_issue',
        subject: 'record',
        unavailable: 'refused: Bearer lin_api_0123456789abcdefghijklmnop was rejected',
      }).join('\n'),
    ).not.toContain('lin_api_0123456789');
  });
});


describe('serialized candidate record credentials', () => {
  it.each(['text', 'unavailable'] as const)('redacts escaped description lines in %s', async (field) => {
    const password = 'Zq9!vT2#kL8mNp4rXs7wYb3e';
    const body = `get_issue on linear · ${JSON.stringify({
      identifier: 'REVOPS-7',
      description: `Refresh the tile.\nService password: ${password}`,
    })}`;
    const redacted = (await redactCandidateRecordText(body, new RecordedSpanModel())).text;
    const record = field === 'text'
      ? { surface: 'linear', tool: 'get_issue', subject: 'record' as const, text: redacted }
      : { surface: 'linear', tool: 'get_issue', subject: 'record' as const, unavailable: redacted };
    const prompt = renderCandidateRecord(record).join('\n');
    expect(prompt).not.toContain(password);
    expect(prompt).toContain('REVOPS-7');
    expect(prompt).toContain('Service password: <redacted>');
  });
});


describe('negative precondition instructions', () => {
  it.each([
    'Do not verify ownership before refreshing the tile.',
    'Never check assignment or priority as a prerequisite.',
    'Do not confirm the owner; follow the tile runbook.',
  ])('does not repair a plan that forbids an invented gate: %s', async (step) => {
    planRecorded.users.length = 0;
    planRecorded.outputs.length = 0;
    planRecorded.outputs.push({
      summary: 'Refresh the tile.', steps: [step, 'Read back the 74% figure and audit line.'],
      expectedOutputType: 'ticket-update', riskNotes: '', reversibility: '', estimatedMinutes: 2,
    });
    const result = await draftExecutionPlan({
      candidate, charter, autonomousActions: false, surfaceMode: 'real',
    });
    expect(result.steps[0]).toBe(step);
    expect(planRecorded.users).toHaveLength(1);
    expect(result.advisorySteps).toBeUndefined();
  });
});


describe('bounded plan correction failure', () => {
  it('keeps the initial plan advisory when the optional correction request fails', async () => {
    planRecorded.users.length = 0;
    planRecorded.outputs.length = 0;
    const initial = {
      summary: 'Refresh the tile.',
      steps: ['Confirm the ticket is owned.', 'Refresh the tile and read back the audit line.'],
      expectedOutputType: 'ticket-update', riskNotes: '', reversibility: '', estimatedMinutes: 2,
    };
    planRecorded.outputs.push(initial, new Error('Correction request unavailable'));
    await expect(draftExecutionPlan({
      candidate, charter, autonomousActions: false, surfaceMode: 'real',
    })).resolves.toEqual({ ...initial, advisorySteps: [1] });
    expect(planRecorded.users).toHaveLength(2);
  });
});
