'use node';

import { v } from 'convex/values';
import { z } from 'zod';
import { action, internalAction, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  synthesiseCharter,
  withoutAgentQuotedEvidence,
  identityFromCharter,
  toolsFromCharter,
  extractRole,
  DAY_ONE_TOPICS,
} from '../src/agent/charter';
import type { DayOneTopic } from '../src/agent/charter';
import { defaultSoul, day1Script, DAY_ONE_TOPIC_SPECS } from '../src/agent/day-one-prompts';
import { mergeGoodHabits, researchAndDistil } from '../src/agent/good-habits';
import { generateWorkItemsFromCharter } from '../src/agent/work-generator';
import type { Charter } from '../src/agent/charter';
import type { Id } from './_generated/dataModel';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { assertOwnsAgentAction } from './ownership';
import type { WorkspaceFile } from './charters';
import { readSurfaceSnapshot } from '../src/surfaces/registry';
import { SURFACE_MODE } from '../src/lib/surface-mode';

/**
 * Day-1 onboarding actions. Surfaces:
 *
 *   - `synthesiseFromAnswers` — chat-friendly entry: given the seven topic
 *     answers, produces Charter v0.0, persists, seeds the 8-file workspace.
 *   - `synthesiseFromTranscript` — chat-mode entry: given a role-labelled
 *     transcript, attributes the seven answers to the manager's own turns,
 *     then hands off to the same pipeline. Ownership-checked.
 *   - `synthesiseFromTranscriptForWebhook` — webhook entry: same logic,
 *     but the caller carries no Clerk identity. Authenticated by the
 *     per-session webhook token; trust model documented at the action.
 *   - `recoverFinalisation` — the deployment finishing a call neither client
 *     will come back for. Internal, and scheduled by the database rather
 *     than called by anybody.
 *   - `postCharterApproval` — runs after the boss clicks Approve. Kicks
 *     off Exa good-habits research; distils into AGENTS.md.
 *
 * All wrapped in Convex Node actions because they call external APIs.
 */

/**
 * Who said a line, as the surface that wrote the transcript labelled it. Every
 * producer labels every line — `ChatRoom` writes USER/ASSISTANT, the voice room
 * and the ElevenLabs post-call webhook write USER/AGENT — so which half of the
 * conversation a sentence came from is a fact about the input. Asking a model to
 * work it out is what let an 8B answer its own questions and sign the manager's
 * name to them.
 */
const SPEAKER_LABELS: Record<string, 'manager' | 'agent'> = {
  USER: 'manager',
  MANAGER: 'manager',
  BOSS: 'manager',
  ASSISTANT: 'agent',
  AGENT: 'agent',
  DAY0: 'agent',
};

const LABELLED_LINE = /^\s*([A-Za-z0-9_]+)\s*:\s*(.*)$/;

interface TranscriptTurn {
  role: 'manager' | 'agent';
  text: string;
}

/** One question the agent asked and everything the manager said in reply to it. */
interface Exchange {
  question: string;
  replies: string[];
}

/**
 * Parse a speaker-labelled transcript without guessing speaker identity.
 *
 * Args:
 *   transcript: One labelled conversation turn per line.
 *
 * Returns:
 *   Normalised manager and agent turns with wrapped lines joined.
 */
export function parseTranscript(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  for (const line of transcript.split('\n')) {
    const match = LABELLED_LINE.exec(line);
    const speaker = match ? SPEAKER_LABELS[match[1].toUpperCase()] : undefined;
    const last = turns[turns.length - 1];
    if (speaker && match) {
      if (last && last.role === speaker) last.text = `${last.text}\n${match[2]}`.trim();
      else turns.push({ role: speaker, text: match[2].trim() });
    } else if (last && line.trim()) {
      // A wrapped or blank-prefixed line continues the turn above it. A line
      // before any label has no speaker to belong to and is dropped rather than
      // guessed at.
      last.text = `${last.text}\n${line.trim()}`.trim();
    }
  }
  return turns.filter((t) => t.text.length > 0);
}

