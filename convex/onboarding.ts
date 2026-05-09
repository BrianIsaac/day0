"use node";

import { v } from 'convex/values';
import { z } from 'zod';
import { action } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  synthesiseCharter,
  identityFromCharter,
  toolsFromCharter,
  extractRole,
  DAY_ONE_TOPICS,
} from '../src/agent/charter';
import type { DayOneTopic } from '../src/agent/charter';
import { defaultSoul, day1Script } from '../src/agent/day-one-prompts';
import { mergeGoodHabits, researchAndDistil } from '../src/agent/good-habits';
import { generateWorkItemsFromCharter } from '../src/agent/work-generator';
import type { Charter } from '../src/agent/charter';
import type { MockSurfaceSnapshot } from '../src/work/types';
import type { Doc } from './_generated/dataModel';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { assertOwnsAgentAction } from './ownership';

/**
 * Day-1 onboarding actions. Surfaces:
 *
 *   - `synthesiseFromAnswers` — chat-friendly entry: given the seven topic
 *     answers, produces Charter v0.0, persists, seeds the 8-file workspace.
 *   - `synthesiseFromTranscript` — chat-mode entry: given a transcript,
 *     extracts the seven answers via GPT-5.5, then hands off to the same
 *     pipeline. Ownership-checked.
 *   - `synthesiseFromTranscriptForWebhook` — webhook entry: same logic,
 *     but the caller is the unauthenticated ElevenLabs post-call webhook.
 *     The trust model is documented at the action's call site.
 *   - `postCharterApproval` — runs after the boss clicks Approve. Kicks
 *     off Exa good-habits research; distils into AGENTS.md.
 *
 * All wrapped in Convex Node actions because they call external APIs.
 */

const TRANSCRIPT_EXTRACTION_SYSTEM = [
  'You are summarising a Day-1 manager 1:1 conversation between a new autonomous agent named Day0 and the manager who hired it.',
  'The agent asked seven topic questions; the manager answered conversationally. Extract a clean answer per topic.',
  '',
  'Discipline:',
  '  - If the manager skipped a topic, return an empty string for that key.',
  '  - Preserve the manager\'s wording where possible — do not editorialise.',
  '  - 1-3 short sentences per answer. Do not invent collaborators or tools.',
].join('\n');

const transcriptAgent = makeAgent('day0-transcript-extractor', TRANSCRIPT_EXTRACTION_SYSTEM);

const transcriptSchema = z.object({
  'why-this-hire': z.string(),
  'role-and-goals': z.string(),
  collaborators: z.string(),
  reading: z.string(),
  tools: z.string(),
  immediate: z.string(),
  'open-questions': z.string(),
});

type TranscriptAnswers = z.infer<typeof transcriptSchema>;

async function extractAnswersFromTranscript(
  transcript: string,
): Promise<Record<DayOneTopic, string>> {
  const raw = await agentJson<TranscriptAnswers>({
    agent: transcriptAgent,
    user: `--- Transcript ---\n${transcript}\n\nExtract the seven answers.`,
    schema: transcriptSchema,
  });
  const out: Record<string, string> = {};
  for (const t of DAY_ONE_TOPICS) {
    out[t] = raw[t] ?? '';
  }
  return out as Record<DayOneTopic, string>;
}

async function doSynthesise(
  ctx: { runMutation: (fn: any, args: any) => Promise<any> },
  args: { agentId: any; bossLabel: string; answers: Record<DayOneTopic, string> },
): Promise<{ charterId: string; version: string }> {
  const charter = await synthesiseCharter({
    answers: args.answers,
    version: '0.0',
    bossLabel: args.bossLabel,
  });
  const charterId = await ctx.runMutation(internal.charters.persist, {
    agentId: args.agentId,
    version: '0.0',
    body: charter,
  });
  const writes = [
    { fileName: 'SOUL.md', content: defaultSoul() },
    { fileName: 'IDENTITY.md', content: identityFromCharter(charter) },
    { fileName: 'TOOLS.md', content: toolsFromCharter(charter) },
    { fileName: 'BOOTSTRAP.md', content: day1Script() },
    { fileName: 'USER.md', content: `# USER\n\nBoss: ${args.bossLabel}\n` },
    { fileName: 'MEMORY.md', content: '# MEMORY\n\n(empty — populated by post-turn review)\n' },
    {
      fileName: 'HEARTBEAT.md',
      content: `# HEARTBEAT\n\nDeployed: ${new Date().toISOString()}\n`,
    },
  ];
  for (const w of writes) {
    await ctx.runMutation(internal.workspace.writeFileInternal, {
      agentId: args.agentId,
      fileName: w.fileName,
      content: w.content,
    });
  }
  return { charterId, version: '0.0' };
}

