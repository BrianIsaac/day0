import { openai } from '@ai-sdk/openai';
import { convertToModelMessages, hasToolCall, streamText, tool, type UIMessage } from 'ai';
import { z } from 'zod';
import { env } from '@/env';
import { DAY_ONE_TOPIC_SPECS, DAY_ONE_WELCOME } from '@/agent/day-one-prompts';

export const runtime = 'nodejs';
export const maxDuration = 60;

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

export async function POST(req: Request): Promise<Response> {
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
  try {
    const result = streamText({
      model: openai(env.OPENAI_MODEL),
      system: SYSTEM_PROMPT,
      messages,
      maxOutputTokens: 2000,
      tools: {
        dayOneComplete: tool({
          description: 'Call this when all seven topics have been covered and the 1:1 is finished.',
          inputSchema: z.object({
            closingLine: z.string().describe('A friendly closing sentence the agent says.'),
          }),
        }),
      },
      stopWhen: hasToolCall('dayOneComplete'),
      providerOptions: {
        openai: { promptCacheKey: 'day0-day1-system-v1' },
      },
      maxRetries: 3,
    });
    return result.toUIMessageStreamResponse();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return Response.json(
      { error: 'agent unavailable — please retry', detail: msg },
      { status: 503 },
    );
  }
}
