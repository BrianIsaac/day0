/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The whole dashboard rendered in a document with every panel populated, in
 * real mode, and checked with axe (step 45's gate, N14). The seams are the
 * Convex hooks: each query answers from the fixtures below, by function name.
 */
const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import type { Doc } from '../../../../convex/_generated/dataModel';
import { AgentDashboard } from '../../../../app/agent/[agentId]/AgentDashboard';
import { dashboardMetrics } from '../../../fixtures/dashboard/metrics';
import { axeViolations } from '../../../fixtures/dom/axe';
import { mount, settle } from '../../../fixtures/dom/press';
import { openQuestionStopReason } from '../../../../src/work/obligations';

const agentId = 'agent-1' as Doc<'agents'>['_id'];

const dm = {
  tool: 'http.request',
  args: {
    surface: 'slack',
    method: 'POST',
    path: '/chat.postMessage',
    headersJson: '{"Authorization":"Bearer {{secret}}"}',
    body: JSON.stringify({ channel: 'D0MANAGER', text: 'Draft ready.' }),
  },
};

const plan = {
  summary: 'Comment then close.',
  steps: ['comment', 'close'],
  expectedOutputType: 'ticket-update',
  riskNotes: 'Check the owner first.',
  reversibility: 'reversible',
  estimatedMinutes: 5,
};

const item = (id: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  _id: id,
  _creationTime: 1,
  agentId,
  title: `Item ${id}`,
  contentSummary: 'Post the close summary.',
  sourceSystem: 'linear',
  sourceCategory: 'ticket-queue',
  externalId: id,
  observedAt: 1,
  contentRefs: [],
  createdAt: 1,
  ...fields,
});

const question = 'Which template should the notice use?';

/** A populated real-mode dashboard: every card state a manager decides on. */
function populated(): Record<string, unknown> {
  return {
    'agents:get': {
      _id: agentId,
      _creationTime: 1,
      bossEmail: 'boss@day0.local',
      name: 'Priya',
      userId: 'owner',
      state: 'active',
      zone: 'Europe/London',
      createdAt: 1,
    },
    'charters:latest': {
      _id: 'charter-1',
      _creationTime: 1,
      agentId,
      version: '0.2',
      approved: true,
      approvedAt: 1,
      createdAt: 1,
      body: {
        whyThisHire: 'Close week.',
        proposedFunction: 'Own routine revenue operations work from Linear tickets.',
        shortTermGoals: { day30: 'Learn the runbooks', day60: 'Own the weekly', day90: 'Close' },
        proposedBoundaries: {
          willDo: ['Handle Linear tickets in the close project.'],
          willNotDo: ['Touch payroll.'],
          escalationTriggers: [],
        },
        namedCollaborators: [],
        namedSystems: [{ name: 'Linear', class: 'kanban', whereMentioned: 'Work is in Linear.' }],
        priorityReading: [],
        openQuestions: ['Whether Northstar CRM access will be granted.'],
        constraints: [
          {
            kind: 'candidate-property',
            quote: 'only the close tickets',
            wording: ['close tickets'],
            origin: 'manager-said',
          },
        ],
      },
    },
    'charters:listForAgent': [],
    'workspace:read': { 'AGENTS.md': '# Priya\nRevOps.' },
    'work:listForAgent': [
      item('w-plan', { state: 'plan-pending', plan, planPendingAt: 1 }),
      item('w-held', {
        state: 'actions-pending',
        plan,
        pendingRunId: 'run-1',
        output: { draft: 'd', notes: '', actions: [dm] },
        actionVerdicts: [{ disposition: 'held', reason: 'system-of-record mutation held' }],
      }),
      item('w-unknown', {
        state: 'failed',
        plan,
        skipReason: 'a write may have landed',
        output: {
          draft: 'd',
          notes: '',
          actions: [dm],
          applied: [
            {
              tool: 'http.request',
              ok: false,
              outcomeUnknown: true,
              reason: 'socket closed after the request',
              idempotencyKey: 'w-unknown:run:0',
            },
          ],
        },
      }),
      item('w-question', {
        state: 'failed',
        plan,
        skipReason: `stopped: ${openQuestionStopReason({ question, steps: [2] })}`,
        output: {
          draft: '',
          notes: '',
          actions: [],
          applied: [],
          openQuestion: { question, steps: [2] },
        },
      }),
      item('w-skipped', {
        state: 'skipped',
        verdict: { decision: 'skip', reason: 'already-claimed: state=executing' },
      }),
      item('w-done', { state: 'completed', plan, output: { draft: 'd', notes: '', actions: [] } }),
    ],
    'managerQuestions:openForAgent': [],
    'skills:proposed': [
      {
        _id: 'skill-p',
        _creationTime: 1,
        agentId,
        name: 'close-summary',
        description: 'Post the close summary.',
        state: 'proposed',
        sourceType: 'agent-authored',
        requiredScopes: ['linear:write'],
        createdAt: 1,
      },
    ],
    'skills:registered': [
      {
        _id: 'skill-r',
        _creationTime: 1,
        agentId,
        name: 'update-linear-ticket',
        description: 'Comment on and close a ticket.',
        body: '# Update\n## Inputs\n- ticket: the ticket',
        state: 'registered',
        sourceType: 'agent-authored',
        createdAt: 1,
      },
    ],
    'skills:awaitingVerification': [],
    'skills:verificationFailed': [
      {
        _id: 'skill-f',
        _creationTime: 1,
        agentId,
        name: 'refresh-the-tile',
        description: 'Refresh the tile.',
        state: 'failed',
        sourceType: 'agent-authored',
        body: '',
        verificationLog:
          'smoke test exited 1\nTraceback (most recent call last):\n  File "smoke.py"',
        createdAt: 1,
      },
    ],
    'events:recent': [
      {
        _id: 'e1',
        _creationTime: 1,
        agentId,
        type: 'work.discovered',
        payload: { workItemId: 'w-plan' },
        createdAt: 1,
      },
    ],
    'metrics:forAgent': dashboardMetrics(),
    'voice:latest': null,
    'config:surfaceMode': { mode: 'real', label: 'real mode' },
    'config:components': { browser: false },
    'surfaces:listForAgent': [
      {
        _id: 'surface-slack',
        _creationTime: 1,
        agentId,
        slug: 'slack',
        displayName: 'Slack',
        class: 'chat',
        verdict: 'connected',
        path: 'documented-api',
        endpoint: 'https://slack.com/api/',
        managerDmChannelId: 'D0MANAGER',
        managerUserId: 'U0MANAGER',
        credentialLanded: true,
        lastVerifiedAt: Date.now(),
        whereFound: [],
        createdAt: 1,
      },
    ],
    'surfaces:installRedirectConfigured': false,
    'corrections:listForAgent': [
      {
        _id: 'c1',
        workItemId: 'w-done',
        kind: 'retry-note',
        text: 'Use the Delay notice B template.',
        itemTitle: 'Item w-done',
        createdAt: 1,
        appliedTo: [],
      },
    ],
    'events:autonomyChanges': [],
    'agents:permissionScopes': [
      { scope: 'linear:write', active: true, source: 'deploy' },
      { scope: 'slack:write', active: false, source: 'manager' },
    ],
    'docSources:pagesForAgent': [],
    'docSources:byIds': [],
  };
}

