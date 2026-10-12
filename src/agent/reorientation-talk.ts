import type { UIMessageChunk } from 'ai';
import { z } from 'zod';
import {
  MOVED_ON_REFUSAL,
  REPLY_MAX_CHARS,
  answerFailure,
  decideTurn,
  repliesIn,
  withKeptMark,
  type OneToOneTurn,
  type SentReply,
  type TurnDecision,
  type TurnRequest,
} from './one-to-one-conversation';
import { proposalReplySchema, type ProposalReply } from './reorientation-proposal';
import { REORIENTATION_COMPLETE, REORIENTATION_COMPLETE_TOOL } from './reorientation-talk-prompts';
import { errorMessage } from '../lib/errors';
import { log } from '../lib/logger';

/*
 * The Discuss conversation's pure rules (wave 16, 16-D; the wave file's section 5.3, RM10 (a)): a
 * conversation of its own about one reorientation card, kept on its own row
 * (`convex/reorientationTalk.ts`) by the one-to-one's turn and answer rules unchanged
 * (`decideTurn`, `decideAnswer`, the 40-turn bound), and ending in a proposal on the card, never
 * an application. The one-to-one's session and its readers never see a talk.
 */

/**
 * What the room asks of a talk before its turn is put to the employee: one of the one-to-one's
 * three turns, or `finish`, which puts the talk on the card from what was said. A finish names the
 * room's position as a reply does, so a reply whose send never reached the talk is kept first.
 */
export type TalkTurnRequest =
  | TurnRequest
  | {
      readonly kind: 'finish';
      readonly question: string | null;
      readonly replies: readonly SentReply[];
    };

/** The one-to-one's refusals that name the one-to-one's own ending, in the talk's words. */
const TALK_REFUSALS: Readonly<Record<string, string>> = {
  'The one-to-one is as long as it can be. Finish it to draft the charter.':
    'The talk is as long as it can be. Put it on the card from what was said.',
  'The one-to-one is already over.': 'The talk is already over.',
};

/**
 * A refusal of the one-to-one's rules as the talk says it: the talk is named where the one-to-one
 * was, and the bound's way on is the card rather than the charter.
 */
export function talkRefusal(refusal: string): string {
  return TALK_REFUSALS[refusal] ?? refusal.replace(/^The one-to-one\b/, 'The talk');
}

/** Said to a finish before the manager has answered anything. */
export const TALK_NOTHING_SAID = 'Answer at least once before putting this on the card.';

/** The bound's refusal as the talk says it: the reply would leave no room for its answer. */
const TALK_BOUND_REFUSAL = talkRefusal(
  'The one-to-one is as long as it can be. Finish it to draft the charter.',
);

/**
 * A talk turn decided: the one-to-one's decision, and for a finish, the replies it carried that
 * the talk had no room left to keep (`unkept`), which the room hands back to the manager.
 */
export type TalkTurnDecision =
  | (Extract<TurnDecision, { ok: true }> & { readonly unkept?: readonly SentReply[] })
  | Extract<TurnDecision, { ok: false }>;

/**
 * Decide a turn of a talk against the turns it keeps: the opening, a reply and a turn asked again
 * by the one-to-one's own rules (`decideTurn`), and a finish, which keeps any reply it carries and
 * otherwise only checks the room is where the talk is. A finish keeps no employee turn of its own,
 * so it is taken at the 40-turn bound too: a reply it carries that no longer fits is not kept, and
 * the finish goes on from the turns kept, naming that reply (`unkept`). Every refusal is said in
 * the talk's words.
 *
 * @param now - When a reply is kept, in milliseconds.
 */
export function decideTalkTurn(
  turns: readonly OneToOneTurn[],
  request: TalkTurnRequest,
  now: number,
): TalkTurnDecision {
  const decision =
    request.kind === 'finish' ? decideFinish(turns, request, now) : decideTurn(turns, request, now);
  return decision.ok ? decision : { ok: false, refusal: talkRefusal(decision.refusal) };
}

/** A finish: the room's unsent replies kept first where they fit, then at least one reply needed. */
function decideFinish(
  turns: readonly OneToOneTurn[],
  request: Extract<TalkTurnRequest, { kind: 'finish' }>,
  now: number,
): TalkTurnDecision {
  const kept =
    request.replies.length > 0
      ? decideTurn(
          turns,
          { kind: 'reply', question: request.question, replies: request.replies },
          now,
        )
      : undefined;
  const decision: TalkTurnDecision =
    kept === undefined || (!kept.ok && talkRefusal(kept.refusal) === TALK_BOUND_REFUSAL)
      ? asItStands(turns, request.question, request.replies)
      : kept;
  if (!decision.ok) return decision;
  if (repliesIn(decision.turns) === 0) return { ok: false, refusal: TALK_NOTHING_SAID };
  return decision;
}

/**
 * The talk as it stands, when the room stands where it does: the room's question is the talk's last
 * employee turn and every reply the talk kept after it is the first of the room's. The room's other
 * replies are the ones not kept.
 */
