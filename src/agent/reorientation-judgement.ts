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

/** What a card's judgement reads and writes of its card, as the action reaches the store. */
export interface ProposalStore {
  /** The card as the judgement reads it, or null when it is decided, gone or already proposed. */
  read(): Promise<{ readonly input: ProposalInput; readonly basis: string } | null>;
  /** Write the proposal onto the card the judgement read. */
  write(proposed: JudgedProposal, basis: string): Promise<void>;
  /** Record that no proposal could be had, with why. */
  fail(reason: string, basis: string | undefined): Promise<void>;
}

/**
 * Ask what one card proposes and write the answer, recording a failure for anything that goes
 * wrong on the way (W16-R23): a judgement the model could not give, and also a read or a write
 * that throws, which once left the card pending for good with nothing said.
 *
 * @param store - The card's store.
 * @param call - The model call; the deployment's client unless a test injects one.
 * @returns What became of the card's proposal.
 */
export async function proposeOnCard(
  store: ProposalStore,
  call?: ProposalJudgementCall,
): Promise<'proposed' | 'failed' | 'nothing'> {
  let basis: string | undefined;
  try {
    const read = await store.read();
    if (read === null) return 'nothing';
    basis = read.basis;
    const judged = await judgeProposal(read.input, call);
    if (judged.outcome === 'proposed') {
      await store.write(judged.proposed, read.basis);
      return 'proposed';
    }
    await store.fail(judged.reason, basis);
  } catch (err: unknown) {
    await store.fail(safeFailureMessage(err, '', 'the judgement failed', FAILURE_CHARS), basis);
  }
  return 'failed';
}

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
