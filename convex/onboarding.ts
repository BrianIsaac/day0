"use node";

import { v } from 'convex/values';
import { z } from 'zod';
import { action, type ActionCtx } from './_generated/server';
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
import type { Doc, Id } from './_generated/dataModel';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { assertOwnsAgentAction } from './ownership';
import type { WorkspaceFile } from './charters';

/**
 * Day-1 onboarding actions. Surfaces:
 *
 *   - `synthesiseFromAnswers` — chat-friendly entry: given the seven topic
 *     answers, produces Charter v0.0, persists, seeds the 8-file workspace.
 *   - `synthesiseFromTranscript` — chat-mode entry: given a transcript,
 *     extracts the seven answers via GPT-5.5, then hands off to the same
 *     pipeline. Ownership-checked.
 *   - `synthesiseFromTranscriptForWebhook` — webhook entry: same logic,
 *     but the caller carries no Clerk identity. Authenticated by the
 *     per-session webhook token; trust model documented at the action.
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

const CHARTER_VERSION = '0.0';

/**
 * Everything the commit needs, computed before it: two model calls and seven
 * rendered files, none of them touching the database. Keeping the model work
 * outside the transaction is what lets the transaction be the only writer.
 */
async function draftCharter(args: {
  bossLabel: string;
  answers: Record<DayOneTopic, string>;
}): Promise<{ charter: Charter; workspaceFiles: WorkspaceFile[] }> {
  const charter = await synthesiseCharter({
    answers: args.answers,
    version: CHARTER_VERSION,
    bossLabel: args.bossLabel,
  });
  return {
    charter,
    workspaceFiles: [
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
    ],
  };
}

/**
 * What a finalisation attempt tells its caller.
 *
 *   synthesised — this attempt did the work.
 *   duplicate   — someone else already did it; here is what they produced.
 *   in-progress — someone else is doing it now.
 *
 * The last two are successes from the caller's point of view: the transcript
 * has been accepted and the charter either exists or is being written.
 */
export type SynthesisOutcome =
  | { outcome: 'synthesised'; charterId: string; version: string }
  | { outcome: 'duplicate'; charterId: string | null; version: string | null }
  | { outcome: 'in-progress' };

async function doSynthesise(
  ctx: ActionCtx,
  args: { agentId: Id<'agents'>; bossLabel: string; answers: Record<DayOneTopic, string> },
): Promise<{ charterId: string; version: string }> {
  const drafted = await draftCharter({ bossLabel: args.bossLabel, answers: args.answers });
  const charterId: Id<'charters'> = await ctx.runMutation(internal.charters.commit, {
    agentId: args.agentId,
    version: CHARTER_VERSION,
    body: drafted.charter,
    workspaceFiles: drafted.workspaceFiles,
  });
  return { charterId, version: CHARTER_VERSION };
}

/**
 * Run the finalisation this caller has won: extract, draft, commit. A failure
 * anywhere in it hands the session back so a later delivery — or the other
 * path — can try again, rather than leaving the boss with a finished call and
 * no charter.
 */
async function finaliseClaimedSession(
  ctx: ActionCtx,
  args: {
    sessionId: Id<'voiceSessions'>;
    agentId: Id<'agents'>;
    claimToken: string;
    bossLabel: string;
    transcript: string;
  },
): Promise<SynthesisOutcome> {
  try {
    const answers = await extractAnswersFromTranscript(args.transcript);
    const drafted = await draftCharter({ bossLabel: args.bossLabel, answers });
    const result = await ctx.runMutation(internal.voice.finaliseSession, {
      sessionId: args.sessionId,
      expectedAgentId: args.agentId,
      claimToken: args.claimToken,
      transcriptText: args.transcript,
      answers,
      charterVersion: CHARTER_VERSION,
      charterBody: drafted.charter,
      workspaceFiles: drafted.workspaceFiles,
    });
    if (result.outcome === 'finalised') {
      return { outcome: 'synthesised', charterId: result.charterId, version: result.version };
    }
    if (result.outcome === 'already-done') {
      return { outcome: 'duplicate', charterId: result.charterId, version: result.version };
    }
    return { outcome: 'in-progress' };
  } catch (err) {
    // Releasing is best effort. Failing to release must not replace the real
    // cause with a second error; the lease expiry recovers the session anyway.
    try {
      await ctx.runMutation(internal.voice.releaseFinalisation, {
        sessionId: args.sessionId,
        claimToken: args.claimToken,
        reason: (err as Error).message ?? 'unknown error',
      });
    } catch {
      /* keep the original failure */
    }
    throw err;
  }
}

