import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  generateText,
  hasToolCall,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import type { FunctionReturnType } from 'convex/server';
import { ConvexError } from 'convex/values';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { languageModel } from '@/lib/openai';
import { streamCallOptions } from '@/lib/stream-settings';
import { repliesIn, uiMessagesOf } from '@/agent/one-to-one-conversation';
import { reorientationTalkBodyOf } from '@/agent/chat-turn-body';
import {
  REORIENTATION_COMPLETE,
  TALK_ANSWER_NOT_KEPT,
  keptTalkAnswer,
  talkOutcomeOfCalls,
  talkOutcomeSchema,
  type KeepTalkAnswer,
  type TalkOutcome,
} from '@/agent/reorientation-talk';
import {
  REORIENTATION_COMPLETE_TOOL,
  REORIENTATION_TALK_PROMPT_CACHE_KEY,
  TALK_FINISH_NOTE,
  TALK_OPENING,
} from '@/agent/reorientation-talk-prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

/** One turn of a talk: a short acknowledgement and one question, or the outcome's call. */
const TALK_MAX_OUTPUT_TOKENS = 2000;

/** One turn's body: a card id and the replies since the last question, at most 4,000 characters each. */
const TALK_TURN_BODY_LIMIT_BYTES = 64 * 1024;

/** The priming turn the talk is asked from: it stands in for the manager and is never kept or drawn. */
const PRIMING_TURN: UIMessage = {
  id: 'talk-opening',
  role: 'user',
  parts: [{ type: 'text', text: TALK_OPENING }],
};

/** The tool a talk ends with, its input the outcome (`talkOutcomeSchema`). */
const reorientationComplete = tool({
  description: REORIENTATION_COMPLETE_TOOL.description,
  inputSchema: talkOutcomeSchema,
});

/**
 * One turn of a reorientation card's Discuss talk on the owner's key (16-D; the wave file's 5.3),
 * from the turns the card's talk keeps.
 *
 * The room posts only the turn it wants (the opening, a reply, a turn asked again, or Put this on
 * the card) for its card; the card's talk (`reorientationTalk.takeTurn`) keeps a reply before the
 * employee is asked and hands back the turns to answer and the system prompt built from the card.
 * A turn streams, and its answer is kept on the talk before the room hears it finished
 * (`keptTalkAnswer`, `reorientationTalk.recordAnswer`); once the manager has answered, the
 * `reorientationComplete` tool is offered, and a turn that calls it ends the talk in a proposal on
 * the card. Put this on the card asks for that call outright and answers with JSON
 * (`reorientationTalk.finish`). Nothing a talk does applies anything. The caller is established and
 * the request's origin checked before the body is read.
 */
export async function POST(req: Request): Promise<Response> {
  const abortSignal = AbortSignal.any([req.signal, AbortSignal.timeout(maxDuration * 1000)]);
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;
  const caller = await establishConvexCaller();
  if (!caller.ok) return caller.refusal;
  const { client } = caller;

  const read = await readJsonBody(req, TALK_TURN_BODY_LIMIT_BYTES);
  if (!read.ok) return read.refusal;
  const body = reorientationTalkBodyOf(read.value);
  if (!body) {
    return Response.json({ error: 'the card and the turn to take are required' }, { status: 400 });
  }

  let taken: FunctionReturnType<typeof api.reorientationTalk.takeTurn>;
  try {
    taken = await client.mutation(api.reorientationTalk.takeTurn, {
      reorientationId: body.reorientationId as Id<'reorientations'>,
      // The validator's arrays are mutable; the parsed request's are read-only.
      request:
        body.request.kind === 'open'
          ? body.request
          : { ...body.request, replies: [...body.request.replies] },
    });
  } catch (err: unknown) {
    // A refusal the guard words for the room is said as it is; anything else is for the log.
    if (err instanceof ConvexError) {
      return Response.json({ error: String(err.data) }, { status: 409 });
    }
    log.warn('reorientation talk turn not taken', { reason: errorMessage(err) });
    return Response.json({ error: 'Day0 could not reach the talk' }, { status: 503 });
  }
  if (!taken.taken) return Response.json({ error: taken.refusal }, { status: 409 });

  const messages: ModelMessage[] = await convertToModelMessages([
    PRIMING_TURN,
    ...uiMessagesOf(taken.turns),
  ]);
  const settings = {
    abortSignal,
    system: taken.system,
    ...streamCallOptions({
      maxOutputTokens: TALK_MAX_OUTPUT_TOKENS,
      openai: { promptCacheKey: REORIENTATION_TALK_PROMPT_CACHE_KEY },
    }),
    maxRetries: 3,
  };
  let model: ReturnType<typeof languageModel>;
  try {
    // Resolved here, not inside the stream: a missing key is a 503 the room can read.
    model = languageModel();
  } catch (err: unknown) {
    return Response.json(
      { error: 'employee unavailable', detail: errorMessage(err) },
      { status: 503 },
    );
  }

  if (body.request.kind === 'finish') {
    let outcome: TalkOutcome | undefined;
    try {
      const answered = await generateText({
        ...settings,
        model,
        // The one system message in the list is the route's own note, never the manager's words.
        messages: [...messages, { role: 'system', content: TALK_FINISH_NOTE }],
        allowSystemInMessages: true,
        tools: { [REORIENTATION_COMPLETE]: reorientationComplete },
        toolChoice: 'required',
      });
      outcome = talkOutcomeOfCalls(answered.toolCalls);
    } catch (err: unknown) {
      log.warn('reorientation talk: the outcome was not asked', { reason: errorMessage(err) });
      return Response.json(
        { error: `${taken.employeeName} could not be reached` },
        { status: 503 },
      );
    }
    if (outcome === undefined) {
      return Response.json(
        { error: `${taken.employeeName} put nothing on the card. Try again.` },
        { status: 503 },
      );
    }
    const last = taken.turns.at(-1);
    const ended = await client.mutation(api.reorientationTalk.finish, {
      talkId: taken.talkId,
      conversation: taken.conversation,
      candidatesKey: taken.candidatesKey,
      after: last?.id ?? '',
      outcome: { reply: outcome.reply, quotes: [...outcome.quotes] },
    });
    return ended.ended
      ? Response.json({ ended: true })
      : Response.json({ error: ended.refusal }, { status: 409 });
  }

  const keep: KeepTalkAnswer = async (answer) => {
    try {
      const kept = await client.mutation(api.reorientationTalk.recordAnswer, {
        talkId: taken.talkId,
        conversation: taken.conversation,
        candidatesKey: taken.candidatesKey,
        answer: { answering: taken.answering, id: answer.id, text: answer.text },
        ...(answer.outcome === undefined
          ? {}
          : { outcome: { reply: answer.outcome.reply, quotes: [...answer.outcome.quotes] } }),
      });
      return kept.kept ? null : kept.refusal;
    } catch (err: unknown) {
      log.warn('reorientation talk answer not kept', { reason: errorMessage(err) });
      return TALK_ANSWER_NOT_KEPT;
    }
  };
  // The tool is offered once the manager has said something: an opening has nothing to agree on.
  const offered = repliesIn(taken.turns) > 0;
  const stream = streamText({
    ...settings,
    model,
    messages,
    ...(offered
      ? {
          tools: { [REORIENTATION_COMPLETE]: reorientationComplete },
          stopWhen: hasToolCall(REORIENTATION_COMPLETE),
        }
      : {}),
  }).toUIMessageStream();
  return createUIMessageStreamResponse({
    stream: keptTalkAnswer(stream, { messageId: crypto.randomUUID(), keep }),
  });
}
