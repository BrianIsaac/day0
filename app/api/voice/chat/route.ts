import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  hasToolCall,
  streamText,
  tool,
  type UIMessage,
} from 'ai';
import { z } from 'zod';
import { establishCaller } from '@/lib/dev-auth-server';
import { languageModel } from '@/lib/openai';
import { streamCallOptions } from '@/lib/stream-settings';
import { DAY_ONE_TOPIC_SPECS, DAY_ONE_WELCOME } from '@/agent/day-one-prompts';
import { dayOneTurnStream } from '@/agent/day-one-turn';

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

interface ChatBody {
  messages: UIMessage[];
  bossLabel?: string;
}

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
  '  - Wait for the boss\'s reply before moving on.',
  '  - One question per turn. Brief follow-ups are fine.',
  '  - Do not summarise the boss\'s answers back in full.',
  '  - Once topic 7 has a real answer, call the dayOneComplete tool with a friendly closing line and stop.',
].join('\n');

/**
 * Streams the Day-1 1:1 on the owner's OpenAI key, so the caller is
 * established here and not left to the proxy matcher alone. The check
 * runs before the body is read: an anonymous caller never gets as far
 * as choosing a message history.
 */
export async function POST(req: Request): Promise<Response> {
  const abortSignal = AbortSignal.any([req.signal, AbortSignal.timeout(maxDuration * 1000)]);
  const caller = await establishCaller();
  if (!caller.ok) return caller.refusal;

  const body = (await req.json()) as ChatBody;
  if (!Array.isArray(body.messages)) {
    return Response.json({ error: 'messages array required' }, { status: 400 });
  }

  const isFirstTurn = body.messages.length === 0;
  const bossLabel = body.bossLabel ?? 'there';
  const uiMessages: UIMessage[] = isFirstTurn
    ? [
        {
          id: 'init',
          role: 'user',
          parts: [
            {
              type: 'text',
              text: `Begin the Day-1 1:1. Open with a short welcome (template: "${DAY_ONE_WELCOME(
                bossLabel,
              ).replace(/"/g, "'")}") then ask topic 1.`,
            },
          ],
        } as UIMessage,
      ]
    : body.messages;

  const messages = await convertToModelMessages(uiMessages);
  // One model call. `dayOneTurnStream` makes it a second time when the first
  // ends having said nothing.
  const attempt = () =>
    streamText({
      abortSignal,
      model: languageModel(),
      system: SYSTEM_PROMPT,
      messages,
      ...streamCallOptions({
        maxOutputTokens: DAY_ONE_MAX_OUTPUT_TOKENS,
        openai: { promptCacheKey: 'day0-day1-system-v1' },
      }),
      tools: {
        dayOneComplete: tool({
          description: 'Call this when all seven topics have been covered and the 1:1 is finished.',
          inputSchema: z.object({
            closingLine: z.string().describe('A friendly closing sentence the agent says.'),
          }),
        }),
      },
      stopWhen: hasToolCall('dayOneComplete'),
      maxRetries: 3,
    }).toUIMessageStream();
  try {
    return createUIMessageStreamResponse({
      stream: dayOneTurnStream({
        attempt,
        signal: abortSignal,
      }),
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: 'agent unavailable — please retry', detail: msg },
      { status: 503 },
    );
  }
}
