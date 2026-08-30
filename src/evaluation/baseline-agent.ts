import { Agent } from '@mastra/core/agent';
import { tool } from 'ai';
import { z } from 'zod';
import { MODEL_CALL_TIMEOUT_MS, MODEL_CONFIG, MODEL_TEMPERATURE } from '../lib/mastra';
import type { AppliedAction } from '../surfaces/types';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';
import { renderEnvSnapshot } from '../work/execute-skill';

export interface BaselineCandidate {
  id: string;
  sourceSystem: string;
  sourceCategory: string;
  externalId: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
}

/**
 * The task as the ordinary agent receives it: the request, and the same
 * workspace listing day0's executor is shown. No charter, no runbooks, no
 * documentation in context (that is what the lookup tool is for), and no
 * instruction on when to decline: what it does with an unfamiliar request is
 * the thing being measured.
 */
function candidatePrompt(item: BaselineCandidate, snapshot: MockSurfaceSnapshot): string {
  return [
    'Handle this task with the tools available to you.',
    'Reply with what you did, or with why you did not do it.',
    `Source: ${item.sourceSystem} / ${item.sourceCategory}`,
    `External id: ${item.externalId}`,
    `Title: ${item.title}`,
    `Request: ${item.contentSummary}`,
    `References: ${item.contentRefs.join(', ') || '(none)'}`,
    '',
    '--- Current work environment ---',
    renderEnvSnapshot(snapshot),
  ].join('\n');
}

function docMatches(snapshot: MockSurfaceSnapshot, query: string) {
  const tokens = new Set(
    query
      .toLowerCase()
      .split(/\W+/)
      .filter((token) => token.length >= 3),
  );
  return [...snapshot.teamDocs, ...snapshot.howToGuides]
    .map((doc) => {
      const title = doc.title.toLowerCase();
      const body = doc.body.toLowerCase();
      let score = 0;
      for (const token of tokens) {
        if (title.includes(token)) score += 3;
        if (body.includes(token)) score += 1;
      }
      return { ...doc, score };
    })
    .filter((doc) => doc.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((doc) => ({ slug: doc.slug, title: doc.title, body: doc.body }));
}

export async function runBaselineAgent(args: {
  candidate: BaselineCandidate;
  snapshot: MockSurfaceSnapshot;
  invokeAction: (action: MockAction) => Promise<AppliedAction>;
  onToolCall: () => void;
}): Promise<{ draft: string; modelCalls: number }> {
  const apply = async (action: MockAction): Promise<AppliedAction> => {
    args.onToolCall();
    return await args.invokeAction(action);
  };
  const cells = z.array(z.object({ header: z.string(), value: z.string() })).min(1);
  const tools = {
    'docs.lookup': tool({
      description: 'Search the team documentation by query. The documents are not in context.',
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => {
        args.onToolCall();
        return { documents: docMatches(args.snapshot, query) };
      },
    }),
    'spreadsheet.appendRow': tool({
      description: 'Append one row to an existing mock spreadsheet tab.',
      inputSchema: z.object({ sheetSlug: z.string(), tabName: z.string(), cells }),
      execute: async (input) => await apply({ tool: 'spreadsheet.appendRow', args: input }),
    }),
    'slack.postMessage': tool({
      description: 'Post one message to an existing mock Slack channel or DM.',
      inputSchema: z.object({
        channelSlug: z.string(),
        threadKey: z.string().optional(),
        body: z.string(),
      }),
      execute: async (input) => await apply({ tool: 'slack.postMessage', args: input }),
    }),
    'twitter.reply': tool({
      description: 'Draft one reply to an existing mock tweet.',
      inputSchema: z.object({ tweetSlug: z.string(), body: z.string() }),
      execute: async (input) => await apply({ tool: 'twitter.reply', args: input }),
    }),
    'ticket.update': tool({
      description: 'Update one existing mock ticket status and/or add a comment.',
      inputSchema: z.object({
        slug: z.string(),
        status: z.enum(['open', 'in-progress', 'blocked', 'done']).optional(),
        comment: z.string().optional(),
      }),
      execute: async (input) => await apply({ tool: 'ticket.update', args: input }),
    }),
  };
  const ordinary = new Agent({
    id: `baseline-${args.candidate.id}`,
    name: 'ordinary agent',
    instructions: 'You are an ops assistant for this team; here are your tools.',
    model: MODEL_CONFIG,
    tools,
  });
  const result = await ordinary.generate(candidatePrompt(args.candidate, args.snapshot), {
    abortSignal: AbortSignal.timeout(MODEL_CALL_TIMEOUT_MS),
    maxSteps: 10,
    modelSettings: { temperature: MODEL_TEMPERATURE },
    toolChoice: 'auto',
  });
  return {
    draft: result.text.trim(),
    modelCalls: Array.isArray(result.steps) ? result.steps.length : 1,
  };
}
