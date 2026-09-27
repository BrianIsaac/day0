import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import { log } from '../lib/logger';
import { boundedQuestion } from './obligations';

/**
 * The one model judgement of whether a message asks the manager something the
 * run waits on (decision N20).
 *
 * The executor declares its question in its `openQuestion` field, and the
 * hold reads that first. A message that carries no declaration (a manager DM
 * an earlier run landed, or a set authored before the field existed) is read
 * by this judgement instead, never by a word list or a question mark: "Please
 * confirm which template the notice should use." asks, and "Can we ship
 * today?" quoted from the requester does not. One small call per message,
 * with the text bounded; the caller keeps the answer on the row.
 */

/** The most of a message the judgement reads. */
export const JUDGED_TEXT_CHARS = 2000;

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0, reading a message you wrote earlier in a piece of work.',
  'Decide one thing: does the message ask the manager something the work waits on? That is a question or a request for a decision or a confirmation that the manager must answer before a withheld write can land.',
  '',
  'It asks when it puts a question or a request to the manager, in any language and whether or not it ends in a question mark: "Please confirm which template the notice should use." and "请确认通知使用哪个模板。" both ask.',
  'It does not ask when it only reports what was done or found, sends a draft for approval (the approval is the answer), quotes a question someone else asked, closes politely ("Let me know if you need anything else"), or asks rhetorically.',
  '',
  'Answer `asks`, and in `question` the sentence or sentences that ask, copied word for word from the message, or null when it does not ask.',
].join('\n');

const judgementSchema = z.object({
  asks: z.boolean(),
  question: z.string().nullable(),
});

/** What the model answers about one message. */
export type QuestionJudgement = z.infer<typeof judgementSchema>;

/** The model call behind the judgement: the rendered message in, the answer out. */
export type QuestionJudgementCall = (user: string) => Promise<QuestionJudgement>;

/** The judgement's agent, made on first use so importing this module costs no client call. */
let questionAgent: ReturnType<typeof makeAgent> | undefined;

/** The judgement through the deployment's model client. */
const modelCall: QuestionJudgementCall = async (user) => {
  questionAgent ??= makeAgent('day0-manager-question', SYSTEM_PROMPT);
  return await agentJson<QuestionJudgement>({
    agent: questionAgent,
    user,
    schema: judgementSchema,
  });
};

/**
 * The message as the judgement reads it, bounded.
 *
 * @param text - The message text.
 * @returns The user prompt.
 */
export function questionJudgementPrompt(text: string): string {
  const bounded = text.length > JUDGED_TEXT_CHARS ? `${text.slice(0, JUDGED_TEXT_CHARS)}…` : text;
  return ['--- Message ---', bounded, '--- End of message ---'].join('\n');
}

/**
 * Whether a message asks the manager something the run waits on, and what.
 *
 * Fails closed: a judgement that cannot be had reads the message as asking,
 * so the writes that wait on an answer stay withheld and the manager sees the
 * message on the card. A held write costs a click; a write sent over an open
 * question cannot be taken back.
 *
 * @param text - The message, as it was sent or as the notes say it.
 * @param call - The model call; the deployment's client unless a test injects one.
 * @returns The question as the message puts it, bounded, or null when it asks nothing.
 */
export async function judgeManagerQuestion(
  text: string,
  call: QuestionJudgementCall = modelCall,
): Promise<string | null> {
  if (text.trim() === '') return null;
  let judgement: QuestionJudgement;
  try {
    judgement = await call(questionJudgementPrompt(text));
  } catch (err: unknown) {
    log.warn('manager question judgement unavailable; holding as asked', {
      reason: err instanceof Error ? err.message : String(err),
    });
    return boundedQuestion(text);
  }
  if (!judgement.asks) return null;
  const question = judgement.question?.trim();
  return boundedQuestion(question ? question : text);
}
