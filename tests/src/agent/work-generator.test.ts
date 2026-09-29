import { describe, expect, it, vi } from 'vitest';

const prompts = vi.hoisted(() => [] as string[]);

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async ({ user }: { user: string }): Promise<{ items: [] }> => {
    prompts.push(user);
    return { items: [] };
  },
}));

import type { Charter } from '../../../src/agent/charter';
import { WORK_GEN_SYSTEM, generateWorkItemsFromCharter } from '../../../src/agent/work-generator';

describe('generated demo work prompt', (): void => {
  it('derives role mismatch from the runtime charter without naming the seeded office', (): void => {
    expect(WORK_GEN_SYSTEM).not.toMatch(/RevOps|revenue operations/i);
    expect(WORK_GEN_SYSTEM).toContain('outside the role described in the charter');
  });

  it('keeps how an item is handled out of the words the manager reads on its card (N29)', (): void => {
    // The out-of-scope item once told the model the evaluator should skip it, and the model wrote
    // "the agent should skip and route this back" into the item the manager read.
    expect(WORK_GEN_SYSTEM).not.toMatch(/should skip/i);
    expect(WORK_GEN_SYSTEM).toContain('never say how the request should be handled');
  });
});

describe('the charter the generator reads', (): void => {
  it('leaves out the clauses a strike took out, which are the record and not work', async (): Promise<void> => {
    const charter = {
      proposedFunction: 'Own triage.',
      proposedBoundaries: { willDo: ['Triage asks.'], willNotDo: [], escalationTriggers: [] },
      struckClauses: [{ field: 'willDo', text: 'Own the forecast deck.' }],
    } as unknown as Charter;
    const office = {
      howToGuides: [],
      teamDocs: [],
      spreadsheets: [],
      slackChannels: [],
      tweets: [],
      tickets: [],
    };
    await generateWorkItemsFromCharter(charter, office as never);
    expect(prompts.at(-1)).toContain('Triage asks.');
    expect(prompts.at(-1)).not.toContain('Own the forecast deck.');
  });
});