afterEach((): void => {
  backend.queries = {};
  // A test that failed before its unmount leaves its tree, and a second
  // <main> would fail the next test's landmark rules.
  document.body.replaceChildren();
});

/** The environment panel is its own chunk; under a full suite it can take seconds to arrive. */
const CHUNK_WAIT = { timeout: 15_000 };

describe('the dashboard against the accessibility floor (N14, step 45)', (): void => {
  it('has no axe violation at the WCAG 2.2 AA tags and best practice with every panel populated', async (): Promise<void> => {
    backend.queries = populated();
    const view = mount(<AgentDashboard agentId={agentId} />);
    await settle();
    expect(view.container.textContent).toContain('Item w-plan');
    // The environment panel is its own chunk: wait for it, so its tabs are checked too.
    await vi.waitFor((): void => {
      expect(view.container.textContent).toContain('Enterprise context');
    }, CHUNK_WAIT);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    // Every disclosure open: the drafts, logs and payloads inside are checked
    // too, and every scroll region among them has a name of its own.
    for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
    await settle();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  }, 30_000);

  it('has no axe violation while every query is still loading', async (): Promise<void> => {
    backend.queries = { 'agents:get': populated()['agents:get'] };
    const view = mount(<AgentDashboard agentId={agentId} />);
    await settle();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  });
});

/**
 * The controls of a rendered tree whose own box, or the label wrapping them,
 * is not at least 44 px tall by class: jsdom lays nothing out, so the class is
 * what can be read here, and the browser job measures the public pages.
 */
function underTarget(root: Element): string[] {
  // `min-h-11` or `h-11` only: padding alone gives 40 px on a `text-xs` line.
  const tall = /(^|\s)(min-h-11|h-11)(\s|$)/;
  return [...root.querySelectorAll('button, input, select, textarea, summary')]
    .filter((control) => (control as HTMLInputElement).type !== 'hidden')
    .filter(
      (control) =>
        !tall.test(control.getAttribute('class') ?? '') &&
        !tall.test(control.closest('label')?.getAttribute('class') ?? ''),
    )
    .map(
      (control) =>
        `${control.tagName.toLowerCase()} "${(control.getAttribute('aria-label') ?? control.textContent ?? '').trim().slice(0, 60)}"`,
    );
}

describe("the dashboard's pointer targets (N14: 44 by 44 CSS pixels)", (): void => {
  it('gives every control of the populated dashboard a 44 px target, the environment panel included', async (): Promise<void> => {
    backend.queries = populated();
    const view = mount(<AgentDashboard agentId={agentId} />);
    await settle();
    await vi.waitFor((): void => {
      expect(view.container.textContent).toContain('Enterprise context');
    }, CHUNK_WAIT);
    for (const summary of view.container.querySelectorAll('details')) summary.open = true;
    await settle();
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);
});

describe('the dashboard before the charter (N14: 44 by 44 CSS pixels)', (): void => {
  it('gives the 1:1 mode picker 44 px targets and no axe violation', async (): Promise<void> => {
    backend.queries = {
      'agents:get': { ...(populated()['agents:get'] as object), state: 'deployed' },
      'charters:latest': null,
      'config:surfaceMode': { mode: 'mock', label: 'mock mode' },
    };
    const view = mount(<AgentDashboard agentId={agentId} />);
    await settle();
    await vi.waitFor((): void => {
      expect(view.container.textContent).toContain('Chat');
    }, CHUNK_WAIT);
    expect(underTarget(view.container)).toEqual([]);
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  }, 30_000);
});

describe('the axe check itself', (): void => {
  it('finds what it is there to find: an unnamed button and an unlabelled field', async (): Promise<void> => {
    const view = mount(
      <main>
        <button type="button" />
        <input type="text" />
      </main>,
    );
    const found = (await axeViolations(view.container)).map((violation) => violation.id);
    expect(found).toEqual(expect.arrayContaining(['button-name', 'label']));
    view.unmount();
  });
});
