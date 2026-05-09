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
import { agentJson, makeAgent } from '../src/lib/mastra';

/**
 * Day-1 onboarding actions. Two surfaces:
 *
 *   - `synthesiseFromAnswers` — given the seven topic answers (collected
 *     via voice transcript or chat), produces a Charter v0.0, persists
 *     it, and seeds the 8-file workspace.
 *
 *   - `synthesiseFromTranscript` — given a free-form transcript (e.g.
 *     from ElevenLabs post-call webhook), GPT-5.5 first extracts the
 *     seven topic answers, then we hand off to the same flow.
 *
 *   - `postCharterApproval` — runs after the boss clicks Approve on the
 *     charter. Kicks off Exa good-habits research, distils into AGENTS.md.
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
  handler: async (ctx, args): Promise<{ charterId: string; version: string }> =>
    doSynthesise(ctx, {
      agentId: args.agentId,
      bossLabel: args.bossLabel,
      answers: args.answers as Record<DayOneTopic, string>,
    }),
});

export const synthesiseFromTranscript = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    transcript: v.string(),
    voiceSessionId: v.optional(v.id('voiceSessions')),
  },
  handler: async (ctx, args): Promise<{ charterId: string; version: string }> => {
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

export const postCharterApproval = action({
  args: { agentId: v.id('agents'), charterId: v.id('charters') },
  handler: async (ctx, args): Promise<{ norms: number }> => {
    const charter = await ctx.runQuery(api.charters.latest, { agentId: args.agentId });
    if (!charter) throw new Error('postCharterApproval: no charter');
    const role = extractRole(charter.body as Parameters<typeof extractRole>[0]);
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
    return { norms };
  },
});
