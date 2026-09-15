import { beforeEach, describe, expect, it, vi } from 'vitest';
import { qualityFit } from '../../../src/work/quality-fit';
import type { WorkCandidate } from '../../../src/work/types';

const model = vi.hoisted(() => ({
  instructions: [] as Array<{ agent: string; instructions: string }>,
  users: [] as string[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string, instructions: string): { name: string } => {
    model.instructions.push({ agent: name, instructions });
    return { name };
  },
  agentJson: async (args: { user: string }): Promise<unknown> => {
    model.users.push(args.user);
    return { pass: true, reason: 'in the role' };
  },
}));

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'ticket',
  externalId: 'T-1',
  title: 'Refresh the dashboard tile',
  contentSummary: 'Set the coverage figure to 74%.',
  contentRefs: [],
  observedAt: new Date('2026-09-15T02:00:00.000Z'),
  requesterLabel: 'Manager',
};

/**
 * The mock beds run this filter with this exact text; the scope judgement
 * consumes its answer as an input and must not move it.
 */
describe('frozen quality-fit text', (): void => {
  beforeEach((): void => {
    model.users.length = 0;
  });

  it('keeps the quality-fit system prompt byte-identical', (): void => {
    expect(model.instructions.find((entry) => entry.agent === 'day0-quality-fit')?.instructions)
      .toMatchInlineSnapshot(`
      "You are an autonomous workplace agent named Day0.
      You are deciding whether to claim a piece of incoming work.
      You have a \`Good-habits memory\` block that captures the role norms a competent practitioner follows — habits, anti-patterns, and discipline.
      A user has posted, mentioned you, or filed a ticket. Decide: does this candidate look like work the role would invest time in, vs low-value-but-discoverable busywork that violates the role norms?

      Discipline:
        - Bias toward \`pass: true\` when the candidate is clearly in the role and reasonable. Layer 3 still requires boss approval before execution.
        - \`pass: false\` is for clear violations (e.g. concierge for a tangential ask, low-value formatting work when the role norm is variance commentary)."
    `);
  });

  it('keeps the quality-fit user prompt byte-identical', async (): Promise<void> => {
    await qualityFit({
      candidate,
      agentsMd: '## Good-habits memory\n- Confirm the owner first.',
      role: 'Operations coordination',
    });
    expect(model.users).toHaveLength(1);
    expect(model.users[0]).toMatchInlineSnapshot(`
      "Role: Operations coordination

      --- AGENTS.md (good-habits memory) ---
      ## Good-habits memory
      - Confirm the owner first.

      --- Candidate ---
      From: Manager
      Source: ticket / ticket-queue
      Title: Refresh the dashboard tile
      Body:
      Set the coverage figure to 74%.

      Decide whether to claim. Reference one specific role norm where possible."
    `);
  });

  it('passes without a model call while AGENTS.md has no good-habits memory', async (): Promise<void> => {
    await expect(qualityFit({ candidate, agentsMd: '', role: 'Operations coordination' })).resolves.toEqual({
      pass: true,
      reason: 'no good-habits memory yet — defer slop filtering to Layer 3',
    });
    expect(model.users).toEqual([]);
  });
});