function buildExchanges(turns: TranscriptTurn[]): Exchange[] {
  const exchanges: Exchange[] = [];
  for (const turn of turns) {
    if (turn.role === 'agent') {
      exchanges.push({ question: turn.text, replies: [] });
      continue;
    }
    if (exchanges.length === 0) exchanges.push({ question: '', replies: [] });
    exchanges[exchanges.length - 1].replies.push(turn.text);
  }
  return exchanges;
}

const TOPIC_OR_NONE = [...DAY_ONE_TOPICS, 'none'] as const;

const QUESTION_LABELLING_SYSTEM = [
  'You are labelling the questions an agent asked during a Day-1 manager 1:1.',
  'Each numbered item is one thing the agent said. Say which of the seven topics it was asking about.',
  '',
  'The seven topics, and how each is normally asked:',
  ...DAY_ONE_TOPIC_SPECS.map((s) => `  ${s.topic} — ${s.question.split('\n')[1] ?? s.question}`),
  '',
  'Rules:',
  '  - One label per numbered item, in the same order, using the item numbers given.',
  '  - Use "none" for a welcome, an acknowledgement or a closing line that asks nothing.',
  '  - Label what the agent asked, not what you would have asked.',
].join('\n');

const questionLabellerAgent = makeAgent('day0-question-labeller', QUESTION_LABELLING_SYSTEM);

const questionLabelSchema = z.object({
  labels: z.array(
    z.object({
      question: z.number(),
      topic: z.enum(TOPIC_OR_NONE),
    }),
  ),
});

type QuestionLabels = z.infer<typeof questionLabelSchema>;

/**
 * Which topic each of the agent's questions was asking about. The model sees the
 * agent's questions and nothing else — not one word the manager said — and it
 * answers in labels rather than in prose. Both halves of that are deliberate:
 * text it never receives cannot be reworded, and a reply that can only be one of
 * eight labels cannot become an answer.
 */
async function labelQuestions(exchanges: Exchange[]): Promise<Map<number, DayOneTopic>> {
  const asked = exchanges
    .map((ex, i) => ({ i, question: ex.question.trim() }))
    .filter((q) => q.question.length > 0);
  const labels = new Map<number, DayOneTopic>();
  if (asked.length === 0) return labels;

  const raw = await agentJson<QuestionLabels>({
    agent: questionLabellerAgent,
    user: asked.map((q) => `${q.i + 1}. ${q.question}`).join('\n\n'),
    schema: questionLabelSchema,
  });
  for (const label of raw.labels ?? []) {
    const index = label.question - 1;
    if (label.topic === 'none') continue;
    if (!exchanges[index]) continue;
    labels.set(index, label.topic);
  }
  return labels;
}

/** What the manager said, and what the agent said, told apart before any of it is read. */
interface AttributedTranscript {
  answers: Record<DayOneTopic, string>;
  agentTurns: string[];
}

/**
 * Turn a role-labelled transcript into the seven topic answers.
 *
 * The invariant this exists to hold: an answer is only ever the manager's own
 * turns, copied. The model chooses which topic a question was about; the code
 * copies the replies to that question across. Nothing the agent said can reach
 * an answer, however the labelling comes back — a wrong label misfiles the
 * manager's words, it does not replace them with the agent's.
 *
 * An unlabelled question is treated as a follow-up and its replies stay with the
 * topic in progress, so a partial labelling misfiles a reply rather than losing
 * it. A transcript nobody labelled at all is refused: it cannot be attributed,
 * and guessing at attribution is the bug this replaced.
 */
