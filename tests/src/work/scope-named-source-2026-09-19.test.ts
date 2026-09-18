import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCandidate } from '../../../src/work/evaluate';
import { willDoClauseNaming, type ScopeJudgement } from '../../../src/work/scope';
import {
  K_REASON,
  mateoCharter,
  noSkill,
  opsRequestsMention,
  priyaCharter,
  revops27,
  revops29,
  runContext,
} from './scope-run-fixtures-2026-09-19';

/**
 * Finding K of the second full run (19 Sep 2026). REVOPS-27, a ticket in the
 * team and project Priya's willDo names, was skipped "out-of-scope: Updating
 * a Looker tile is not among the willDo clauses (triage, Linear ticket work,
 * ...)": a reason that lists Linear ticket work as a will-do and skips a
 * Linear ticket. Where the item came from is a fact on the rows, so a skip of
 * such an item has to cite what excludes it; the model is asked once more
 * when it does not, and a second uncited skip does not stand. Nothing here
 * ever argues an item into scope whose source the charter does not name.
 */

interface Answer {
  inScope: boolean;
  fit: boolean;
  reason: string;
  exclusion?: { kind: 'none' | 'will-not-do' | 'absent-system'; quote: string };
}

const model = vi.hoisted(() => ({
  calls: [] as Array<{ agent: string; user: string }>,
  answers: [] as unknown[],
}));

vi.mock('../../../src/lib/mastra', () => ({
  makeAgent: (name: string): { name: string } => ({ name }),
  agentJson: async (args: { agent: { name: string }; user: string }): Promise<unknown> => {
    model.calls.push({ agent: args.agent.name, user: args.user });
    const next = model.answers.shift();
    if (next === undefined) throw new Error('unscripted model call');
    if (next instanceof Error) throw next;
    return next;
  },
}));

const uncitedSkip: Answer = {
  inScope: false,
  fit: true,
  reason: K_REASON,
  exclusion: { kind: 'none', quote: '' },
};

async function evaluate(
  candidate: Parameters<typeof evaluateCandidate>[0],
  ctx: Parameters<typeof evaluateCandidate>[1],
): Promise<{ verdict: Awaited<ReturnType<typeof evaluateCandidate>>; judgements: ScopeJudgement[] }> {
  const judgements: ScopeJudgement[] = [];
  const verdict = await evaluateCandidate(candidate, ctx, noSkill, {
    onScopeJudgement: (judgement): void => void judgements.push(judgement),
  });
  return { verdict, judgements };
}

beforeEach((): void => {
  model.calls.length = 0;
  model.answers.length = 0;
});

