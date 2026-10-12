import type { UIMessageChunk } from 'ai';
import { z } from 'zod';
import { withoutAgentQuotedEvidence, type Charter } from './charter';
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
import { errorMessage } from '../lib/errors';
import { log } from '../lib/logger';

/*
 * The Discuss conversation's pure rules (wave 16, 16-D; the wave file's section 5.3, RM10 (a)): a
 * conversation of its own about one reorientation card, kept on its own row
 * (`convex/reorientationTalk.ts`) by the one-to-one's turn and answer rules unchanged
 * (`decideTurn`, `decideAnswer`, the 40-turn bound), and ending in a proposal on the card, never
 * an application. The one-to-one's session and its readers never see a talk.
 */

/** The name of the tool a talk ends with, which the route offers and the room draws. */
export const REORIENTATION_COMPLETE = 'reorientationComplete';

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

/**
 * Decide a turn of a talk against the turns it keeps: the opening, a reply and a turn asked again
 * by the one-to-one's own rules (`decideTurn`), and a finish, which keeps any reply it carries and
 * otherwise only checks the room is where the talk is. A finish keeps no employee turn of its own,
 * so it is taken at the 40-turn bound too. Every refusal is said in the talk's words.
 *
 * @param now - When a reply is kept, in milliseconds.
 */
export function decideTalkTurn(
  turns: readonly OneToOneTurn[],
  request: TalkTurnRequest,
  now: number,
): TurnDecision {
  const decision =
    request.kind === 'finish' ? decideFinish(turns, request, now) : decideTurn(turns, request, now);
  return decision.ok ? decision : { ok: false, refusal: talkRefusal(decision.refusal) };
}

/** A finish: the room's unsent replies kept first, then at least one reply needed. */
function decideFinish(
  turns: readonly OneToOneTurn[],
  request: Extract<TalkTurnRequest, { kind: 'finish' }>,
  now: number,
): TurnDecision {
  const decision =
    request.replies.length > 0
      ? decideTurn(
          turns,
          { kind: 'reply', question: request.question, replies: request.replies },
          now,
        )
      : inStep(turns, request.question);
  if (!decision.ok) return decision;
  if (repliesIn(decision.turns) === 0) return { ok: false, refusal: TALK_NOTHING_SAID };
  return decision;
}

/** Whether a room that sent no replies stands where the talk does: on its last employee turn. */
function inStep(turns: readonly OneToOneTurn[], question: string | null): TurnDecision {
  const last = turns.at(-1);
  if (last === undefined) return { ok: false, refusal: TALK_NOTHING_SAID };
  if (last.speaker !== 'employee' || last.id !== question) {
    return { ok: false, refusal: MOVED_ON_REFUSAL };
  }
  return { ok: true, turns, answering: null, replied: false };
}

/** The most quotes a talk's outcome keeps. */
export const QUOTES_LIMIT = 5;

/** A text as the words it is made of, lower case, punctuation as space: the quote guard's reading. */
function wordsOf(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Whether `needle`'s words run, in order and unbroken, somewhere in `haystack`'s. */
function runsIn(needle: readonly string[], haystack: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (needle.every((word, offset) => haystack[start + offset] === word)) return true;
  }
  return false;
}

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
 * The words a talk's proposal rests on: the quotes the employee offered, with the manager's turns
 * as the only evidence. Each is dropped by the charter's own guard when it quotes the employee
 * rather than the manager (`withoutAgentQuotedEvidence`, six words the employee said and the
 * manager never did), and kept only when the manager's own words run through it unbroken; an
 * employee's phrase the manager said too is the manager's. Trimmed, each kept once, at most
 * `QUOTES_LIMIT`.
 *
 * @param quotes - What the `reorientationComplete` call offered.
 * @param turns - The talk as it stands.
 */
export function talkQuotes(quotes: readonly string[], turns: readonly OneToOneTurn[]): string[] {
  const offered = [
    ...new Set(quotes.map((quote) => quote.replace(/\s+/g, ' ').trim()).filter(Boolean)),
  ].filter((quote) => quote.length <= REPLY_MAX_CHARS);
  const manager = turns.filter((kept) => kept.speaker === 'manager').map((kept) => kept.text);
  const employee = turns.filter((kept) => kept.speaker === 'employee').map((kept) => kept.text);
  const guarded = withoutAgentQuotedEvidence(quoteCarrier(offered), {
    agent: employee,
    manager,
  }).charter.evidence.map((item) => item.text);
  const said = manager.map(wordsOf);
  return guarded
    .filter((quote) => said.some((words) => runsIn(wordsOf(quote), words)))
    .slice(0, QUOTES_LIMIT);
}

/** The `reorientationComplete` call's input: the proposal, its evidence and a closing line. */
export const talkOutcomeSchema = proposalReplySchema.extend({
  /** The manager's own words the proposal rests on, copied exactly from the manager's replies. */
  quotes: z.array(z.string()),
  /** One or two sentences to the manager saying what goes on the card. */
  closingLine: z.string(),
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
