/**
 * The two model judgements of working agreements (decision N20: the model declares; W1 and W2,
 * F10 and F11): whether a statement would go beyond the charter, asked before any proposal is
 * shown and before any statement is kept, and whether two of an employee's corrections say the
 * same thing, asked at most once per new correction; and a charter's check of an agreement already
 * in effect for every employee, whose refusal is judged twice (RM32 (a)). Each call is injected, so
 * a test answers it in-process; each failure is answered as `unavailable`, and the caller shows and
 * keeps nothing unchecked.
 */

import type { SpanModel } from '../redaction/client';
import { redactText } from '../redaction/redact';
import { agentJson, makeAgent } from '../lib/mastra';
import {
  REFUSAL_JUDGEMENT_SYSTEM,
  SAMENESS_JUDGEMENT_SYSTEM,
  judgedTwice,
  redactedStatement,
  refusalJudgementPrompt,
  refusalJudgementSchema,
  refusalOf,
  sameGroups,
  samenessJudgementPrompt,
  samenessJudgementSchema,
  type CharterBounds,
  type JudgedCorrection,
  type RefusalJudgement,
  type SamenessJudgement,
  type StatementRefusal,
} from './agreements';

/** The refusal judgement's model call: the rendered prompt in, the answer out. */
export type RefusalJudgementCall = (user: string) => Promise<RefusalJudgement>;

/** The sameness judgement's model call: the rendered prompt in, the answer out. */
export type SamenessJudgementCall = (user: string) => Promise<SamenessJudgement>;

/** The judgements' agents, made on first use so importing this module costs no client call. */
let refusalAgent: ReturnType<typeof makeAgent> | undefined;
let samenessAgent: ReturnType<typeof makeAgent> | undefined;

/** The refusal judgement through the deployment's model client. */
const refusalModelCall: RefusalJudgementCall = async (user) => {
  refusalAgent ??= makeAgent('day0-agreement-refusal', REFUSAL_JUDGEMENT_SYSTEM);
  return await agentJson<RefusalJudgement>({
    agent: refusalAgent,
    user,
    schema: refusalJudgementSchema,
  });
};

/** The sameness judgement through the deployment's model client. */
const samenessModelCall: SamenessJudgementCall = async (user) => {
  samenessAgent ??= makeAgent('day0-agreement-sameness', SAMENESS_JUDGEMENT_SYSTEM);
  return await agentJson<SamenessJudgement>({
    agent: samenessAgent,
    user,
    schema: samenessJudgementSchema,
  });
};

/** Why a judgement could not be had, in a few words. */
function unavailableReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A statement after its check: kept, refused with why, or not checked because the judgement failed. */
export type CheckedStatement =
  | {
      readonly outcome: 'kept';
      readonly statement: string;
      readonly redaction?: 'structural-only';
    }
  | {
      readonly outcome: 'refused';
      readonly statement: string;
      readonly refusal: StatementRefusal;
      readonly redaction?: 'structural-only';
    }
  | { readonly outcome: 'unavailable'; readonly statement: string; readonly reason: string };

/** What a statement is checked against, and the redaction's inputs. */
export interface StatementCheck {
  /** The charters it would bind: its employee's, or every employee's of the owner. */
  readonly charters: readonly CharterBounds[];
  /** The span model, when one is configured. */
  readonly model?: SpanModel;
  /** The owner's stored values, for the exact layer. */
  readonly known: readonly string[];
}

/** A statement as the redaction leaves it, with the refusal the redaction alone amounts to. */
interface RedactedForCheck {
  readonly statement: string;
  readonly degraded: { readonly redaction?: 'structural-only' };
  /** Set when the redaction removed a secret: refused with no judgement. */
  readonly refused?: Extract<CheckedStatement, { outcome: 'refused' }>;
}

/** Redact a statement for its check: one that named a credential is refused there, unjudged. */
async function redactedForCheck(text: string, check: StatementCheck): Promise<RedactedForCheck> {
  const redacted = await redactedStatement(text, { model: check.model, known: check.known });
  const degraded = redacted.redaction ? { redaction: redacted.redaction } : {};
  if (!redacted.namesCredential) return { statement: redacted.statement, degraded };
  return {
    statement: redacted.statement,
    degraded,
    refused: {
      outcome: 'refused',
      statement: redacted.statement,
      refusal: { reason: 'names-credential' },
      ...degraded,
    },
  };
}

/** One judgement of a redacted statement: the refusal it amounts to, or undefined when kept. */
async function judgedOnce(
  statement: string,
  charters: readonly CharterBounds[],
  call: RefusalJudgementCall,
): Promise<StatementRefusal | undefined> {
  return refusalOf(await call(refusalJudgementPrompt(statement, charters)), charters);
}

