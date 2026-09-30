import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  hasToolCall,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { ConvexError } from 'convex/values';
import { z } from 'zod';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { establishConvexCaller } from '@/lib/convex-caller';
import { crossOriginRefusal, readJsonBody } from '@/lib/json-request';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { languageModel } from '@/lib/openai';
import { streamCallOptions } from '@/lib/stream-settings';
import { DAY_ONE_TOPIC_SPECS } from '@/agent/day-one-prompts';
import { INIT_PROMPT, dayOneTurnStream, managerReplies } from '@/agent/day-one-turn';
import { topicIndexOf, withTopicIndex } from '@/agent/day-one-progress';
import { uiMessagesOf, type OneToOneTurn } from '@/agent/one-to-one-conversation';
import { chatTurnBodyOf } from '@/agent/chat-turn-body';
import { ANSWER_NOT_KEPT, keptAnswer, type KeepAnswer } from '@/agent/kept-answer';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * One turn of a 1:1 is a question and a short follow-up, and this has been the
 * budget since the route was written. `OPENAI_MAX_OUTPUT_TOKENS` raises it for
 * a provider that spends part of the budget on reasoning; unset, the route is
 * unchanged. A larger budget is a ceiling, not a target, but it is a ceiling
 * inside a 60-second function, so whatever a provider does with it has to fit
 * `maxDuration` above.
 */
const DAY_ONE_MAX_OUTPUT_TOKENS = 2000;

/** One turn's body: an employee id, a label and a reply of at most 4,000 characters. */
const CHAT_TURN_BODY_LIMIT_BYTES = 64 * 1024;

/**
 * The priming turn the model is asked from: it stands in for the manager before the first
 * question, and is never kept or drawn.
 */
const PRIMING_TURN: UIMessage = {
  id: 'init',
  role: 'user',
  parts: [{ type: 'text', text: INIT_PROMPT }],
};

const SYSTEM_PROMPT = [
  'You are Day0, a freshly-deployed autonomous workplace agent on its first day.',
  'Run a Day-1 manager 1:1 with the boss who just hired you.',
  'Walk through SEVEN topics, conversationally, one at a time:',
  ...DAY_ONE_TOPIC_SPECS.map(
    (s, i) => `  ${i + 1}. ${s.topic} — ${s.question.split('\n')[1] ?? s.question}`,
  ),
  '',
  'Rules:',
  '  - Lead with a short welcome on turn one, then ask topic 1.',
  "  - Wait for the boss's reply before moving on.",
  '  - One question per turn. Brief follow-ups are fine.',
  "  - Do not summarise the boss's answers back in full.",
  '  - Once topic 7 has a real answer, call the dayOneComplete tool with a friendly closing line and stop.',
].join('\n');

/**
 * Streams one turn of the Day-1 1:1 on the owner's key, from the conversation the session keeps.
 *
 * The room posts only the turn it wants (the opening, a reply or a turn asked again) for its
 * employee; the employee's held session (`oneToOne.takeTurn`) keeps a reply before the employee is asked and hands back the
 * conversation to answer, so the room's copy never decides the history. The answer is kept on the
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
    return Response.json(
      { error: 'the employee and the turn to take are required' },
      { status: 400 },
    );
  }

  let taken: {
    sessionId: Id<'voiceSessions'>;
    conversation: number;
    turns: readonly OneToOneTurn[];
    answering: string | null;
  };
  try {
    taken = await client.mutation(api.oneToOne.takeTurn, {
      agentId: body.agentId as Id<'agents'>,
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

  const uiMessages: UIMessage[] = [PRIMING_TURN, ...uiMessagesOf(taken.turns)];
  const messages = await convertToModelMessages(uiMessages);
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
        system: SYSTEM_PROMPT,
        messages,
        ...streamCallOptions({
          maxOutputTokens: DAY_ONE_MAX_OUTPUT_TOKENS,
          openai: { promptCacheKey: 'day0-day1-system-v1' },
        }),
        tools: {
          dayOneComplete: tool({
            description:
              'Call this when all seven topics have been covered and the 1:1 is finished.',
            inputSchema: z.object({
              closingLine: z.string().describe('A friendly closing sentence the agent says.'),
            }),
          }),
        },
        stopWhen: hasToolCall('dayOneComplete'),
        maxRetries: 3,
      }).toUIMessageStream();
    const replies = managerReplies(uiMessages);
    const topicIndex = topicIndexOf(replies);
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
