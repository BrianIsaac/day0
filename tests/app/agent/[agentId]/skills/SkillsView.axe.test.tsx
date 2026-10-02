/** @vitest-environment jsdom */

import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The Skills tab in its states, checked with axe and for 44 px targets with every disclosure
 * open: a proposal with its adoption row, a proposal that cannot be approved yet, registered
 * skills built in and authored (used N times, Re-check due with its reason, a revision beside the
 * running version), and skills not callable (Attempt n of 3 with Retry with the reasons and Give
 * up, Retry withdrawn at the third), one with its refused line marked.
 */
const backend = vi.hoisted(() => ({ queries: {} as Record<string, unknown> }));

vi.mock('convex/react', () => ({
  useQuery: (reference: unknown, args: unknown): unknown =>
    args === 'skip' ? undefined : backend.queries[getFunctionName(reference as never)],
  useMutation: () => async (): Promise<void> => undefined,
  useAction: () => async (): Promise<void> => undefined,
}));

import { SkillsView } from '../../../../../app/agent/[agentId]/skills/SkillsView';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { mount, settle } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

const agentId = 'agent-1';

const skill = (id: string, fields: Record<string, unknown>): Record<string, unknown> => ({
  _id: id,
  _creationTime: 1,
  agentId,
  name: id,
  description: `Do ${id}.`,
  body: '',
  sourceType: 'agent-authored',
  createdAt: 1,
  ...fields,
});

/** Every state the tab draws. */
function populated(): Record<string, unknown> {
  return {
    'work:listForAgent': [{ _id: 'w1', title: 'Draft response for new tier-two RevOps ask' }],
    'skills:proposed': [
      skill('chat-thread-reply', {
        state: 'proposed',
        proposedFor: 'w1',
        rationale: 'No registered skill covers a threaded reply.',
        requiredScopes: ['slack:read', 'slack:write'],
      }),
      skill('looker-refresh', {
        state: 'proposed',
        targetSurface: 'looker',
        requiredScopes: ['looker:read'],
      }),
    ],
    'skills:registered': [
      skill('see-internal-docs', { state: 'registered', sourceType: 'builtin', registeredAt: 1 }),
      skill('kanban-comment-and-close', {
        state: 'registered',
        registeredAt: 1,
        useCount: 2,
        versionId: 'version-1',
        recheckDueAt: 5,
        recheckReason: 'the tools you approved on linear changed',
        requiredScopes: ['linear:read', 'linear:write'],
        body: '# Close\n\n## Inputs\n\n- `<record-id>`: the ticket.\n',
      }),
      skill('chat-thread-reply', { state: 'registered', registeredAt: 1, useCount: 1 }),
    ],
    'skillControls:pendingRevisions': [
      skill('kanban-comment-and-close-revision', {
        name: 'kanban-comment-and-close',
        state: 'approved',
        revisionOf: 'kanban-comment-and-close',
      }),
    ],
    'skills:awaitingVerification': [
      skill('parked-skill', {
        state: 'authoring',
        body: '# Parked',
        pendingSmokeTest: 'def run(inputs: dict) -> dict:\n    return {}',
        verificationLog: 'the verification sandbox was busy',
      }),
    ],
    'skills:verificationFailed': [
      skill('crm-update-record', {
        state: 'failed',
        authoringAttempts: 3,
        verificationLog: 'the sandbox run refused the draft: smoke test exited 1',
      }),
      skill('analytics-refresh-value', {
        state: 'failed',
        authoringAttempts: 2,
        refusedBody: '# Refresh',
        refusedSmokeTest: 'def run(inputs: dict) -> dict:\n    return {"tile": inputs["tile-id"]',
        verificationLog:
          'smoke test rejected before sandbox: smoke test is not valid Python 3.12 source: its syntax does not parse at line 2, column 12: `    return {"tile": inputs["tile-id"]`',
      }),
    ],
  };
}

afterEach((): void => {
  backend.queries = {};
  document.body.replaceChildren();
});

describe('the Skills tab against the accessibility floor (N14)', (): void => {
  it('has no axe violation and a 44 px target on every control, every disclosure open, in every state', async (): Promise<void> => {
    backend.queries = populated();
    const view = mount(
      asEmployee(<SkillsView />, {
        surfaceMode: 'real',
      }),
    );
    await settle();
    for (const disclosure of view.container.querySelectorAll('details')) disclosure.open = true;
    await settle();
    expect(view.container.textContent).toContain('Cannot approve yet');
    for (const drawn of [
      'Re-check due',
      'Re-check now',
      'used 2 times',
      'Ask for a revision',
      'Retire',
      'Attempt 2 of 3',
      'Retry with the reasons',
      'Attempt 3 of 3',
      'Give up',
      'A revision is being written.',
    ]) {
      expect(view.container.textContent).toContain(drawn);
    }
    expect(view.container.querySelector('mark')).not.toBeNull();
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);

  it('has no axe violation while every query is still loading', async (): Promise<void> => {
    const view = mount(asEmployee(<SkillsView />));
    await settle();
    expect(view.container.textContent).toContain('loading skills…');
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    view.unmount();
  }, 30_000);
});
