/**
 * The reorientation proposal's model call (wave 16, 16-O; decision O-2): the prompt and the
 * reading of the reply are `src/agent/reorientation-proposal.ts`; this module only makes the call,
 * injected so a test answers it in-process. A failure, or a reply the card's candidates refuse,
 * is answered as `unavailable` with its reason, and the card stays with nothing proposed.
 */

import { agentJson, makeAgent } from '../lib/mastra';
import { safeFailureMessage } from '../surfaces/redact';
import {
  REORIENTATION_PROPOSAL_SYSTEM,
  proposalOf,
  proposalPrompt,
  proposalReplySchema,
  type JudgedProposal,
  type ProposalInput,
  type ProposalReply,
} from './reorientation-proposal';

/** The proposal judgement's model call: the rendered prompt in, the answer out. */
export type ProposalJudgementCall = (user: string) => Promise<ProposalReply>;

/** The judgement's agent, made on first use so importing this module costs no client call. */
let proposalAgent: ReturnType<typeof makeAgent> | undefined;

/** The proposal judgement through the deployment's model client. */
const proposalModelCall: ProposalJudgementCall = async (user) => {
  proposalAgent ??= makeAgent('day0-reorientation-proposal', REORIENTATION_PROPOSAL_SYSTEM);
  return await agentJson<ProposalReply>({
    agent: proposalAgent,
    user,
    schema: proposalReplySchema,
  });
};

/** The judgement's answer, or why none could be had. */
export type ProposalOutcome =
  | { readonly outcome: 'proposed'; readonly proposed: JudgedProposal }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/** The most of a failure's reason a card keeps. */
const FAILURE_CHARS = 300;

/**
 * Ask what one card proposes.
 *
 * @param input - The card as the judgement reads it.
 * @param call - The model call; the deployment's client unless a test injects one.
 */
export async function judgeProposal(
  input: ProposalInput,
  call: ProposalJudgementCall = proposalModelCall,
): Promise<ProposalOutcome> {
  try {
    const reply = await call(proposalPrompt(input));
    return { outcome: 'proposed', proposed: proposalOf(reply, input.candidates) };
  } catch (err: unknown) {
    // Its first line, with any credential shape a provider echoed removed, as a run's failure is.
    return {
      outcome: 'unavailable',
      reason: safeFailureMessage(err, '', 'the judgement failed', FAILURE_CHARS),
    };
  }
}