/** How a caller that did not win the claim reports what it found. */
function fromClaim(
  claim:
    | { outcome: 'in-progress' }
    | { outcome: 'already-done'; charterId: string | null; version: string | null },
): SynthesisOutcome {
  return claim.outcome === 'already-done'
    ? { outcome: 'duplicate', charterId: claim.charterId, version: claim.version }
    : { outcome: 'in-progress' };
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

/**
 * Browser entry. Two things are proved before a single model call is spent:
 * that the caller owns `agentId`, and — in one transaction, against the row —
 * that `voiceSessionId` is that agent's session and is finalisable. Ownership
 * of the session follows from the pair, and only from the pair: a session id
 * the caller merely knows proves nothing about who may end that call.
 *
 * With no session id this is the chat-mode 1:1, which has no call to end.
 */
export const synthesiseFromTranscript = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    transcript: v.string(),
    voiceSessionId: v.optional(v.id('voiceSessions')),
  },
  handler: async (ctx, args): Promise<SynthesisOutcome> => {
    await assertOwnsAgentAction(ctx, args.agentId);

    if (!args.voiceSessionId) {
      const answers = await extractAnswersFromTranscript(args.transcript);
      const result = await doSynthesise(ctx, {
        agentId: args.agentId,
        bossLabel: args.bossLabel,
        answers,
      });
      return { outcome: 'synthesised', ...result };
    }

    const claim = await ctx.runMutation(internal.voice.claimFinalisation, {
      sessionId: args.voiceSessionId,
      expectedAgentId: args.agentId,
    });
    if (claim.outcome !== 'claimed') return fromClaim(claim);

    return await finaliseClaimedSession(ctx, {
      sessionId: claim.sessionId,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      bossLabel: args.bossLabel,
      transcript: args.transcript,
    });
  },
});

/**
 * Webhook entry — called by the ElevenLabs post-call webhook, which carries
 * no Clerk JWT. Two independent checks stand in for the ownership check:
 *
 *   - The route (`app/api/voice/elevenlabs/webhook/route.ts`) verifies the
 *     `elevenlabs-signature` HMAC over the raw body before calling this, so
 *     only ElevenLabs can put a payload on this path.
 *   - This action is a public Convex function, reachable directly at the
 *     deployment URL by anyone who knows it, so it cannot rely on the route
 *     having run. `sessionToken` is the check that survives that: it is
 *     minted by the ownership-checked `voice.start`, released only to the
 *     boss who owns the agent, and echoed back by ElevenLabs. Neither the
 *     agent id (a routing id, visible in `/agent/<agentId>`) nor the
 *     conversation id (supplied by the caller) proves anything on its own.
 *
 * `voice.claimWebhookFinalisation` holds the matching rules, including the
 * refusal to accept a conversation id that contradicts the session's own, and
 * reserves the session in the same transaction that recognises it.
 *
 * ElevenLabs retries a failed delivery with a byte-identical payload, so this
 * has to be idempotent on the session rather than on anything in the body: a
 * repeat delivery is answered with what the first one produced.
 */
export const synthesiseFromTranscriptForWebhook = action({
  args: {
    agentId: v.id('agents'),
    bossLabel: v.string(),
    transcript: v.string(),
    elevenLabsConversationId: v.string(),
    sessionToken: v.string(),
  },
  handler: async (ctx, args): Promise<SynthesisOutcome> => {
    const claim = await ctx.runMutation(internal.voice.claimWebhookFinalisation, {
      agentId: args.agentId,
      webhookToken: args.sessionToken,
      conversationId: args.elevenLabsConversationId,
    });
    if (claim.outcome !== 'claimed') return fromClaim(claim);

    return await finaliseClaimedSession(ctx, {
      sessionId: claim.sessionId,
      agentId: claim.agentId,
      claimToken: claim.claimToken,
      bossLabel: args.bossLabel,
      transcript: args.transcript,
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
    // Exa is optional. Without it the loop continues with an unchanged
    // AGENTS.md and the skip lands in the event feed, so the missing
    // capability is visible rather than silent.
    const research = await researchAndDistil(role);
    const norms = research.norms;
    if (research.skipped) {
      await ctx.runMutation(internal.events.log, {
        agentId: args.agentId,
        type: 'good-habits.skipped',
        payload: { role, reason: research.skipReason ?? 'research unavailable' },
      });
    } else {
      const existing = await ctx.runQuery(api.workspace.readFile, {
        agentId: args.agentId,
        fileName: 'AGENTS.md',
      });
      const merged = mergeGoodHabits(existing ?? '', research.fragment);
      await ctx.runMutation(internal.workspace.writeFileInternal, {
        agentId: args.agentId,
        fileName: 'AGENTS.md',
        content: merged,
      });
      await ctx.runMutation(internal.events.log, {
        agentId: args.agentId,
        type: 'good-habits.distilled',
        payload: { norms, role },
      });
    }

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
  ctx: ActionCtx,
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