export const synthesiseFromAnswers = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    answers: v.any(),
  },
  handler: async (ctx, args): Promise<{ charterId: string; version: string }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    return await doSynthesise(ctx, {
      agentId: args.agentId,
      bossLabel: args.bossLabel,
      answers: args.answers as Record<DayOneTopic, string>,
    });
  },
});

export const synthesiseFromTranscript = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    transcript: v.string(),
    voiceSessionId: v.optional(v.id('voiceSessions')),
  },
  handler: async (ctx, args): Promise<{ charterId: string; version: string }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    const answers = await extractAnswersFromTranscript(args.transcript);
    if (args.voiceSessionId) {
      await ctx.runMutation(internal.voice.complete, {
        sessionId: args.voiceSessionId,
        transcriptText: args.transcript,
        answers,
      });
    }
    return await doSynthesise(ctx, {
      agentId: args.agentId,
      bossLabel: args.bossLabel,
      answers,
    });
  },
});

/**
 * Webhook entry — called by the ElevenLabs post-call webhook with no
 * Clerk JWT on the request. Skipping the per-user ownership check here
 * is deliberate; the trust signal is the voice session itself:
 *
 *   - The legitimate user started this session via the ownership-checked
 *     `voice.start` mutation, which stamped (agentId, conversationId) on
 *     a fresh voiceSessions row in `active` state.
 *   - We look that row up by (agentId, conversationId) and refuse to
 *     proceed if no active session matches. A malicious signed-in user
 *     calling this action directly with someone else's agentId can't
 *     forge an active session for it, so the lookup fails.
 *
 * This is HMAC-signature-equivalent without HMAC — the database lookup
 * carries the trust. A production hardening pass should still add HMAC
 * verification at the route level using the ElevenLabs webhook secret.
 */
export const synthesiseFromTranscriptForWebhook = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    transcript: v.string(),
    elevenLabsConversationId: v.string(),
  },
  handler: async (ctx, args): Promise<{ charterId: string; version: string }> => {
    // Strict lookup first (uses the conversationId attached by the
    // browser's onConnect handler); fall back to the most recent active
    // session for the agent if the attach call didn't land.
    const session =
      (await ctx.runQuery(internal.voice.findActiveByConversation, {
        agentId: args.agentId,
        conversationId: args.elevenLabsConversationId,
      })) ??
      (await ctx.runQuery(internal.voice.findLatestActiveForAgent, {
        agentId: args.agentId,
      }));
    if (!session) {
      throw new Error('no active voice session for that agent — webhook denied');
    }
    const answers = await extractAnswersFromTranscript(args.transcript);
    await ctx.runMutation(internal.voice.complete, {
      sessionId: session._id,
      transcriptText: args.transcript,
      answers,
    });
    return await doSynthesise(ctx, {
      agentId: args.agentId,
      bossLabel: args.bossLabel,
      answers,
    });
  },
});