function asItStands(
  turns: readonly OneToOneTurn[],
  question: string | null,
  replies: readonly SentReply[],
): TalkTurnDecision {
  const asked = turns.findLastIndex((turn) => turn.speaker === 'employee');
  if (asked === -1) return { ok: false, refusal: TALK_NOTHING_SAID };
  const held = turns.slice(asked + 1);
  if (
    turns[asked].id !== question ||
    held.length > replies.length ||
    held.some((turn, index) => turn.id !== replies[index].id)
  ) {
    return { ok: false, refusal: MOVED_ON_REFUSAL };
  }
  const unkept = replies.slice(held.length);
  return {
    ok: true,
    turns,
    answering: null,
    replied: false,
    ...(unkept.length > 0 ? { unkept } : {}),
  };
}

/** The most quotes a talk's outcome keeps. */
export const QUOTES_LIMIT = 5;

/** A text as the words it is made of, in any script: lower case, everything else a space. */
function normalised(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** A script written without spaces between its words, whose words a space cannot find. */
const UNSPACED_SCRIPT =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Thai}]/u;

/**
 * Whether the manager said `quote` within `said`, unbroken: its words in order at word boundaries,
 * or, in a script with no spaces between its words, its characters in order.
 */
function saidWithin(quote: string, said: string): boolean {
  const needle = normalised(quote);
  if (needle === '') return false;
  const haystack = normalised(said);
  if (` ${haystack} `.includes(` ${needle} `)) return true;
  return UNSPACED_SCRIPT.test(needle) && haystack.includes(needle);
}

/** The most quotes a call's input is read for: past it, the rest are never weighed. */
const QUOTES_READ = 50;

/**
 * The words a talk's proposal rests on, with the manager's turns as the only evidence: a quote is
 * kept only where the manager's own words run through it unbroken, so a phrase only the employee
 * said never stands (an employee's phrase the manager said too is the manager's). Trimmed, each
 * kept once, at most `QUOTES_LIMIT`. The store's floor (`convex/reorientationTalk.ts`), which a
 * direct caller of its public mutations meets too; the route first passes the quotes through the
 * charter's own guard (`talkQuotes`, `src/agent/reorientation-talk-evidence.ts`), which the
 * Convex runtime cannot bundle.
 *
 * @param quotes - What the `reorientationComplete` call offered.
 * @param turns - The talk as it stands.
 */
export function managerQuotes(quotes: readonly string[], turns: readonly OneToOneTurn[]): string[] {
  const said = turns.filter((kept) => kept.speaker === 'manager').map((kept) => kept.text);
  return [
    ...new Set(
      quotes
        .slice(0, QUOTES_READ)
        .map((quote) => quote.replace(/\s+/g, ' ').trim())
        .filter(Boolean),
    ),
  ]
    .filter((quote) => quote.length <= REPLY_MAX_CHARS)
    .filter((quote) => said.some((text) => saidWithin(quote, text)))
    .slice(0, QUOTES_LIMIT);
}

/**
 * The `reorientationComplete` call's input: the judgement's flat proposal reply
 * (`proposalReplySchema`, nulls and all, so a strict schema mode takes it), the manager's words it
 * rests on and a closing line, each field described as the tool tells the model.
 */
export const talkOutcomeSchema = z.object({
  change: proposalReplySchema.shape.change.describe(REORIENTATION_COMPLETE_TOOL.change),
  candidate: proposalReplySchema.shape.candidate.describe(REORIENTATION_COMPLETE_TOOL.candidate),
  action: proposalReplySchema.shape.action.describe(REORIENTATION_COMPLETE_TOOL.action),
  text: proposalReplySchema.shape.text.describe(REORIENTATION_COMPLETE_TOOL.text),
  rationale: proposalReplySchema.shape.rationale.describe(REORIENTATION_COMPLETE_TOOL.rationale),
  quotes: z.array(z.string()).describe(REORIENTATION_COMPLETE_TOOL.quotes),
  closingLine: z.string().describe(REORIENTATION_COMPLETE_TOOL.closingLine),
});

/** What a talk ends in, as the route hands it to the store: the reply and its quotes. */
export interface TalkOutcome {
  readonly reply: ProposalReply;
  readonly quotes: readonly string[];
}

/** An employee turn of a talk that stood, as the store keeps it. */
export interface TalkAnswer {
  readonly id: string;
  readonly text: string;
  /** Present when the turn called `reorientationComplete`. */
  readonly outcome?: TalkOutcome;
}

/**
 * Keep a talk's answer. Resolves to null once it is kept, or to the sentence the room shows when
 * the store would not keep it; a rejection is logged and said as `TALK_ANSWER_NOT_KEPT`.
 */
export type KeepTalkAnswer = (answer: TalkAnswer) => Promise<string | null>;

/** What the room is told when the answer it was shown could not be kept. */
export const TALK_ANSWER_NOT_KEPT = 'Day0 could not keep that answer';

