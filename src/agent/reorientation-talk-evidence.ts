import { withoutAgentQuotedEvidence, type Charter } from './charter';
import type { OneToOneTurn } from './one-to-one-conversation';
import { managerQuotes } from './reorientation-talk';

/*
 * The evidence a Discuss talk puts on its card, as the talk's route reads it (16-D; the wave file's
 * 5.3): the quotes the employee offered go through the charter's own guard against agent-quoted
 * evidence, with the manager's turns as the only evidence. Server-side and Node only: the guard
 * lives in `charter.ts`, which reaches Mastra, so the Convex store applies its floor
 * (`managerQuotes`) and never imports this module.
 */

/** A charter that carries nothing but the quotes, so the charter's own quote guard reads them. */
function quoteCarrier(quotes: readonly string[]): Charter {
  return {
    version: '0.0',
    source: 'reorientation-talk',
    whyThisHire: '',
    proposedFunction: '',
    evidence: quotes.map((text) => ({ text, source: 'manager, reorientation talk' })),
    shortTermGoals: { day30: '', day60: '', day90: '' },
    proposedBoundaries: { willDo: [], willNotDo: [], escalationTriggers: [] },
    namedCollaborators: [],
    namedSystems: [],
    priorityReading: [],
    adjacentRoles: [],
    approvalChain: { boss: '', confidence: 'low' },
    openQuestions: [],
    createdAt: '',
  };
}

/**
 * The words a talk's proposal rests on: each quote the employee offered is dropped by the
 * charter's own guard when it quotes the employee rather than the manager
 * (`withoutAgentQuotedEvidence`: six words the employee said and the manager never did), then held
 * to the store's floor (`managerQuotes`: the manager's own words, unbroken).
 *
 * @param quotes - What the `reorientationComplete` call offered.
 * @param turns - The talk as it stands, the answer that offered them last.
 */
export function talkQuotes(quotes: readonly string[], turns: readonly OneToOneTurn[]): string[] {
  const manager = turns.filter((kept) => kept.speaker === 'manager').map((kept) => kept.text);
  const employee = turns.filter((kept) => kept.speaker === 'employee').map((kept) => kept.text);
  const guarded = withoutAgentQuotedEvidence(quoteCarrier(quotes), { agent: employee, manager });
  return managerQuotes(
    guarded.charter.evidence.map((item) => item.text),
    turns,
  );
}
