/** @vitest-environment jsdom */

import { act, type ReactNode } from 'react';
import { getFunctionName } from 'convex/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Doc } from '../../../../../convex/_generated/dataModel';
import { firstNeededSentence } from '../../../../../src/work/skill-rationale';
import { ProposedSkillsPanel } from '../../../../../app/agent/[agentId]/skills/ProposedSkillsPanel';
import { axeViolations } from '../../../../fixtures/dom/axe';
import { asEmployee } from '../../../../fixtures/dom/employee';
import { focusedName, mount, press, said, settle } from '../../../../fixtures/dom/press';
import { underTarget } from '../../../../fixtures/dom/targets';

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
      asEmployee(
        <ProposedSkillsPanel
          name="Mira"
          itemTitles={new Map()}
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
        />,
      ),
    );
    await press(view.container, 'Approve · author and verify refresh-the-tile');
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
      asEmployee(
        <ProposedSkillsPanel
          name="Mira"
          itemTitles={new Map()}
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
        />,
      ),
    );
    await press(view.container, 'Approve · author and verify refresh-the-tile');

    expect(said(view.container)).toEqual([
      'cannot approve "refresh-the-tile": it is approved, not proposed',
    ]);
    expect(attempts).toEqual([]);
    expect(focusedName()).toBe('Approve · author and verify refresh-the-tile');
    view.unmount();
    backend.refusals = {};
  });

  it('names each Approve by its skill, so two proposals never share one accessible name (round 0141 R-D item 5)', (): void => {
    const first = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    const second = {
      ...base,
      _id: 'skill-2',
      name: 'kanban-comment-and-close',
      state: 'proposed',
      requiredScopes: [],
    } as unknown as Doc<'skills'>;
    const view = mount(
      asEmployee(
        <ProposedSkillsPanel
          name="Mira"
          itemTitles={new Map()}
          skills={[first, second]}
          surfaces={[]}
          onAuthoringAttempt={noop}
        />,
      ),
    );
    const approves = [...view.container.querySelectorAll('button')].filter((candidate) =>
      candidate.textContent?.includes('Approve · author and verify'),
    );
    expect(approves.map((candidate) => candidate.getAttribute('aria-label'))).toEqual([
      'Approve · author and verify refresh-the-tile',
      'Approve · author and verify kanban-comment-and-close',
    ]);
    view.unmount();
  });

  it('says an approval, then files what the authoring it started came to', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    backend.results = { 'skillActions:authorAndRegisterSkill': { ok: true } };
    const attempts: unknown[] = [];
    const view = mount(
      asEmployee(
        <ProposedSkillsPanel
          name="Mira"
          itemTitles={new Map()}
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={(attempt) => void attempts.push(attempt)}
        />,
      ),
    );
    await press(view.container, 'Approve · author and verify refresh-the-tile');

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
      asEmployee(
        <ProposedSkillsPanel
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map()}
        />,
      ),
    );
    await press(refused.container, 'Reject refresh-the-tile');
    expect(said(refused.container)).toEqual(['cannot reject "refresh-the-tile": it is registered']);
    expect(focusedName()).toBe('Reject refresh-the-tile');
    refused.unmount();
    backend.refusals = {};

    const rejected = mount(
      asEmployee(
        <ProposedSkillsPanel
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map()}
        />,
      ),
    );
    await press(rejected.container, 'Reject refresh-the-tile');
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    // The row leaves when the query answers; the panel keeps its live region.
    act((): void =>
      rejected.root.render(
        asEmployee(
          <ProposedSkillsPanel
            skills={[]}
            surfaces={[]}
            onAuthoringAttempt={noop}
            name="Mira"
            itemTitles={new Map()}
          />,
        ),
      ),
    );
    expect(said(rejected.container)).toEqual([
      'Rejected refresh-the-tile: the employee will not author it.',
    ]);
    rejected.unmount();
  });

  it('names the item that first needs the skill and what approving grants', (): void => {
    const proposed = {
      ...base,
      state: 'proposed',
      description: 'Reply in a Slack thread.',
      rationale: 'No registered skill covers a threaded reply.',
      proposedFor: 'item-1',
      requiredScopes: ['slack:read', 'slack:write'],
    } as unknown as Doc<'skills'>;
    const view = mount(
      asEmployee(
        <ProposedSkillsPanel
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map([['item-1', 'Draft response for new tier-two RevOps ask']])}
        />,
      ),
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
    // The adoption row's sentence went with the row: with nothing offered, the card says what
    // approving does and makes no claim about sharing.
    expect(text).not.toContain('do not share skills');
    expect(text).toContain(
      "Approving writes the skill and checks it in a sandbox, then evaluates again the item that needs it. Whether that work is within Mira's charter is judged separately.",
    );
    for (const control of view.container.querySelectorAll('button')) {
      expect(control.className).toMatch(/\bmin-h-11\b/);
    }
    view.unmount();
  });

  it("names the item that first needed a skill once, the evaluator's own sentence taken out (m15)", (): void => {
    const proposed = {
      _id: 'skill-2',
      _creationTime: 0,
      agentId: 'agent-1',
      name: 'chat-thread-reply',
      description: 'reply in a thread',
      sourceType: 'agent-authored',
      createdAt: 0,
      state: 'proposed',
      requiredScopes: [],
      proposedFor: 'item-1',
      rationale: `No registered skill covers a threaded reply on a chat surface. ${firstNeededSentence('Draft response for new tier-two RevOps ask', 'slack')}`,
    } as unknown as Doc<'skills'>;
    const view = mount(
      asEmployee(
        <ProposedSkillsPanel
          skills={[proposed]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map([['item-1', 'Draft response for new tier-two RevOps ask']])}
        />,
      ),
    );
    const text = view.container.textContent ?? '';
    expect(text.match(/First needed by/g)).toHaveLength(1);
    expect(text).toContain(
      'First needed by \u201cDraft response for new tier-two RevOps ask\u201d. No registered skill covers a threaded reply on a chat surface. The skill is a reusable procedure',
    );
    view.unmount();
  });

  it('says the approving note once for the card, however many proposals wait', (): void => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    const view = mount(
      asEmployee(
        <ProposedSkillsPanel
          skills={[proposed, { ...proposed, _id: 'skill-2', name: 'another' } as Doc<'skills'>]}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map()}
        />,
      ),
    );
    expect(view.container.textContent?.match(/is judged separately/g)).toHaveLength(1);
    view.unmount();
  });

  it('keeps one live region in place when the last proposal leaves, so its outcome is announced', async (): Promise<void> => {
    const proposed = { ...base, state: 'proposed', requiredScopes: [] } as unknown as Doc<'skills'>;
    const panel = (skills: Doc<'skills'>[]) =>
      asEmployee(
        <ProposedSkillsPanel
          skills={skills}
          surfaces={[]}
          onAuthoringAttempt={noop}
          name="Mira"
          itemTitles={new Map()}
        />,
      );
    const view = mount(panel([proposed]));
    const region = view.container.querySelector('[role="status"]');
    await press(view.container, 'Reject refresh-the-tile');
    act((): void => view.root.render(panel([])));
    expect(view.container.querySelector('[role="status"]')).toBe(region);
    expect(region?.textContent).toBe('Rejected refresh-the-tile: the employee will not author it.');
    view.unmount();
  });
});

