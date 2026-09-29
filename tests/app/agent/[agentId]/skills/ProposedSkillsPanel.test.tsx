/** @vitest-environment jsdom */

import { act } from 'react';
import { getFunctionName } from 'convex/server';
import { describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { ProposedSkillsPanel } from '../../../../../app/agent/[agentId]/skills/ProposedSkillsPanel';
import { focusedName, mount, press, said, settle } from '../../../../fixtures/dom/press';

const backend = vi.hoisted(() => ({
  /** Mutations and actions that reject, by function name, with the text they reject with. */
  refusals: {} as Record<string, string>,
  /** What a mutation or action resolves with, by function name; undefined otherwise. */
  results: {} as Record<string, unknown>,
  /** Every call made, by function name, with its arguments. */
  calls: [] as Array<{ name: string; args: unknown }>,
  /** What a query answers, by function name; undefined (loading) otherwise. */
  queries: {} as Record<string, unknown>,
}));

vi.mock('convex/react', () => {
  const call =
    (reference: unknown): ((args?: unknown) => Promise<unknown>) =>
    async (args?: unknown): Promise<unknown> => {
      const name = getFunctionName(reference as never);
      backend.calls.push({ name, args });
      const refusal = backend.refusals[name];
      if (refusal !== undefined) throw new Error(refusal);
      return backend.results[name];
    };
  return {
    useQuery: (reference: unknown): unknown => backend.queries[getFunctionName(reference as never)],
    useMutation: call,
    useAction: call,
  };
});

describe('ProposedSkillsPanel', (): void => {
  const noop = (): void => undefined;
  const base = {
    _id: 'skill-1',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'refresh-the-tile',
    description: 'refresh the analytics tile',
    sourceType: 'agent-authored',
    createdAt: 0,
  };

  /** What a production deployment sends for a plain `Error` thrown in the action: the envelope alone. */
  const REDACTED_AUTHORING =
    '[CONVEX A(skillActions:authorAndRegisterSkill)] [Request ID: 7f3a] Server Error';

  it('files an approved authoring the production backend redacted as a sentence, never the envelope', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.refusals = { 'skillActions:authorAndRegisterSkill': REDACTED_AUTHORING };
    const attempts: unknown[] = [];
    const view = mount(
      <ProposedSkillsPanel
        name="Mira"
        itemTitles={new Map()}
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Approve · author and verify');
    await settle();
    expect(attempts).toEqual([
      null,
      { skillId: 'skill-1', name: 'refresh-the-tile', reason: 'authoring did not finish' },
    ]);
    view.unmount();
    backend.refusals = {};
  });

  it("says a refused Approve in the panel's live region in the words written for a person, and files no authoring attempt", async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.refusals = {
      'skills:approve': `[CONVEX M(skills:approve)] [Request ID: 1] Server Error\nUncaught Error: cannot approve "refresh-the-tile": it is approved, not proposed\n    at handler (../convex/skills.ts:1:1)`,
    };
    const attempts: unknown[] = [];
    const view = mount(
      <ProposedSkillsPanel
        name="Mira"
        itemTitles={new Map()}
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Approve · author and verify');

    expect(said(view.container)).toEqual([
      'cannot approve "refresh-the-tile": it is approved, not proposed',
    ]);
    expect(attempts).toEqual([]);
    expect(focusedName()).toBe('Approve · author and verify');
    view.unmount();
    backend.refusals = {};
  });

  it('says an approval, then files what the authoring it started came to', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const attempts: unknown[] = [];
    const view = mount(
      <ProposedSkillsPanel
        name="Mira"
        itemTitles={new Map()}
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
      />,
    );
    await press(view.container, 'Approve · author and verify');

    expect(said(view.container)).toEqual([
      'Approved refresh-the-tile: the employee is authoring it now, and the Skills card says when it is callable.',
    ]);
    expect(attempts).toEqual([null, { skillId: 'skill-1', name: 'refresh-the-tile' }]);
    view.unmount();
    backend.results = {};
  });

  it('rejects a proposed skill with an outcome said in the panel (the wave 4 Reject ruling)', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.refusals = {
      'skills:reject': `[CONVEX M(skills:reject)] [Request ID: 1] Server Error\nUncaught Error: cannot reject "refresh-the-tile": it is registered\n    at handler (../convex/skills.ts:1:1)`,
    };
    const refused = mount(
      <ProposedSkillsPanel
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={noop}
        name="Mira"
        itemTitles={new Map()}
      />,
    );
    await press(refused.container, 'Reject refresh-the-tile');
    expect(said(refused.container)).toEqual(['cannot reject "refresh-the-tile": it is registered']);
    expect(focusedName()).toBe('Reject refresh-the-tile');
    refused.unmount();
    backend.refusals = {};

    const rejected = mount(
      <ProposedSkillsPanel
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={noop}
        name="Mira"
        itemTitles={new Map()}
      />,
    );
    await press(rejected.container, 'Reject refresh-the-tile');
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    // The row leaves when the query answers; the panel keeps its live region.
    act((): void =>
      rejected.root.render(
        <ProposedSkillsPanel
          skills={[]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map()}
        />,
      ),
    );
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    rejected.unmount();
  });

  it('names the item that first needs the skill, what approving grants and that it is written for this employee alone', (): void => {
    const proposed = {
      ...base,
      state: 'proposed',
      description: 'Reply in a Slack thread.',
      rationale: 'No registered skill covers a threaded reply.',
      proposedFor: 'item-1',
      requiredScopes: ['slack:read', 'slack:write'],
    } as unknown as Doc<'skills'>;
    const view = mount(
      <ProposedSkillsPanel
        skills={[proposed]}
        surfaces={[]}
        onAuthoringAttempt={noop}
        name="Mira"
        itemTitles={new Map([['item-1', 'Draft response for new tier-two RevOps ask']])}
      />,
    );
    const text = view.container.textContent ?? '';
    expect(view.container.querySelector('h2')?.textContent).toBe('Proposed · waiting on you');
    expect(text).toContain('refresh-the-tile · Reply in a Slack thread');
    expect(text).toContain(
      'First needed by \u201cDraft response for new tier-two RevOps ask\u201d. No registered skill covers a threaded reply.',
    );
    expect([...view.container.querySelectorAll('code')].map((chip) => chip.textContent)).toEqual([
      'slack:read',
      'slack:write',
    ]);
    expect(text).toContain('approving writes this one for Mira alone');
    expect(text).toContain("Whether that work is within Mira's charter is judged separately.");
    for (const control of view.container.querySelectorAll('button')) {
      expect(control.className).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });
});
