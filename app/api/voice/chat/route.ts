import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  hasToolCall,
  streamText,
  tool,
  type ModelMessage,
  type UIMessage,
} from 'ai';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { languageModel } from '@/lib/openai';
import { streamCallOptions } from '@/lib/stream-settings';
import {
  DAY_ONE_COMPLETE_TOOL,
  DAY_ONE_PROMPT_CACHE_KEY,
  dayOneSystemPrompt,
  dayOneTurnNote,
} from '@/agent/day-one-system-prompt';
import { INIT_PROMPT, dayOneTurnStream, managerReplies } from '@/agent/day-one-turn';
import { topicIndexOf, withTopicIndex } from '@/agent/day-one-progress';
import { uiMessagesOf, type OneToOneTurn } from '@/agent/one-to-one-conversation';
import { chatTurnBodyOf, isOutdatedTurnBody } from '@/agent/chat-turn-body';
import { ANSWER_NOT_KEPT, keptAnswer, type KeepAnswer } from '@/agent/kept-answer';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * One turn of a 1:1 is a short acknowledgement and one question, and this has
 * been the budget since the route was written. `OPENAI_MAX_OUTPUT_TOKENS` raises it for
 * a provider that spends part of the budget on reasoning; unset, the route is
 * unchanged. A larger budget is a ceiling, not a target, but it is a ceiling
 * inside a 60-second function, so whatever a provider does with it has to fit
 * `maxDuration` above.
 */
const DAY_ONE_MAX_OUTPUT_TOKENS = 2000;

/** One turn's body: an employee id, a label and a reply of at most 4,000 characters. */
const CHAT_TURN_BODY_LIMIT_BYTES = 64 * 1024;

/** Said to a room older than this route, which can only carry on once the page is reloaded. */
const OUTDATED_ROOM = 'This page is older than Day0 now. Reload to carry on.';

/**
 * The priming turn the model is asked from: it stands in for the manager before the first
 * question, and is never kept or drawn.
 */
const PRIMING_TURN: UIMessage = {
  id: 'init',
  role: 'user',
  parts: [{ type: 'text', text: INIT_PROMPT }],
};

/**
 * Streams one turn of the Day-1 1:1 on the owner's key, from the conversation the session keeps.
 *
 * The room posts only the turn it wants (the opening, a reply or a turn asked again) for its
 * employee; the employee's held session (`oneToOne.takeTurn`) keeps a reply before the employee is asked and hands back the
 * conversation to answer, so the room's copy never decides the history. The employee speaks under
 * the name on its own row (`agents.get`), read beside the turn. The answer is kept on the
 * session (`oneToOne.recordAnswer`) before the room hears the turn finished (`keptAnswer`), so a
 * room closed at any point reopens on every turn that stood. The caller is established and the
 * request's origin checked before the body is read.
 */
export async function POST(req: Request): Promise<Response> {
  const abortSignal = AbortSignal.any([req.signal, AbortSignal.timeout(maxDuration * 1000)]);
  const crossOrigin = crossOriginRefusal(req);
  if (crossOrigin) return crossOrigin;
  const caller = await establishConvexCaller();
  if (!caller.ok) return caller.refusal;
  const { client } = caller;

  const read = await readJsonBody(req, CHAT_TURN_BODY_LIMIT_BYTES);
  if (!read.ok) return read.refusal;
  const body = chatTurnBodyOf(read.value);
  if (!body) {
    // A room from before this route can never be answered: asking again would post the same body.
    if (isOutdatedTurnBody(read.value)) {
      return Response.json({ error: OUTDATED_ROOM }, { status: 409 });
    }
    return Response.json(
      { error: 'the employee and the turn to take are required' },
      { status: 400 },
    );
  }

  const agentId = body.agentId as Id<'agents'>;
  let taken: {
    sessionId: Id<'voiceSessions'>;
    conversation: number;
    turns: readonly OneToOneTurn[];
    answering: string | null;
  };
  let employee: Doc<'agents'> | null;
  try {
    // The employee speaks as itself: its name is read from its row, never taken from the room,
    // and read first, so a reply is kept only once the employee to answer it is known.
    employee = await client.query(api.agents.get, { agentId });
    if (employee === null) {
      return Response.json({ error: 'this employee no longer exists' }, { status: 404 });
    }
    taken = await client.mutation(api.oneToOne.takeTurn, {
      agentId,
      // The validator's arrays are mutable; the parsed request's are read-only.
      request:
        body.request.kind === 'open'
          ? body.request
          : { ...body.request, replies: [...body.request.replies] },
    });
  } catch (err: unknown) {
    if (err instanceof ConvexError) {
      return Response.json({ error: String(err.data) }, { status: 409 });
    }
    log.warn('one-to-one turn not taken', { reason: errorMessage(err) });
    return Response.json({ error: 'Day0 could not reach your one-to-one' }, { status: 503 });
  }
  const system = dayOneSystemPrompt(employee.name);

  const uiMessages: UIMessage[] = [PRIMING_TURN, ...uiMessagesOf(taken.turns)];
  const replies = managerReplies(uiMessages);
  const topicIndex = topicIndexOf(replies);
  // The conversation, then the one question this turn asks: the model never chooses it.
  const messages: ModelMessage[] = [
    ...(await convertToModelMessages(uiMessages)),
    { role: 'system', content: dayOneTurnNote(replies) },
  ];
  const keep: KeepAnswer = async (answer) => {
    try {
      const kept = await client.mutation(api.oneToOne.recordAnswer, {
        sessionId: taken.sessionId,
        conversation: taken.conversation,
        bossLabel: body.bossLabel,
        answer: { ...answer, answering: taken.answering },
      });
      return kept.kept ? null : kept.refusal;
    } catch (err: unknown) {
      // A refusal the session words for the room is said as it is; anything else is said as the
      // answer not kept, never as the server's own message, which is for the log.
      log.warn('one-to-one answer not kept', { reason: errorMessage(err) });
      return err instanceof ConvexError ? String(err.data) : ANSWER_NOT_KEPT;
    }
  };
  try {
    // Resolved here, not inside the stream: a missing key is a 503 the room
    // can read, where a throw inside the stream is a dropped connection.
    const model = languageModel();
    // One model call. `dayOneTurnStream` makes it a second time when the first
    // ends having said nothing, and holds `dayOneComplete` until the manager has
    // answered topic 7.
    const attempt = () =>
      streamText({
        abortSignal,
        model,
        system,
        messages,
        // The one system message in the list is the route's own note (`dayOneTurnNote`), built
        // from the reply count and never from anything the manager typed.
        allowSystemInMessages: true,
        ...streamCallOptions({
          maxOutputTokens: DAY_ONE_MAX_OUTPUT_TOKENS,
          openai: { promptCacheKey: DAY_ONE_PROMPT_CACHE_KEY },
        }),
        tools: {
          dayOneComplete: tool({
            description: DAY_ONE_COMPLETE_TOOL.description,
            inputSchema: z.object({
              closingLine: z.string().describe(DAY_ONE_COMPLETE_TOOL.closingLine),
            }),
          }),
        },
        stopWhen: hasToolCall('dayOneComplete'),
        maxRetries: 3,
      }).toUIMessageStream();
    // The turn says which of the seven questions it is on, for the room's progress line.
    return createUIMessageStreamResponse({
      stream: keptAnswer(
        withTopicIndex(dayOneTurnStream({ attempt, replies, signal: abortSignal }), topicIndex),
        { messageId: crypto.randomUUID(), topicIndex, keep },
      ),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json({ error: 'employee unavailable', detail: msg }, { status: 503 });
  }
}
