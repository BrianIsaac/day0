import { Agent } from '@mastra/core/agent';
import { tool } from 'ai';
import { z } from 'zod';
import { MODEL_CONFIG } from '../lib/mastra';
import type { AppliedAction } from '../surfaces/types';
import type { MockAction, MockSurfaceSnapshot } from '../work/types';

export interface BaselineCandidate {
  id: string;
  sourceSystem: string;
  sourceCategory: string;
  externalId: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
}

function candidatePrompt(item: BaselineCandidate): string {
  return [
    'Handle this unfamiliar task using the available tools.',
    'If it is out of scope, unsafe, unsupported, or lacks real data, do not call a write tool; explain the refusal or escalation in your final answer.',
    `Source: ${item.sourceSystem} / ${item.sourceCategory}`,
    `External id: ${item.externalId}`,
    `Title: ${item.title}`,
    `Request: ${item.contentSummary}`,
    `References: ${item.contentRefs.join(', ') || '(none)'}`,
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
  const result = await ordinary.generate(candidatePrompt(args.candidate), {
    maxSteps: 10,
    modelSettings: { temperature: 0.4 },
    toolChoice: 'auto',
  });
  return {
    draft: result.text.trim(),
    modelCalls: Array.isArray(result.steps) ? result.steps.length : 1,
  };
}