describe('a skip of an item whose source the willDo names (finding K, REVOPS-27)', (): void => {
  it('does not stand on the run\'s reason: asked once more, then kept in scope with both readings', async (): Promise<void> => {
    const second = 'Refreshing a dashboard tile is analytics work, which the willDo clauses do not list.';
    model.answers.push(uncitedSkip, { ...uncitedSkip, reason: second });

    const { verdict, judgements } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([
      {
        admitted: true,
        basis: 'source-named',
        namedBy: 'Work the tickets in Linear, team REVOPS, project Q3 close.',
        overruled: [K_REASON, second],
      },
    ]);
    expect(model.calls.map((call) => call.agent)).toEqual(['day0-scope-judgement', 'day0-scope-judgement']);
  });

  it('tells the second asking what the first said, which clause names the source, and what a skip must cite', async (): Promise<void> => {
    model.answers.push(uncitedSkip, uncitedSkip);

    await evaluate(revops27, runContext('priya'));

    const reask = model.calls[1]!.user;
    expect(reask).toContain(K_REASON);
    expect(reask).toContain('Work the tickets in Linear, team REVOPS, project Q3 close.');
    expect(reask).toContain('willNotDo clause');
    expect(reask).toContain('system');
    expect(reask.startsWith(model.calls[0]!.user)).toBe(true);
  });

  it('takes the second reading when it places the item in scope, and keeps the first beside it', async (): Promise<void> => {
    model.answers.push(uncitedSkip, {
      inScope: true,
      fit: true,
      reason: 'A ticket in REVOPS / Q3 close is the ticket work the role does.',
      exclusion: { kind: 'none', quote: '' },
    });

    const { verdict, judgements } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([
      {
        admitted: true,
        basis: 'charter-judgement',
        namedBy: 'Work the tickets in Linear, team REVOPS, project Q3 close.',
        overruled: [K_REASON],
      },
    ]);
  });

  it('lets a skip stand at once when it quotes a willNotDo clause', async (): Promise<void> => {
    const reason =
      "The ticket requires accessing Northstar CRM, which the charter's willNotDo forbids until there is an approved way in.";
    model.answers.push({
      inScope: false,
      fit: true,
      reason,
      exclusion: { kind: 'will-not-do', quote: 'Access or work in Northstar CRM until there is an approved way in.' },
    });

    const { verdict, judgements } = await evaluate(revops29, runContext('priya'));

    expect(verdict).toEqual({ decision: 'skip', reason: `out-of-scope: ${reason}` });
    expect(judgements).toEqual([{ admitted: false, basis: 'charter-judgement', reason: `out-of-scope: ${reason}` }]);
    expect(model.calls).toHaveLength(1);
  });

  it('accepts a quote that differs from the clause only in case, quoting and the closing full stop', async (): Promise<void> => {
    model.answers.push({
      inScope: false,
      fit: true,
      reason: 'Northstar is closed to the role.',
      exclusion: { kind: 'will-not-do', quote: '"access or work in Northstar CRM until there is an approved way in"' },
    });

    const { verdict } = await evaluate(revops29, runContext('priya'));

    expect(verdict.decision).toBe('skip');
    expect(model.calls).toHaveLength(1);
  });

  it('does not take a quote the charter does not carry for a citation', async (): Promise<void> => {
    model.answers.push(
      {
        inScope: false,
        fit: true,
        reason: K_REASON,
        exclusion: { kind: 'will-not-do', quote: 'Update dashboards or analytics tiles.' },
      },
      uncitedSkip,
    );

    const { verdict } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(model.calls).toHaveLength(2);
  });

  it('lets a skip stand when it names a system the item needs and the employee has no way into', async (): Promise<void> => {
    model.answers.push({
      inScope: false,
      fit: true,
      reason: 'The reconciliation happens in Northstar CRM, which is not connected.',
      exclusion: { kind: 'absent-system', quote: 'Northstar CRM' },
    });

    const { verdict } = await evaluate(revops29, runContext('priya'));

    expect(verdict.decision).toBe('skip');
    expect(model.calls).toHaveLength(1);
  });

  it('does not take a connected system, or one the item never names, for an absent one', async (): Promise<void> => {
    model.answers.push(
      { ...uncitedSkip, exclusion: { kind: 'absent-system', quote: 'Looker' } },
      { ...uncitedSkip, exclusion: { kind: 'absent-system', quote: 'Tableau' } },
    );

    const { verdict, judgements } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements[0]).toMatchObject({ admitted: true, basis: 'source-named' });
  });

  it('lets the second reading skip when that one cites', async (): Promise<void> => {
    const cited = 'Configuring Linear is the admins\' lane.';
    model.answers.push(uncitedSkip, {
      inScope: false,
      fit: true,
      reason: cited,
      exclusion: { kind: 'will-not-do', quote: "Own Linear or Slack administration (the admins' lane)." },
    });

    const { verdict } = await evaluate(revops27, runContext('priya'));

    expect(verdict).toEqual({ decision: 'skip', reason: `out-of-scope: ${cited}` });
  });

  it('keeps the item on the named source when the second asking cannot be reached, and says so', async (): Promise<void> => {
    model.answers.push(uncitedSkip, new Error('provider answered 503'));

    const { verdict, judgements } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([
      {
        admitted: true,
        basis: 'source-named',
        namedBy: 'Work the tickets in Linear, team REVOPS, project Q3 close.',
        overruled: [K_REASON],
        failedOpen: 'provider answered 503',
      },
    ]);
  });

  it('reads an answer without the citation field as citing nothing', async (): Promise<void> => {
    model.answers.push(
      { inScope: false, fit: true, reason: K_REASON },
      { inScope: false, fit: true, reason: K_REASON },
    );

    const { verdict } = await evaluate(revops27, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
  });
});

