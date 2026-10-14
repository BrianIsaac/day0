/**
 * The reorientation proposal's model call (wave 16, 16-O; decision O-2): the prompt and the
 * reading of the reply are `src/agent/reorientation-proposal.ts`; this module only makes the call,
 * injected so a test answers it in-process. A failure, or a reply the card's candidates refuse,
 * is answered as `unavailable` with its reason, and the card stays with nothing proposed.
 */

import { agentJson, makeAgent } from '../lib/mastra';
import {
  ModelRefusalError,
  ModelReplyCutError,
  StructuredContractError,
} from '../lib/structured-fallback';
import { transportFailureKind } from '../lib/transport-error';
import { safeFailureMessage } from '../surfaces/redact';
import type { ProposalFailureKind } from './reorientation-words';
import {
  REORIENTATION_PROPOSAL_SYSTEM,
  ProposalRefused,
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

/**
 * The judgement's answer, or why none could be had: the kind the card says, and the failure's
 * first line through the token scrub for the function log only (W17-R8).
 */
export type ProposalOutcome =
  | { readonly outcome: 'proposed'; readonly proposed: JudgedProposal }
  | {
      readonly outcome: 'unavailable';
      readonly kind: ProposalFailureKind;
      readonly detail: string;
    };

/** The most of a failure's reason a card keeps. */
const FAILURE_CHARS = 300;

/** What a card's judgement reads and writes of its card, as the action reaches the store. */
export interface ProposalStore {
  /** The card as the judgement reads it, or null when it is decided, gone or already proposed. */
  read(): Promise<{ readonly input: ProposalInput; readonly basis: string } | null>;
  /** Write the proposal onto the card the judgement read. */
  write(proposed: JudgedProposal, basis: string): Promise<void>;
  /**
   * Record that no proposal could be had: its kind for the card, and its first line, scrubbed, for
   * the function log.
   */
  fail(kind: ProposalFailureKind, basis: string | undefined, detail: string): Promise<void>;
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
    await store.fail(judged.kind, basis, judged.detail);
  } catch (err: unknown) {
    await store.fail('failed', basis, failureDetail(err));
  }
  return 'failed';
}

/** A failure's first line, with any credential shape a provider echoed removed, as a run's is. */
function failureDetail(err: unknown): string {
  return safeFailureMessage(err, '', 'the judgement failed', FAILURE_CHARS);
}

/**
 * What kind of failure a judgement met (W17-R8): a reply the card's candidates or the schema
 * refuse, or one cut off, could not be read; a provider's refusal on content, or an HTTP answer
 * or a refused connection from it, was its provider refusing the request; a spent budget or a cut
 * connection was the model not answering in time; anything else failed.
 */
export function proposalFailureKind(err: unknown): ProposalFailureKind {
  if (
    err instanceof ProposalRefused ||
    err instanceof StructuredContractError ||
    err instanceof ModelReplyCutError
  ) {
    return 'unreadable';
  }
  if (err instanceof ModelRefusalError) return 'refused';
  if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
  const transport = transportFailureKind(err);
  if (transport === 'interrupted') return 'timeout';
  const status = (err as { statusCode?: unknown; status?: unknown } | null)?.statusCode;
  if (transport === 'refused' || typeof status === 'number') return 'refused';
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
    return { outcome: 'unavailable', kind: proposalFailureKind(err), detail: failureDetail(err) };
  }
}
