/** @vitest-environment node */

import { describe, expect, it, vi } from 'vitest';
import type { ActionCtx } from '../../convex/_generated/server';
import type { Id } from '../../convex/_generated/dataModel';
import {
  keepRefusedDraft,
  recordAuthoringFailure,
  storedCopyRefusedReason,
  SUPERSEDED,
} from '../../convex/skillAuthoringRecord';
import { REFUSED_DRAFT_CHARS } from '../../src/work/authored-skill';

vi.mock('../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (): Promise<never> => {
    throw new Error('model unavailable in tests');
  },
  agentText: async (): Promise<string> => '',
}));

/*
 * What an authoring run keeps of itself (`convex/skillAuthoringRecord.ts`, split from
 * `skillActions` by 11-FI; the wave 11 review's m16): the fenced failure and the words it
 * returns, a refused draft made safe and bounded, and a stored copy's refusal.
 */

const SKILL = 'skill-1' as Id<'skills'>;
const RUN = 'run-1' as Id<'events'>;
const AGENT = 'agent-1' as Id<'agents'>;

/** An action context whose failure write answers as the claim stands. */
function failingRun(recorded: boolean): { ctx: ActionCtx; written: unknown[] } {
  const written: unknown[] = [];
  const ctx = {
    runMutation: async (_reference: unknown, args: unknown): Promise<{ recorded: boolean }> => {
      written.push(args);
      return { recorded };
    },
  } as unknown as ActionCtx;
  return { ctx, written };
}

describe('the record an authoring run keeps', (): void => {
  it("returns the failure's reason when the run still held the skill, with the refused draft on the row", async (): Promise<void> => {
    const { ctx, written } = failingRun(true);

    const outcome = await recordAuthoringFailure(ctx, SKILL, RUN, {
      rowReason: 'the static gate refused the draft',
      reason: 'the static gate refused the draft: no run()',
      eventType: 'skill.author-failed',
      refusedDraft: { body: '# Draft', smokeTest: 'print(1)' },
    });

    expect(outcome).toEqual({ ok: false, reason: 'the static gate refused the draft: no run()' });
    expect(written).toEqual([
      {
        skillId: SKILL,
        runId: RUN,
        rowReason: 'the static gate refused the draft',
        reason: 'the static gate refused the draft: no run()',
        eventType: 'skill.author-failed',
        refusedBody: '# Draft',
        refusedSmokeTest: 'print(1)',
      },
    ]);
  });

  it('says the result was discarded when the run had lost the skill', async (): Promise<void> => {
    const { ctx } = failingRun(false);

    await expect(
      recordAuthoringFailure(ctx, SKILL, RUN, {
        rowReason: 'r',
        reason: 'r',
        eventType: 'skill.author-failed',
      }),
    ).resolves.toEqual({ ok: false, reason: SUPERSEDED });
  });

  it('keeps a refused draft with its token-shaped values redacted and bounded below what the row holds', async (): Promise<void> => {
    const token = ['xoxb', '1234567890', 'abcdefghij'].join('-');
    const long = `# Draft\nUse ${token} to post.\n${'x'.repeat(REFUSED_DRAFT_CHARS)}`;

    const kept = await keepRefusedDraft({} as ActionCtx, AGENT, {
      body: long,
      smokeTest: `TOKEN = "${token}"`,
    });

    expect(kept.body).not.toContain(token);
    expect(kept.smokeTest).not.toContain(token);
    expect(kept.body.length).toBeLessThan(long.length);
    expect(kept.body).toContain('more characters not kept');
  });

  it("words a stored copy's refusal on the row", (): void => {
    expect(storedCopyRefusedReason('the skill it copied is no longer offered')).toBe(
      'the stored skill was not registered: the skill it copied is no longer offered',
    );
  });
});