async function attributeTranscript(transcript: string): Promise<AttributedTranscript> {
  const turns = parseTranscript(transcript);
  if (turns.length === 0) {
    throw new Error(
      'transcript attribution: no speaker-labelled lines. Every line must begin with a ' +
        `speaker label (${Object.keys(SPEAKER_LABELS).join(', ')}), because who said a ` +
        'sentence decides whether it may become an answer.',
    );
  }

  const exchanges = buildExchanges(turns);
  const labels = await labelQuestions(exchanges);

  const collected = new Map<DayOneTopic, string[]>();
  let current: DayOneTopic = DAY_ONE_TOPICS[0];
  exchanges.forEach((exchange, index) => {
    current = labels.get(index) ?? current;
    if (exchange.replies.length === 0) return;
    const bucket = collected.get(current) ?? [];
    bucket.push(...exchange.replies);
    collected.set(current, bucket);
  });

  const answers: Record<string, string> = {};
  for (const topic of DAY_ONE_TOPICS) {
    answers[topic] = (collected.get(topic) ?? []).join('\n\n');
  }
  return {
    answers: answers as Record<DayOneTopic, string>,
    agentTurns: turns.filter((t) => t.role === 'agent').map((t) => t.text),
  };
}

const CHARTER_VERSION = '0.0';

/**
 * Everything the commit needs, computed before it: two model calls and seven
 * rendered files, none of them touching the database. Keeping the model work
 * outside the transaction is what lets the transaction be the only writer.
 *
 * The evidence guard runs here rather than at the call site, so the charter and
 * the workspace files rendered from it are always the reviewed one.
 */
