import { beforeEach, describe, expect, it, vi } from 'vitest';
import { evaluateCandidate } from '../../../src/work/evaluate';
import { charterJudgementPrompt, isAuthorityClause, type ScopeJudgement } from '../../../src/work/scope';
import {
  L_REASON,
  fin1,
  mateoCharter,
  noSkill,
  priyaCharter,
  revops27,
  runContext,
} from './scope-run-fixtures-2026-09-19';

/**
 * Finding L of the second full run (19 Sep 2026). FIN-1 was skipped
 * "out-of-scope: The charter's willNotDo forbids posting the status note
 * without asking until the manager approves autonomous posting": a clause
 * about who approves, which supervision already enforces (the plan is held
 * for the manager), read as a clause about what the role does. The common
 * wordings are detected here, shown to the model apart from the exclusions,
 * and never accepted as the citation a skip needs. A re-evaluation of a row
 * already judged in scope holds that judgement and asks no model.
 */

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
    return next;
  },
}));

const AUTHORITY = 'Post the status note without asking until the manager decides otherwise.';

const runSkip = {
  inScope: false,
  fit: true,
  reason: L_REASON,
  exclusion: { kind: 'will-not-do', quote: AUTHORITY },
};

async function evaluate(
  candidate: Parameters<typeof evaluateCandidate>[0],
  ctx: Parameters<typeof evaluateCandidate>[1],
  lookups = noSkill,
): Promise<{ verdict: Awaited<ReturnType<typeof evaluateCandidate>>; judgements: ScopeJudgement[] }> {
  const judgements: ScopeJudgement[] = [];
  const verdict = await evaluateCandidate(candidate, ctx, lookups, {
    onScopeJudgement: (judgement): void => void judgements.push(judgement),
  });
  return { verdict, judgements };
}

beforeEach((): void => {
  model.calls.length = 0;
  model.answers.length = 0;
});

describe('clauses about who approves are not scope exclusions (finding L, FIN-1)', (): void => {
  it.each([
    "Send anything out without the manager's approval.",
    'Post the status note without asking until the manager decides otherwise.',
    'Post updates without asking until the manager decides otherwise.',
    "Send any customer notice out without the desk lead's approval.",
    'Post in channels or to customers independently until the manager decides when posting without asking is allowed.',
    'Do not post until the manager approves autonomous posting.',
    'Never send a notice without first checking with the desk lead.',
    'Do not close tickets without sign-off.',
    'No outbound message before the manager has approved it.',
    'Do not post unless the manager agrees.',
    'Sending nothing out without the manager.',
  ])('reads "%s" as authority', (clause): void => {
    expect(isAuthorityClause(clause)).toBe(true);
  });

  it.each([
    'Access or work in Northstar CRM until there is an approved way in.',
    'Access or work in NetLedger directly.',
    "Change the accounting team's step tickets in Linear.",
    "Own Linear or Slack administration (the admins' lane).",
    'Handle non-exception logistics desk work outside the Shipment exceptions project.',
    'Do not act on requests from Priya before the manager introduction.',
    'Do not update the Q4 Revenue Tracker or any revenue record.',
    'Work tickets without a project.',
  ])('reads "%s" as an exclusion', (clause): void => {
    expect(isAuthorityClause(clause)).toBe(false);
  });

  it('does not let the run\'s skip stand: the clause it quotes is met by supervision', async (): Promise<void> => {
    model.answers.push(runSkip, runSkip);

    const { verdict, judgements } = await evaluate(fin1, runContext('mateo'));

    expect(verdict.decision).toBe('needs-skill');
    expect(judgements).toEqual([
      {
        admitted: true,
        basis: 'source-named',
        namedBy: 'Read the September close step tickets in Linear (team FIN, project September close).',
        overruled: [L_REASON, L_REASON],
      },
    ]);
    expect(model.calls).toHaveLength(2);
    expect(model.calls[1]!.user).toContain('met by supervision');
  });

  it('still lets a skip stand on an exclusion of the same charter', async (): Promise<void> => {
    model.answers.push({
      inScope: false,
      fit: true,
      reason: 'The reconciliation is done in NetLedger.',
      exclusion: { kind: 'will-not-do', quote: 'Access or work in NetLedger directly.' },
    });

    const { verdict } = await evaluate(fin1, runContext('mateo'));

    expect(verdict.decision).toBe('skip');
    expect(model.calls).toHaveLength(1);
  });

  it('shows the model the authority clauses apart from the exclusions, as met by supervision', (): void => {
    const prompt = charterJudgementPrompt({ candidate: fin1, charter: mateoCharter, agentsMd: '' });

    expect(prompt).toContain(
      "willNotDo: Change the accounting team's step tickets in Linear. | Access or work in NetLedger directly.",
    );
    expect(prompt).toContain(
      "authority (met by supervision: every plan is held for the manager; never a reason a request is outside the role): Send anything out without the manager's approval. | Post the status note without asking until the manager decides otherwise.",
    );
    expect(prompt).not.toMatch(/^willNotDo: .*without asking/m);
  });

  it('leaves the prompt of a charter without such clauses as it was', (): void => {
    const charter = {
      ...priyaCharter,
      proposedBoundaries: {
        ...priyaCharter.proposedBoundaries,
        willNotDo: ['Access or work in Northstar CRM until there is an approved way in.'],
      },
    };
    const prompt = charterJudgementPrompt({ candidate: revops27, charter, agentsMd: '' });

    expect(prompt).toContain('willNotDo: Access or work in Northstar CRM until there is an approved way in.\n');
    expect(prompt).not.toContain('authority (');
  });
});

describe('a row already judged in scope is not judged again', (): void => {
  it('asks no model, runs the rest of the chain and reaches the skill match', async (): Promise<void> => {
    const findMatchingSkill = vi.fn(async () => ({ name: 'kanban-comment-and-close', description: '' }));

    const { verdict, judgements } = await evaluate(
      fin1,
      runContext('mateo', 'real', { scopeHeld: true }),
      { ...noSkill, findMatchingSkill },
    );

    expect(verdict.decision).toBe('claim');
    expect(judgements).toEqual([{ admitted: true, basis: 'held' }]);
    expect(findMatchingSkill).toHaveBeenCalledTimes(1);
    expect(model.calls).toEqual([]);
  });

  it('still refuses on the lexical inputs when nothing ties the item to the charter any more', async (): Promise<void> => {
    const { verdict } = await evaluate(
      { ...fin1, sourceSystem: 'boss', title: 'Water the plants', contentSummary: 'Every Friday.' },
      runContext('mateo', 'real', { scopeHeld: true, surfaces: [] }),
    );

    expect(verdict).toEqual({
      decision: 'skip',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    });
  });

  it('ignores the flag in mock mode', async (): Promise<void> => {
    const { judgements } = await evaluate(fin1, runContext('mateo', 'mock', { scopeHeld: true }));

    expect(judgements).toEqual([{ admitted: true, basis: 'charter-overlap' }]);
    expect(model.calls).toEqual([]);
  });
});