describe('ProposedSkillsPanel: adoption (A3, 10-A)', (): void => {
  const noop = (): void => undefined;
  const offered = {
    _id: 'skill-9',
    _creationTime: 0,
    agentId: 'agent-1',
    name: 'kanban-comment-and-close',
    description: 'Ticket comment-and-close on a kanban surface.',
    sourceType: 'agent-authored',
    createdAt: 0,
    state: 'proposed',
    proposedFor: 'item-1',
    rationale: 'No registered skill covers comment-and-close on a kanban surface.',
    requiredScopes: ['linear:read', 'linear:write'],
    offeredVersionId: 'version-1',
  } as unknown as Doc<'skills'>;
  const adoption = {
    skillId: 'skill-9',
    name: 'kanban-comment-and-close',
    description: 'Ticket comment-and-close on a kanban surface.',
    proposedFor: 'item-1',
    state: 'offered',
    rowState: 'proposed',
    versionId: 'version-1',
    version: 1,
    authorName: 'Priya',
    verifiedAt: Date.UTC(2026, 8, 18, 9),
    missingScopes: ['linear:write'],
  };
  const titles = new Map([['item-1', 'Close REVOPS-21 with the audit note']]);

  function panel(
    skills: Doc<'skills'>[],
    onAuthoringAttempt: (attempt: unknown) => void = noop,
  ): ReactNode {
    return asEmployee(
      <ProposedSkillsPanel
        skills={skills}
        surfaces={[]}
        onAuthoringAttempt={onAuthoringAttempt}
        name="Mira"
        itemTitles={titles}
      />,
    );
  }

  afterEach((): void => {
    backend.queries = {};
    backend.results = {};
    backend.refusals = {};
    backend.calls.length = 0;
  });

  it('draws the adoption card for an offered proposal in place of Approve and Reject, and says either way in the note', (): void => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    const view = mount(panel([offered]));
    const text = view.container.textContent ?? '';
    expect(text).toContain(
      'kanban-comment-and-close · Ticket comment-and-close on a kanban surface',
    );
    expect(text).toContain('First needed by \u201cClose REVOPS-21 with the audit note\u201d.');
    expect(text).toContain(
      "Priya's skill kanban-comment-and-close, verified on 18 September 2026, does this.",
    );
    expect(text).not.toContain('Approve · author and verify');
    expect(text).toContain(
      "Either way the skill is checked in a sandbox before it runs, then the item that needs it is evaluated again. Whether that work is within Mira's charter is judged separately.",
    );
    view.unmount();
  });

  it('offers nothing to press on an offered proposal until the backend has drawn the offer', (): void => {
    const view = mount(panel([offered]));
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    view.unmount();
  });

  it('draws an ordinary proposal when the backend draws no offer for it', (): void => {
    backend.queries = { 'skillAdoption:adoptions': [] };
    const view = mount(panel([offered]));
    expect(view.container.textContent).toContain('Approve · author and verify');
    view.unmount();
  });

  it('adopts, says so, and files the attempt so the Skills card says when it registers', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    backend.results = { 'skillAdoption:adopt': { scopes: ['linear:write'] } };
    const attempts: unknown[] = [];
    const view = mount(panel([offered], (attempt) => void attempts.push(attempt)));
    await press(view.container, 'Adopt for Mira: kanban-comment-and-close');
    expect(backend.calls).toEqual([{ name: 'skillAdoption:adopt', args: { skillId: 'skill-9' } }]);
    expect(said(view.container)).toEqual([
      'Adopting kanban-comment-and-close for Mira: the sandbox is checking it again, and this card says when Mira can use it.',
    ]);
    expect(attempts).toEqual([{ skillId: 'skill-9', name: 'kanban-comment-and-close' }]);
    view.unmount();
  });

  it('lets the adoption’s outcome line go once its card says otherwise: registered, or stalled (the wave 10 review, A-m4)', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    backend.results = { 'skillAdoption:adopt': { scopes: ['linear:write'] } };
    const view = mount(panel([offered]));
    await press(view.container, 'Adopt for Mira: kanban-comment-and-close');
    expect(said(view.container).join(' ')).toContain('Adopting kanban-comment-and-close for Mira');

    // Being checked: the line stands.
    backend.queries = {
      'skillAdoption:adoptions': [
        {
          ...adoption,
          state: 'verifying',
          rowState: 'authoring',
          claimedAt: Date.now(),
        },
      ],
    };
    act((): void => view.root.render(panel([])));
    expect(said(view.container).join(' ')).toContain('Adopting kanban-comment-and-close for Mira');

    // Stopped short with nothing holding it: the card says why, and the line goes.
    backend.queries = {
      'skillAdoption:adoptions': [
        { ...adoption, state: 'verifying', rowState: 'authoring', log: 'no sandbox' },
      ],
    };
    act((): void => view.root.render(panel([])));
    expect(said(view.container).join(' ')).not.toContain('the sandbox is checking it again');

    // Registered: the adoption leaves the panel, and the line with it.
    backend.queries = { 'skillAdoption:adoptions': [] };
    act((): void => view.root.render(panel([])));
    expect(said(view.container).join(' ')).not.toContain('the sandbox is checking it again');
    view.unmount();
  });

  it('lets a Check it again’s line go once its check has run and stopped short again (the second pass)', async (): Promise<void> => {
    const stalled = { ...adoption, state: 'verifying', rowState: 'authoring', log: 'no sandbox' };
    backend.queries = { 'skillAdoption:adoptions': [stalled] };
    backend.results = { 'skillAdoption:verifyAgain': { ok: true } };
    const view = mount(panel([]));
    await press(view.container, 'Check it again: kanban-comment-and-close');
    expect(said(view.container).join(' ')).toContain('Checking kanban-comment-and-close again');

    // The check claims the row and runs.
    backend.queries = {
      'skillAdoption:adoptions': [{ ...stalled, log: undefined, claimedAt: Date.now() }],
    };
    act((): void => view.root.render(panel([])));
    expect(said(view.container).join(' ')).toContain('Checking kanban-comment-and-close again');

    // It stops short again: the card says why, and the line goes.
    backend.queries = { 'skillAdoption:adoptions': [stalled] };
    act((): void => view.root.render(panel([])));
    expect(said(view.container).join(' ')).not.toContain('Checking kanban-comment-and-close again');
    view.unmount();
  });

  it('says a refused adoption in the words the backend wrote for the manager', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    backend.refusals = {
      'skillAdoption:adopt':
        '[CONVEX M(skillAdoption:adopt)] [Request ID: 1] Server Error\nUncaught Error: kanban-comment-and-close cannot be adopted: sharing skills between employees is switched off.\n    at handler (../convex/skillAdoption.ts:1:1)',
    };
    const view = mount(panel([offered]));
    await press(view.container, 'Adopt for Mira: kanban-comment-and-close');
    expect(said(view.container)).toEqual([
      'kanban-comment-and-close cannot be adopted: sharing skills between employees is switched off.',
    ]);
    view.unmount();
  });

  it('writes a new one instead: the offer set aside, then the approval and the authoring', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    backend.results = {
      'skillAdoption:setOfferAside': { ok: true },
      'skillActions:authorAndRegisterSkill': { ok: true },
    };
    const attempts: unknown[] = [];
    const view = mount(panel([offered], (attempt) => void attempts.push(attempt)));
    await press(view.container, 'Write a new one instead of kanban-comment-and-close');
    expect(backend.calls.map((call) => call.name)).toEqual([
      'skillAdoption:setOfferAside',
      'skills:approve',
      'skillActions:authorAndRegisterSkill',
    ]);
    expect(said(view.container)).toEqual([
      'Approved kanban-comment-and-close: the employee is authoring it now, and the Skills card says when it is callable.',
    ]);
    expect(attempts).toEqual([null, { skillId: 'skill-9', name: 'kanban-comment-and-close' }]);
    view.unmount();
  });

  it('declines through the rejection, and keeps the card drawn declined once the row has gone', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    const view = mount(panel([offered]));
    await press(view.container, 'Decline kanban-comment-and-close');
    expect(backend.calls).toEqual([{ name: 'skills:reject', args: { skillId: 'skill-9' } }]);
    expect(said(view.container)).toEqual([
      'Declined kanban-comment-and-close: Mira will not adopt it.',
    ]);
    backend.queries = { 'skillAdoption:adoptions': [] };
    act((): void => view.root.render(panel([])));
    expect(view.container.textContent).toContain(
      "You declined Priya's skill kanban-comment-and-close for Mira. Mira will not adopt it, and the work waiting for it was cancelled.",
    );
    expect(view.container.querySelectorAll('button')).toHaveLength(0);
    view.unmount();
  });

  it('keeps an adoption on the panel while it is checked and when the check fails, and writes a new one from the failure without a second approval', async (): Promise<void> => {
    backend.queries = {
      'skillAdoption:adoptions': [
        {
          ...adoption,
          state: 'verifying',
          rowState: 'authoring',
          claimedAt: Date.now(),
          missingScopes: [],
        },
        {
          ...adoption,
          skillId: 'skill-10',
          name: 'chat-thread-reply',
          description: 'Threaded reply on a chat surface.',
          state: 'failed',
          rowState: 'failed',
          missingScopes: [],
          log: 'the stored skill failed its check - smoke.py exited 1',
        },
      ],
    };
    backend.results = {
      'skillAdoption:setOfferAside': { ok: true },
      'skillActions:authorAndRegisterSkill': { ok: true },
    };
    const view = mount(panel([]));
    const text = view.container.textContent ?? '';
    expect(view.container.querySelector('h2')?.textContent).toBe('Proposed · waiting on you');
    expect(text).toContain("Adopting Priya's skill kanban-comment-and-close for Mira.");
    expect(text).toContain("Priya's skill chat-thread-reply failed its re-verification for Mira.");
    expect(text).toContain('the stored skill failed its check - smoke.py exited 1');
    await press(view.container, 'Write a new one instead of chat-thread-reply');
    expect(backend.calls.map((call) => call.name)).toEqual([
      'skillAdoption:setOfferAside',
      'skillActions:authorAndRegisterSkill',
    ]);
    // The failed card's note is an alert of its own; the press's outcome is said after it.
    expect(said(view.container).at(-1)).toBe(
      'Mira is writing chat-thread-reply now, and the Skills card says when it is callable.',
    );
    view.unmount();
  });

  it('has no axe violation and a 44 px target on every control with every adoption state drawn', async (): Promise<void> => {
    backend.queries = {
      'skillAdoption:adoptions': [
        adoption,
        {
          ...adoption,
          skillId: 'skill-11',
          state: 'verifying',
          rowState: 'authoring',
          claimedAt: Date.now(),
          missingScopes: [],
        },
        {
          ...adoption,
          skillId: 'skill-12',
          state: 'failed',
          rowState: 'failed',
          missingScopes: [],
          log: 'one\ntwo',
        },
        {
          ...adoption,
          skillId: 'skill-13',
          state: 'verifying',
          rowState: 'authoring',
          missingScopes: [],
          log: 'the stored skill was not verified: no sandbox backend answered',
        },
      ],
    };
    const view = mount(panel([offered]));
    expect(await axeViolations(view.container, ['region'])).toEqual([]);
    expect(underTarget(view.container)).toEqual([]);
    view.unmount();
  }, 30_000);

  it('draws a check that stopped short with Check it again, which runs the stored verification once more', async (): Promise<void> => {
    backend.queries = {
      'skillAdoption:adoptions': [
        {
          ...adoption,
          state: 'verifying',
          rowState: 'authoring',
          missingScopes: [],
          log: 'the stored skill was not verified: no sandbox backend answered',
        },
      ],
    };
    backend.results = { 'skillAdoption:verifyAgain': { ok: true } };
    const view = mount(panel([]));
    expect(view.container.querySelector('h2')?.textContent).toBe('Proposed · waiting on you');
    expect(view.container.textContent).toContain(
      "Adopting Priya's skill kanban-comment-and-close for Mira stopped before the sandbox finished checking it.",
    );
    await press(view.container, 'Check it again: kanban-comment-and-close');
    expect(backend.calls).toEqual([
      { name: 'skillAdoption:verifyAgain', args: { skillId: 'skill-9' } },
    ]);
    expect(said(view.container).at(-1)).toBe(
      'Checking kanban-comment-and-close again for Mira: this card says when Mira can use it.',
    );
    view.unmount();
  });

  it('never says approving writes the skill under an adoption that writes nothing (the pre-tag walk)', (): void => {
    const stalled = {
      ...adoption,
      state: 'verifying',
      rowState: 'authoring',
      missingScopes: [],
      log: 'the stored skill was not verified: no sandbox backend answered',
    };
    backend.queries = { 'skillAdoption:adoptions': [stalled] };
    const alone = mount(panel([]));
    expect(alone.container.textContent).not.toContain('Approving writes the skill');
    expect(alone.container.textContent).toContain(
      "Adopting writes nothing: the colleague's version is checked again in a sandbox before it runs, then the item that needs it is evaluated again. Whether that work is within Mira's charter is judged separately.",
    );
    alone.unmount();

    const proposal = {
      ...offered,
      _id: 'skill-10',
      name: 'kanban-reply',
      offeredVersionId: undefined,
    };
    const beside = mount(panel([proposal as Doc<'skills'>]));
    expect(beside.container.textContent).toContain(
      "Approving a proposal writes the skill and checks it in a sandbox; an adoption writes nothing and checks the colleague's version there again. Either way the item that needs it is evaluated again. Whether that work is within Mira's charter is judged separately.",
    );
    beside.unmount();
  });

  it('titles the card plainly, with no count, while nothing on it waits on the manager', (): void => {
    backend.queries = {
      'skillAdoption:adoptions': [
        {
          ...adoption,
          state: 'verifying',
          rowState: 'authoring',
          claimedAt: Date.now(),
          missingScopes: [],
        },
      ],
    };
    const view = mount(panel([]));
    expect(view.container.querySelector('h2')?.textContent).toBe('Proposed');
    expect(view.container.textContent).not.toContain('waiting on you');
    view.unmount();
  });

  it('keeps every adoption declined on this visit drawn, not only the last', async (): Promise<void> => {
    const second = { ...offered, _id: 'skill-10', name: 'chat-thread-reply' } as Doc<'skills'>;
    backend.queries = {
      'skillAdoption:adoptions': [
        adoption,
        { ...adoption, skillId: 'skill-10', name: 'chat-thread-reply' },
      ],
    };
    const view = mount(panel([offered, second]));
    await press(view.container, 'Decline kanban-comment-and-close');
    await press(view.container, 'Decline chat-thread-reply');
    backend.queries = { 'skillAdoption:adoptions': [] };
    act((): void => view.root.render(panel([])));
    const text = view.container.textContent ?? '';
    expect(text).toContain("You declined Priya's skill kanban-comment-and-close for Mira.");
    expect(text).toContain("You declined Priya's skill chat-thread-reply for Mira.");
    view.unmount();
  });

  it('leaves an ordinary proposal when Write a new one instead sets the offer aside and the approval is refused', async (): Promise<void> => {
    backend.queries = { 'skillAdoption:adoptions': [adoption] };
    backend.results = { 'skillAdoption:setOfferAside': { ok: true } };
    backend.refusals = {
      'skills:approve':
        '[CONVEX M(skills:approve)] [Request ID: 1] Server Error\nUncaught Error: cannot approve "kanban-comment-and-close": surface linear is listed-dead; connect it on the Surfaces tab before approving this skill\n    at handler (../convex/skills.ts:1:1)',
    };
    const attempts: unknown[] = [];
    const view = mount(panel([offered], (attempt) => void attempts.push(attempt)));
    await press(view.container, 'Write a new one instead of kanban-comment-and-close');
    expect(backend.calls.map((call) => call.name)).toEqual([
      'skillAdoption:setOfferAside',
      'skills:approve',
    ]);
    expect(said(view.container)).toEqual([
      'cannot approve "kanban-comment-and-close": surface linear is listed-dead; connect it on the Surfaces tab before approving this skill',
    ]);
    expect(attempts).toEqual([]);
    view.unmount();
  });
});