async function draftCharter(args: {
  bossLabel: string;
  answers: Record<DayOneTopic, string>;
  agentTurns: string[];
}): Promise<{ charter: Charter; workspaceFiles: WorkspaceFile[]; rejectedEvidence: string[] }> {
  const drafted = await synthesiseCharter({
    answers: args.answers,
    version: CHARTER_VERSION,
    bossLabel: args.bossLabel,
  });
  // The manager's side is the answers themselves: they are that side of the
  // transcript, copied, which is what the fix above guarantees.
  const reviewed = withoutAgentQuotedEvidence(drafted, {
    agent: args.agentTurns,
    manager: Object.values(args.answers),
  });
  const charter = reviewed.charter;
  return {
    charter,
    rejectedEvidence: reviewed.rejected.map((e) => e.text),
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

/**
 * What the guard found, in the feed. A clause that quoted the agent is dropped
 * from the charter and an open question says so, but neither says it happened
 * *again* — and a model doing this on every run is a different fault from one
 * doing it once, with a different fix.
 */
async function reportRejectedEvidence(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
  rejected: string[],
): Promise<void> {
  if (rejected.length === 0) return;
  await ctx.runMutation(internal.events.log, {
    agentId,
    type: 'charter.evidence-rejected',
    payload: { count: rejected.length, texts: rejected.slice(0, 3) },
  });
}

async function doSynthesise(
  ctx: ActionCtx,
  args: {
    agentId: Id<'agents'>;
    bossLabel: string;
    answers: Record<DayOneTopic, string>;
    agentTurns: string[];
  },
): Promise<{ charterId: string; version: string }> {
  const drafted = await draftCharter({
    bossLabel: args.bossLabel,
    answers: args.answers,
    agentTurns: args.agentTurns,
  });
  const charterId: Id<'charters'> = await ctx.runMutation(internal.charters.commit, {
    agentId: args.agentId,
    version: CHARTER_VERSION,
    body: drafted.charter,
    workspaceFiles: drafted.workspaceFiles,
  });
  await reportRejectedEvidence(ctx, args.agentId, drafted.rejectedEvidence);
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
    const attributed = await attributeTranscript(args.transcript);
    const drafted = await draftCharter({
      bossLabel: args.bossLabel,
      answers: attributed.answers,
      agentTurns: attributed.agentTurns,
    });
    const result = await ctx.runMutation(internal.voice.finaliseSession, {
      sessionId: args.sessionId,
      expectedAgentId: args.agentId,
      claimToken: args.claimToken,
      transcriptText: args.transcript,
      answers: attributed.answers,
      charterVersion: CHARTER_VERSION,
      charterBody: drafted.charter,
      workspaceFiles: drafted.workspaceFiles,
    });
    if (result.outcome === 'finalised') {
      await reportRejectedEvidence(ctx, args.agentId, drafted.rejectedEvidence);
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
    // Answers handed straight in have no transcript behind them, so there are no
    // agent turns for the evidence guard to check against.
    return await doSynthesise(ctx, {
      agentId: args.agentId,
      bossLabel: args.bossLabel,
      answers: args.answers as Record<DayOneTopic, string>,
      agentTurns: [],
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
      const attributed = await attributeTranscript(args.transcript);
      const result = await doSynthesise(ctx, {
        agentId: args.agentId,
        bossLabel: args.bossLabel,
        answers: attributed.answers,
        agentTurns: attributed.agentTurns,
      });
      return { outcome: 'synthesised', ...result };
    }

    const claim = await ctx.runMutation(internal.voice.claimFinalisation, {
      sessionId: args.voiceSessionId,
      expectedAgentId: args.agentId,
      transcript: args.transcript,
      bossLabel: args.bossLabel,
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
      transcript: args.transcript,
      bossLabel: args.bossLabel,
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

/** What one server-driven attempt did. */
export type RecoveryOutcome =
  | { outcome: 'recovered'; charterId: string; version: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'failed'; reason: string };

/**
 * Finish a call that both clients have given up on.
 *
 * The browser's `onDisconnect` post is a one-shot by construction — the page is
 * usually gone before the response arrives — and a delivery that overlapped a
 * live claim was answered 200, which is what stops ElevenLabs wasting a retry
 * on work already in flight but also spends that delivery. So a released
 * session has no client left to come back for it, and the deployment finishes
 * it instead, from the transcript the failed attempt wrote onto the row.
 *
 * Scheduled by `voice.releaseFinalisation` in the transaction that releases the
 * session, and by `voice.sweepStalledFinalisations` for a claim whose holder
 * died before it could release anything. It reaches the same claim-once machine
 * as the two clients, so an overlap with a genuine late delivery is decided the
 * same way every other overlap is, and it never fails a scheduled run for a
 * reason that is already recorded on the row.
 */
export const recoverFinalisation = internalAction({
  args: { sessionId: v.id('voiceSessions') },
  handler: async (ctx, args): Promise<RecoveryOutcome> => {
    const claim = await ctx.runMutation(internal.voice.claimRecoveryFinalisation, {
      sessionId: args.sessionId,
    });
    if (claim.outcome !== 'claimed') return { outcome: 'skipped', reason: claim.reason };

    try {
      const result = await finaliseClaimedSession(ctx, {
        sessionId: claim.sessionId,
        agentId: claim.agentId,
        claimToken: claim.claimToken,
        bossLabel: claim.bossLabel,
        transcript: claim.transcript,
      });
      if (result.outcome === 'synthesised') {
        return { outcome: 'recovered', charterId: result.charterId, version: result.version };
      }
      return { outcome: 'skipped', reason: `another finisher reported ${result.outcome}` };
    } catch (err) {
      // The release this attempt already performed carries the reason and
      // schedules the next try, so rethrowing would only turn a handled failure
      // into a failed scheduled function.
      return { outcome: 'failed', reason: (err as Error).message ?? 'unknown error' };
    }
  },
});

export const postCharterApproval = action({
  args: { agentId: v.id('agents'), charterId: v.id('charters') },
  handler: async (ctx, args): Promise<{ norms: number; workItemsGenerated: number }> => {
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

    // Real mode: the named systems become declared surfaces and orientation
    // files one evidence-backed card per system from the linked docs. Mock
    // mode never reaches this branch, so the hosted demo keeps its five
    // synthetic surfaces and files no absence cards.
    if (SURFACE_MODE === 'real') {
      await ctx.runMutation(internal.surfaces.seedFromCharter, {
        agentId: args.agentId,
        namedSystems: charterBody.namedSystems ?? [],
      });
      await ctx.runAction(internal.orientationActions.run, { agentId: args.agentId });
      return { norms, workItemsGenerated: 0 };
    }

    // Generate role-specific work items grounded in BOTH the charter AND
    // the agent's actual mock environment. The work-generator LLM sees
    // real surface slugs (channels, spreadsheets, docs, tweets, tickets)
    // and emits contentRefs the executor can later mutate against real
    // rows. No hardcoded slugs in the prompt.
    const mockEnv = await readSurfaceSnapshot(ctx, args.agentId, 'mock', []);
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