/**
 * Check a statement before it is shown as a proposal or kept as an agreement (F11): redact it as
 * every stored manager text is, refuse it at once when the redaction removed a secret (it named a
 * credential), and otherwise ask the model whether it widens the scope, grants a permission, names
 * a credential or contradicts a kept `willNotDo` clause, quoting the clause.
 *
 * @param text - The manager's words.
 * @param check - The charters, the span model and the owner's stored values.
 * @param call - The model call; the deployment's client unless a test injects one.
 * @returns The redacted statement and the outcome; `unavailable` when the judgement failed.
 */
export async function checkStatement(
  text: string,
  check: StatementCheck,
  call: RefusalJudgementCall = refusalModelCall,
): Promise<CheckedStatement> {
  const { statement, degraded, refused } = await redactedForCheck(text, check);
  if (refused) return refused;
  let refusal: StatementRefusal | undefined;
  try {
    refusal = await judgedOnce(statement, check.charters, call);
  } catch (err: unknown) {
    return { outcome: 'unavailable', statement, reason: unavailableReason(err) };
  }
  return refusal
    ? { outcome: 'refused', statement, refusal, ...degraded }
    : { outcome: 'kept', statement, ...degraded };
}

/**
 * An agreement for every employee after a charter's check (RM32 (a)): as {@link CheckedStatement},
 * and `disputed` when one of the two judgements refused it and the other kept it, with the one
 * refusal.
 */
export type CharterChecked =
  | CheckedStatement
  | {
      readonly outcome: 'disputed';
      readonly statement: string;
      readonly refusal: StatementRefusal;
      readonly redaction?: 'structural-only';
    };

/**
 * Check an agreement already in effect for every employee against one employee's newly approved
 * charter (RM32 (a)): as {@link checkStatement}, except that a refusal, which would end the
 * agreement for every employee, is judged a second time with the same prompt. Refused only when
 * both judgements refuse; `disputed` when the second keeps it, which holds the agreement for that
 * employee alone. A second judgement that could not be had leaves the check `unavailable`, to be
 * tried again, never settled on the one. A credential the redaction removed is refused at once:
 * that is no judgement, and a second reading of it would find the same.
 *
 * @param text - The agreement's words.
 * @param check - The employee's charter, the span model and the owner's stored values.
 * @param call - The model call; the deployment's client unless a test injects one.
 */
export async function checkAgainstCharter(
  text: string,
  check: StatementCheck,
  call: RefusalJudgementCall = refusalModelCall,
): Promise<CharterChecked> {
  const { statement, degraded, refused } = await redactedForCheck(text, check);
  if (refused) return refused;
  try {
    const first = await judgedOnce(statement, check.charters, call);
    if (first === undefined) return { outcome: 'kept', statement, ...degraded };
    const second = await judgedOnce(statement, check.charters, call);
    return { ...judgedTwice(first, second), statement, ...degraded };
  } catch (err: unknown) {
    return { outcome: 'unavailable', statement, reason: unavailableReason(err) };
  }
}

/** The sameness judgement's answer, or why it could not be had. */
export type SamenessOutcome =
  | { readonly outcome: 'judged'; readonly groups: string[][] }
  | { readonly outcome: 'unavailable'; readonly reason: string };

/**
 * Which of an employee's active corrections say the same thing (F10). Nothing is asked with fewer
 * than two corrections, or with no new one among them and none that could join a waiting
 * proposal, since no group could be kept.
 *
 * Each correction's words and the title of the item it was given on reach the model only through
 * `redactText` for a prompt, the owner's stored values first, as every other prompt path of a
 * correction does (W13-R4): a manager who pasted a token into a rejection reason sends a
 * placeholder.
 *
 * @param corrections - The employee's active corrections, the new ones marked.
 * @param redaction - The owner's stored values and the span model the words are redacted with.
 * @param call - The model call; the deployment's client unless a test injects one.
 * @returns The groups, oldest first in each, or `unavailable` when the judgement failed.
 */
export async function judgeSameness(
  corrections: readonly JudgedCorrection[],
  redaction: { readonly model?: SpanModel; readonly known: readonly string[] },
  call: SamenessJudgementCall = samenessModelCall,
): Promise<SamenessOutcome> {
  const joinable =
    corrections.some((correction) => correction.inProposal === true) &&
    corrections.some((correction) => correction.inProposal !== true);
  if (corrections.length < 2 || !(corrections.some((correction) => correction.isNew) || joinable)) {
    return { outcome: 'judged', groups: [] };
  }
  try {
    const scrub = async (value: string): Promise<string> =>
      (
        await redactText(value, 'prompt', {
          model: redaction.model,
          known: redaction.known,
          onUnavailable: 'structural',
        })
      ).text;
    const redacted: JudgedCorrection[] = [];
    for (const correction of corrections) {
      redacted.push({
        ...correction,
        text: await scrub(correction.text),
        itemTitle: await scrub(correction.itemTitle),
      });
    }
    const reply = await call(samenessJudgementPrompt(redacted));
    return { outcome: 'judged', groups: sameGroups(reply, corrections) };
  } catch (err: unknown) {
    return { outcome: 'unavailable', reason: unavailableReason(err) };
  }
}