describe('never the reverse: an item whose source the willDo does not name', (): void => {
  it('stays skipped on one uncited reading: the #ops-requests mention Mateo read', async (): Promise<void> => {
    const reason =
      'Refreshing a pipeline tile in #ops-requests is not reading close tickets, posting the close status note, or answering questions in #finance-close.';
    model.answers.push({ ...uncitedSkip, reason });

    const { verdict, judgements } = await evaluate(opsRequestsMention, runContext('mateo'));

    expect(verdict).toEqual({ decision: 'skip', reason: `out-of-scope: ${reason}` });
    expect(judgements).toEqual([{ admitted: false, basis: 'charter-judgement', reason: `out-of-scope: ${reason}` }]);
    expect(model.calls).toHaveLength(1);
    expect(model.calls[0]!.user).not.toContain('names where this item came from');
  });

  it('is asked again for the same mention under the charter that names the channel', async (): Promise<void> => {
    model.answers.push(uncitedSkip, uncitedSkip);

    const { verdict, judgements } = await evaluate(opsRequestsMention, runContext('priya'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements[0]).toMatchObject({
      basis: 'source-named',
      namedBy: 'Triage asks arriving in #revops-asks and #ops-requests into Linear tickets.',
    });
  });

  it('makes no model call and changes no verdict in mock mode', async (): Promise<void> => {
    const { verdict, judgements } = await evaluate(revops27, runContext('priya', 'mock'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([{ admitted: true, basis: 'charter-overlap' }]);
    expect(model.calls).toEqual([]);
  });
});

describe('which willDo clause names a source', (): void => {
  const linear = { surface: 'Linear', slug: 'linear' };

  it('reads the team, the project or the surface as a whole phrase', (): void => {
    expect(willDoClauseNaming(priyaCharter, { ...linear, team: 'REVOPS', projects: ['Q3 close'] })).toBe(
      'Work the tickets in Linear, team REVOPS, project Q3 close.',
    );
    expect(willDoClauseNaming(mateoCharter, { ...linear, team: 'FIN', projects: ['September close'] })).toBe(
      'Read the September close step tickets in Linear (team FIN, project September close).',
    );
  });

  it('needs the channel itself for a mention, never only the chat surface', (): void => {
    const slack = { surface: 'Slack', slug: 'slack' };
    expect(willDoClauseNaming(mateoCharter, { ...slack, channel: 'ops-requests' })).toBeUndefined();
    expect(willDoClauseNaming(mateoCharter, { ...slack, channel: 'finance-close' })).toBe(
      'Answer questions in #finance-close about where the close stands.',
    );
    expect(willDoClauseNaming(mateoCharter, { ...slack, channel: 'finance' })).toBeUndefined();
  });

  it('matches an upper-case identifier by case, so a team LOG is not the verb', (): void => {
    const charter = {
      ...priyaCharter,
      proposedBoundaries: { ...priyaCharter.proposedBoundaries, willDo: ['Log each exception as it comes in.'] },
    };
    expect(willDoClauseNaming(charter, { surface: 'Tracker', slug: 'tracker', team: 'LOG' })).toBeUndefined();
  });

  it('names nothing for a charter without willDo clauses', (): void => {
    const charter = {
      ...priyaCharter,
      proposedBoundaries: { ...priyaCharter.proposedBoundaries, willDo: [] },
    };
    expect(willDoClauseNaming(charter, { ...linear, team: 'REVOPS' })).toBeUndefined();
  });
});
