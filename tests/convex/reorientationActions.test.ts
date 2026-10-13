import { convexTest } from 'convex-test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import schema from '../../convex/schema';
import { allConvexModules } from './all-modules';
import {
  cardOf,
  eventTypesOf,
  openTestCard,
  seedEmployee,
  type Harness,
} from './fakes/reorientation';
import type { ScriptedCall } from './fakes/mastra';

const { schemaChecked } = await vi.hoisted(async () => await import('./fakes/mastra'));

/** What the scripted model answers next, and every prompt it was asked. */
const model = vi.hoisted(() => ({
  reply: undefined as unknown,
  asked: [] as string[],
  /** Something that happens while the model is answering, once. */
  meanwhile: undefined as (() => Promise<void>) | undefined,
}));

// The model call is the seam: the judgement's own prompt and reading run as written.
vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string) => ({ name }),
  agentJson: schemaChecked(async (call: ScriptedCall): Promise<unknown> => {
    model.asked.push(call.user);
    const meanwhile = model.meanwhile;
    model.meanwhile = undefined;
    await meanwhile?.();
    if (model.reply instanceof Error) throw model.reply;
    return model.reply;
  }),
}));

beforeEach((): void => {
  vi.useFakeTimers();
  model.reply = undefined;
  model.asked = [];
  model.meanwhile = undefined;
});
afterEach((): void => {
  vi.useRealTimers();
});

/** Open a card about the charter's escalation clause and run its scheduled judgement. */
async function judgedCard(harness: Harness) {
  const agentId = await seedEmployee(harness);
  const cardId = (await openTestCard(harness, {
    agentId,
    trigger: 'relationship-changed',
    triggerKey: 'event-1',
    summary: 'Priya now approves tier-2 answers about committee-deck numbers',
    affected: {
      charterClauses: [
        {
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 answer drafts to the manager for review',
        },
      ],
    },
  }))!;
  await harness.finishAllScheduledFunctions(vi.runAllTimers);
  return { agentId, cardId };
}

describe('propose: the card’s scheduled judgement (O-2)', (): void => {
  it('writes no proposal from what a join changed meanwhile, and the join’s own judgement proposes (second pass M6)', async (): Promise<void> => {
    model.reply = {
      change: 'none',
      candidate: null,
      action: null,
      text: null,
      rationale: 'Nothing.',
    };
    const harness = convexTest(schema, allConvexModules());
    const agentId = await seedEmployee(harness);
    model.meanwhile = async (): Promise<void> => {
      await openTestCard(harness, {
        agentId,
        trigger: 'relationship-changed',
        triggerKey: 'event-2',
        summary: 'Dana now handles renewals escalations',
        affected: {
          charterClauses: [
            { field: 'willDo', index: 0, text: 'Answer renewal asks from the account team' },
          ],
        },
      });
    };
    const cardId = (await openTestCard(harness, {
      agentId,
      trigger: 'relationship-changed',
      triggerKey: 'event-1',
      summary: 'Priya now approves tier-2 answers about committee-deck numbers',
      affected: {
        charterClauses: [
          {
            field: 'escalationTriggers',
            index: 0,
            text: 'Surface tier-2 answer drafts to the manager for review',
          },
        ],
      },
    }))!;
    await harness.finishAllScheduledFunctions(vi.runAllTimers);
    // The first answer read the card before the join; the second read it with the join.
    expect(model.asked).toHaveLength(2);
    expect(model.asked[0]).not.toContain('Answer renewal asks from the account team');
    expect(model.asked[1]).toContain('Answer renewal asks from the account team');
    expect((await cardOf(harness, cardId)).proposed.kind).toBe('none');
    expect(
      (await eventTypesOf(harness, agentId)).filter((type) => type === 'reorientation.proposed'),
    ).toHaveLength(1);
  });

  it('writes the proposal the model gives onto the card, never applying it', async (): Promise<void> => {
    model.reply = {
      change: 'edit-clause',
      candidate: 1,
      action: null,
      text: 'Surface tier-2 answer drafts about committee-deck numbers to Priya first, then to the manager',
      rationale: 'Priya approves committee-deck numbers now, so those drafts go to her first.',
    };
    const harness = convexTest(schema, allConvexModules());
    const { agentId, cardId } = await judgedCard(harness);
    expect(model.asked).toHaveLength(1);
    expect(model.asked[0]).toContain(
      '1. Charter clause (Escalates when): “Surface tier-2 answer drafts to the manager for review” [edit-clause]',
    );
    const card = await cardOf(harness, cardId);
    expect(card.status).toBe('open');
    expect(card.proposed).toEqual({
      kind: 'charter-change',
      changes: [
        {
          kind: 'edit-clause',
          field: 'escalationTriggers',
          index: 0,
          text: 'Surface tier-2 answer drafts about committee-deck numbers to Priya first, then to the manager',
        },
      ],
      rationale: 'Priya approves committee-deck numbers now, so those drafts go to her first.',
      before: 'Surface tier-2 answer drafts to the manager for review',
      after:
        'Surface tier-2 answer drafts about committee-deck numbers to Priya first, then to the manager',
    });
    expect(await eventTypesOf(harness, agentId)).toEqual([
      'reorientation.opened',
      'reorientation.proposed',
    ]);
    const charters = await harness.run(async (ctx) => await ctx.db.query('charters').collect());
    expect(charters).toHaveLength(1);
  });

  it('leaves the card open with nothing proposed, and says why, when the model fails', async (): Promise<void> => {
    model.reply = new Error('the model endpoint did not answer');
    const harness = convexTest(schema, allConvexModules());
    const { agentId, cardId } = await judgedCard(harness);
    const card = await cardOf(harness, cardId);
    expect(card.status).toBe('open');
    expect(card.proposed).toMatchObject({
      kind: 'pending',
      failure: 'the model endpoint did not answer',
    });
    expect(await eventTypesOf(harness, agentId)).toEqual(['reorientation.opened']);
  });

  it('refuses a reply that names a candidate the card does not hold', async (): Promise<void> => {
    model.reply = {
      change: 'skill',
      candidate: 4,
      action: 'withdraw',
      text: null,
      rationale: 'Withdraw it.',
    };
    const harness = convexTest(schema, allConvexModules());
    const { cardId } = await judgedCard(harness);
    expect((await cardOf(harness, cardId)).proposed).toMatchObject({
      kind: 'pending',
      failure: 'the reply names candidate 4, which the card does not hold',
    });
  });
});