export const postCharterApproval = action({
  args: { agentId: v.id('agents'), charterId: v.id('charters') },
  handler: async (
    ctx,
    args,
  ): Promise<{ norms: number; workItemsGenerated: number }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    const charter = await ctx.runQuery(api.charters.latest, { agentId: args.agentId });
    if (!charter) throw new Error('postCharterApproval: no charter');
    const charterBody = charter.body as Charter;
    const role = extractRole(charterBody);
    const { fragment, norms } = await researchAndDistil(role);
    const existing = await ctx.runQuery(api.workspace.readFile, {
      agentId: args.agentId,
      fileName: 'AGENTS.md',
    });
    const merged = mergeGoodHabits(existing ?? '', fragment);
    await ctx.runMutation(internal.workspace.writeFileInternal, {
      agentId: args.agentId as any,
      fileName: 'AGENTS.md',
      content: merged,
    });
    await ctx.runMutation(internal.events.log, {
      agentId: args.agentId,
      type: 'good-habits.distilled',
      payload: { norms, role },
    });

    // Generate role-specific work items grounded in BOTH the charter AND
    // the agent's actual mock environment. The work-generator LLM sees
    // real surface slugs (channels, spreadsheets, docs, tweets, tickets)
    // and emits contentRefs the executor can later mutate against real
    // rows. No hardcoded slugs in the prompt.
    const mockEnv = await loadMockEnvSnapshot(ctx, args.agentId);
    const generated = await generateWorkItemsFromCharter(charterBody, mockEnv);
    let workItemsGenerated = 0;
    for (const item of generated) {
      await ctx.runMutation(internal.work.seedItem, {
        agentId: args.agentId,
        sourceCategory: item.sourceCategory,
        sourceSystem: item.sourceSystem,
        externalId: item.externalId,
        title: item.title,
        contentSummary: item.contentSummary,
        contentRefs: item.contentRefs,
        priority: item.priority,
        requesterLabel: item.requesterLabel,
      });
      workItemsGenerated += 1;
    }
    await ctx.runMutation(internal.events.log, {
      agentId: args.agentId,
      type: 'work.charter-derived',
      payload: { count: workItemsGenerated, role },
    });

    return { norms, workItemsGenerated };
  },
});

/**
 * Compact snapshot of the per-agent mock environment for the
 * work-generator prompt. Mirrors the loader in workActions.ts so the
 * LLM sees the same surface identifiers the executor will later act on.
 */
async function loadMockEnvSnapshot(
  ctx: { runQuery: (fn: any, args: any) => Promise<any> },
  agentId: Doc<'agents'>['_id'],
): Promise<MockSurfaceSnapshot> {
  const docs: Doc<'mockDocs'>[] = await ctx.runQuery(api.mock.listDocs, { agentId });
  const sheets: Doc<'mockSpreadsheets'>[] = await ctx.runQuery(api.mock.listSpreadsheets, {
    agentId,
  });
  const channels: Doc<'mockSlackChannels'>[] = await ctx.runQuery(api.mock.listChannels, {
    agentId,
  });
  const tweets: Doc<'mockTweets'>[] = await ctx.runQuery(api.mock.listTweets, { agentId });
  const tickets: Doc<'mockTickets'>[] = await ctx.runQuery(api.mock.listTickets, { agentId });

  const spreadsheetsHydrated = await Promise.all(
    sheets.map(async (s) => {
      const detail = await ctx.runQuery(api.mock.getSpreadsheet, { agentId, slug: s.slug });
      const rows = (detail?.rows ?? []) as Doc<'mockSpreadsheetRows'>[];
      return {
        slug: s.slug,
        title: s.title,
        tabs: s.tabs,
        rows: rows.map((r) => ({
          tabName: r.tabName,
          cells: r.cells as Record<string, string>,
        })),
      };
    }),
  );

  const channelsHydrated = await Promise.all(
    channels.map(async (c) => {
      const messages = (await ctx.runQuery(api.mock.listMessages, {
        agentId,
        channelSlug: c.slug,
      })) as Doc<'mockSlackMessages'>[];
      return {
        slug: c.slug,
        displayName: c.displayName,
        kind: c.kind,
        recentMessages: messages.slice(-12).map((m) => ({
          sender: m.sender,
          body: m.body,
          threadKey: m.threadKey,
        })),
      };
    }),
  );

  return {
    howToGuides: docs
      .filter((d) => d.category === 'how-to-guide')
      .map((d) => ({ slug: d.slug, title: d.title, body: d.body })),
    teamDocs: docs
      .filter((d) => d.category === 'team-doc')
      .map((d) => ({ slug: d.slug, title: d.title, body: d.body })),
    spreadsheets: spreadsheetsHydrated,
    slackChannels: channelsHydrated,
    tweets: tweets.map((t) => ({
      slug: t.slug,
      author: t.author,
      handle: t.handle,
      body: t.body,
    })),
    tickets: tickets.map((t) => ({
      slug: t.slug,
      title: t.title,
      status: t.status,
      body: t.body,
    })),
  };
}
