import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { internal } from '../../convex/_generated/api';
import schema from '../../convex/schema';
import * as reorientationJudgementInputModule from '../../convex/reorientationJudgementInput';
import { proposalInputOf } from '../../convex/reorientationJudgementInput';
import { convexRuntimeImports, reachedFrom } from '../fixtures/import-graph';
import { allConvexModules } from './all-modules';
import { basisOf, cardOf, eventTypesOf, openTestCard, seedEmployee } from './fakes/reorientation';
import { registeredIn } from './registered-functions';

/*
 * The judgement's input and write-back (wave 18, 18-s): what a proposal is drawn from and how it
 * is written onto its card, whose bodies are `convex/reorientationJudgementInput.ts`'s. Both
 * describes moved here from `tests/convex/reorientation.test.ts` as they stood, under that file's
 * fake timers; the functions are still called at their `internal.reorientation.*` paths, which
 * did not move (S-1).
 */

// openCard schedules the judgement: fake timers keep it from running unless a test drains it.
beforeEach((): void => {
  vi.useFakeTimers();
});
afterEach((): void => {
  vi.useRealTimers();
});

describe('convex/reorientationJudgementInput.ts', (): void => {
  it('registers no function: the judgement’s three stay registered in convex/reorientation.ts', (): void => {
    expect(registeredIn(reorientationJudgementInputModule)).toEqual([]);
  });

  it('sits below convex/reorientation.ts, which imports it and which no chain of its imports reaches', (): void => {
    const graph = convexRuntimeImports();
    expect(graph.get('reorientation')).toContain('reorientationJudgementInput');
    expect(reachedFrom(graph, 'reorientationJudgementInput').has('reorientation')).toBe(false);
  });
});

describe('the judgement’s write-back', (): void => {
  it('writes a proposal onto a pending card, once, and never onto a decided one', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    const proposed = { kind: 'none' as const, rationale: 'The page changed only its title.' };
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: cardId,
        proposed,
        basis: await basisOf(harness, cardId),
      }),
    ).resolves.toEqual({ written: true });
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: cardId,
        proposed: { kind: 'none', rationale: 'Again.' },
        basis: await basisOf(harness, cardId),
      }),
    ).resolves.toEqual({ written: false });
    expect((await cardOf(harness, cardId)).proposed).toEqual(proposed);
    expect(await eventTypesOf(harness, agentId)).toEqual([
      'reorientation.opened',
      'reorientation.proposed',
    ]);

    const other = (await openTestCard(harness, {
      agentId,
      trigger: 'access-ended',
      triggerKey: 'event-2',
      summary: 'Linear access ended',
    }))!;
    const basis = await basisOf(harness, other);
    await harness.run(async (ctx) => await ctx.db.patch(other, { status: 'dismissed' }));
    await expect(
      harness.mutation(internal.reorientation.writeProposal, {
        reorientationId: other,
        proposed,
        basis,
      }),
    ).resolves.toEqual({ written: false });
  });

  it('records a failed judgement on the card, which stays open with nothing proposed', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'skill-recheck-due',
      triggerKey: 'event-1',
      summary: 'A skill is due a re-check',
    }))!;
    await harness.mutation(internal.reorientation.recordProposalFailure, {
      reorientationId: cardId,
      failure: 'the model did not answer',
      basis: await basisOf(harness, cardId),
    });
    const card = await cardOf(harness, cardId);
    expect(card.status).toBe('open');
    expect(card.proposed).toMatchObject({ kind: 'pending', failure: 'the model did not answer' });
    expect(card.proposed.kind === 'pending' && typeof card.proposed.failedAt).toBe('number');
  });
});

describe('proposalInputOf: what a proposal is drawn from (the judgement and Discuss)', (): void => {
  it('gives the card’s candidates whatever it proposes, and the judgement’s read only while pending', async (): Promise<void> => {
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'role-changed',
      triggerKey: 'role-changed:1',
      summary: 'Priya now approves committee-deck numbers',
    }))!;
    const pending = await harness.query(internal.reorientation.proposalInput, {
      reorientationId: cardId,
    });
    await harness.mutation(internal.reorientation.writeProposal, {
      reorientationId: cardId,
      proposed: { kind: 'none', rationale: 'Nothing needs to change.' },
      basis: await basisOf(harness, cardId),
    });
    const card = await cardOf(harness, cardId);
    const input = await harness.run(async (ctx) => await proposalInputOf(ctx, card));
    expect(input).toEqual(pending?.input);
    expect(input?.candidates.map((candidate) => candidate.kind)).toEqual([
      'charter-clause',
      'charter-clause',
      'charter-clause',
    ]);
    await expect(
      harness.query(internal.reorientation.proposalInput, { reorientationId: cardId }),
    ).resolves.toBeNull();
  });
});