/** What `keptTalkAnswer` needs beside the stream. */
export interface KeptTalkAnswerOptions {
  /** The id the room draws the turn under, which the store keeps it under too. */
  readonly messageId: string;
  readonly keep: KeepTalkAnswer;
}

/** The outcome a call's input stands for, or undefined for one in a shape the tool does not take. */
function outcomeOf(input: unknown): { outcome: TalkOutcome; closingLine: string } | undefined {
  const parsed = talkOutcomeSchema.safeParse(input);
  if (!parsed.success) return undefined;
  const { quotes, closingLine, ...reply } = parsed.data;
  return { outcome: { reply, quotes }, closingLine: closingLine.trim() };
}

/**
 * The outcome the first `reorientationComplete` call among a model's tool calls carried, when it
 * is in the tool's shape: what Put this on the card asked for.
 */
export function talkOutcomeOfCalls(
  calls: ReadonlyArray<{ readonly toolName: string; readonly input: unknown }>,
): TalkOutcome | undefined {
  return outcomeOf(calls.find((call) => call.toolName === REORIENTATION_COMPLETE)?.input)?.outcome;
}

/**
 * Why a model's tool calls carried no outcome, for the log (W16-R19, W1b): the tools it called, and
 * when it called `reorientationComplete` in a shape the tool does not take, the paths of the fields
 * the schema refused. Never the field's words, which are the model's and may quote the manager.
 */
export function talkOutcomeMiss(
  calls: ReadonlyArray<{ readonly toolName: string; readonly input: unknown }>,
): { readonly toolCalls: string[]; readonly refusedFields?: string[] } {
  const toolCalls = calls.map((call) => call.toolName);
  const call = calls.find((candidate) => candidate.toolName === REORIENTATION_COMPLETE);
  if (call === undefined) return { toolCalls };
  const parsed = talkOutcomeSchema.safeParse(call.input);
  return parsed.success
    ? { toolCalls }
    : {
        toolCalls,
        refusedFields: [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))],
      };
}

/**
 * Keep one employee turn of a talk as it finishes, before the room hears that it did: the
 * one-to-one's `keptAnswer` for a talk. The turn's `start` carries the id the store keeps it
 * under; its `finish` is held back until it is kept, and then carries the kept mark. A turn that
 * calls `reorientationComplete` is kept with its outcome, its closing line standing as its words
 * when it said nothing else; a call in a shape the tool does not take, a turn that failed
 * (`answerFailure`) and a turn cut off are not kept, so the room offers Ask again. A refusal to
 * keep is said as an error before the finish.
 *
 * @param stream - One turn's UI message chunks.
 * @returns The same chunks, the start carrying the id and the finish after the keep.
 */
export function keptTalkAnswer(
  stream: ReadableStream<UIMessageChunk>,
  options: KeptTalkAnswerOptions,
): ReadableStream<UIMessageChunk> {
  let text = '';
  let called = false;
  let ending: ReturnType<typeof outcomeOf>;
  let finish: Extract<UIMessageChunk, { type: 'finish' }> | undefined;
  let broken = false;

  async function keep(): Promise<string | null> {
    const words = text.trim() !== '' ? text : (ending?.closingLine ?? '');
    try {
      return await options.keep({
        id: options.messageId,
        text: words,
        ...(ending === undefined ? {} : { outcome: ending.outcome }),
      });
    } catch (err: unknown) {
      // The server's own message is for the log; the room is told only that the answer was not kept.
      log.warn('reorientation talk answer not kept', { reason: errorMessage(err) });
      return TALK_ANSWER_NOT_KEPT;
    }
  }

  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller): void {
        if (chunk.type === 'start') {
          controller.enqueue({ ...chunk, messageId: options.messageId });
          return;
        }
        if (chunk.type === 'finish') {
          finish = chunk;
          return;
        }
        if (chunk.type === 'text-delta') text += chunk.delta;
        else if (
          chunk.type === 'tool-input-available' &&
          chunk.toolName === REORIENTATION_COMPLETE
        ) {
          called = true;
          ending = outcomeOf(chunk.input);
        } else if (chunk.type === 'error' || chunk.type === 'abort') broken = true;
        controller.enqueue(chunk);
      },
      async flush(controller): Promise<void> {
        if (!finish) return;
        const failure = answerFailure({
          text: text.trim() !== '' ? text : (ending?.closingLine ?? ''),
          closed: false,
          // A turn that ends in the tool's call finishes for the call, and is whole.
          finishReason: finish.finishReason === 'tool-calls' ? 'stop' : finish.finishReason,
        });
        if (broken || failure !== null || (called && ending === undefined)) {
          controller.enqueue(finish);
          return;
        }
        const refusal = await keep();
        if (refusal !== null) {
          controller.enqueue({ type: 'error', errorText: refusal });
          controller.enqueue(finish);
          return;
        }
        controller.enqueue({ ...finish, messageMetadata: withKeptMark(finish.messageMetadata) });
      },
    }),
  );
}
