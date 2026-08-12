"use node";

import { v } from 'convex/values';
import { z } from 'zod';
import { action, type ActionCtx } from './_generated/server';
import { api, internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { agentJson, makeAgent } from '../src/lib/mastra';
import { authorAndVerifySkill } from '../src/lib/daytona';

/**
 * Autonomous skill authoring action. Demo headline:
 *
 *   1. Boss has approved the proposed skill row.
 *   2. Mastra Agent (GPT-5.5) authors the SKILL.md body from
 *      name/description/rationale + a short Python smoke test that
 *      exercises the skill behaviour.
 *   3. Daytona spins a Python sandbox; the smoke test runs.
 *   4. If the sandbox exits 0 with non-empty stdout, we register the
 *      skill so it becomes available to the agent. If no sandbox ran at
 *      all, the skill stops at `authoring` and stays uncallable: the
 *      register step is what claims the body was checked.
 *
 * The Python smoke is a Voyager-style execution-success signal —
 * sandbox exit 0 means the body is internally consistent. Plan 2 / 3
 * adds environment + critic signals.
 */

const AUTHOR_SYSTEM = [
  'You are an autonomous workplace agent named Day0, authoring a new skill for yourself.',
  'A skill is a SKILL.md document that describes (a) when to invoke it, (b) the inputs it expects, (c) the procedure it follows step-by-step, (d) the format of its output, (e) the structured `actions[]` it MUST emit at the end. SKILL.md is loaded as a behavioural prior at execution time — write it as if instructing a junior practitioner who has never seen the system before.',
  '',
  'Critical: at execution time the skill must emit a typed `actions[]` array of mock-environment mutations. SKILL.md must call this out explicitly with concrete examples. The available tools are:',
  '  - spreadsheet.appendRow — { sheetSlug, tabName, cells: [{ header, value }, …] }',
  '  - slack.postMessage    — { channelSlug, threadKey?, body }',
  '  - twitter.reply        — { tweetSlug, body }',
  '  - ticket.update        — { slug, status?, comment? }',
  'If the skill\'s purpose is "draft a tweet reply", SKILL.md must state that it emits `{ tool: "twitter.reply", args: { tweetSlug, body } }`. If "update the spreadsheet", emit `spreadsheet.appendRow`. If the skill drafts text for human review, ALSO emit a `slack.postMessage` to `dm-manager` so the audit trail is visible. A skill that produces only prose with no actions is broken.',
  '',
  'You also produce a small Python smoke test that demonstrates the skill\'s shape. The smoke test runs in a fresh Python 3.12 sandbox with no third-party packages. It must:',
  '  - Define a `run(inputs: dict) -> dict` function that mimics the skill\'s shape (input keys → output keys, including the `actions` list).',
  '  - Construct a representative input dict.',
  '  - Call run() once.',
  '  - print() a concise success line including a key from the output dict so we can read it back.',
  '  - exit 0.',
  '',
  'Discipline:',
  '  - SKILL.md must be self-contained markdown — no template placeholders.',
  '  - The smoke test is a structural check, not a real integration. Mock external calls.',
].join('\n');

const skillAuthorAgent = makeAgent('day0-skill-author', AUTHOR_SYSTEM);

const authorSchema = z.object({
  body: z.string(),
  smokeTest: z.string(),
});

/**
 * Where a run may start. `approved` is the boss's first go-ahead; `authoring`
 * and `failed` are retries of a skill that never registered, so re-authoring
 * cannot pull the ground out from under an executor already calling it. A retry
 * re-authors rather than re-verifying the stored body, because the smoke test
 * that would verify it is not persisted - and an unverified body has no claim
 * to being the one worth keeping.
 */
const RETRYABLE_STATES = ['approved', 'authoring', 'failed'] as const;

/**
 * Park a skill that did not reach `registered`. Every no-registration exit goes
 * through here so the boss is never left guessing: the row lands in `failed`
 * (listed, with a Retry, in the skills panel), the event feed carries the
 * reason, and the work item that asked for the skill says why it is still
 * waiting.
 */
async function recordAuthoringFailure(
  ctx: ActionCtx,
  skill: Doc<'skills'>,
  args: { rowReason: string; reason: string; eventType: string },
): Promise<{ ok: false; reason: string }> {
  await ctx.runMutation(internal.skills.setFailed, {
    skillId: skill._id,
    reason: args.rowReason,
  });
  await ctx.runMutation(internal.events.log, {
    agentId: skill.agentId,
    type: args.eventType,
    payload: { skillId: skill._id, name: skill.name, reason: args.reason },
  });
  if (skill.proposedFor) {
    await ctx.runMutation(internal.work.setVerdict, {
      workItemId: skill.proposedFor,
      verdict: { decision: 'needs-skill', reason: args.reason },
    });
  }
  return { ok: false, reason: args.reason };
}

export const authorAndRegisterSkill = action({
  args: { skillId: v.id('skills') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const skill = await ctx.runQuery(api.skills.get, { skillId: args.skillId });
    if (!skill) throw new Error('skill not found');
    if (!RETRYABLE_STATES.includes(skill.state as (typeof RETRYABLE_STATES)[number])) {
      throw new Error(
        `authorAndRegisterSkill: skill state is ${skill.state}; expected one of ` +
          RETRYABLE_STATES.join(', '),
      );
    }
    const userPrompt = [
      `Skill name: ${skill.name}`,
      `Description: ${skill.description}`,
      `Rationale (why I need this): ${skill.rationale ?? '(none)'}`,
      `Required scopes: ${(skill.requiredScopes ?? []).join(', ')}`,
      '',
      'Author SKILL.md and smoke.py now.',
    ].join('\n');
    type AuthoredSkill = z.infer<typeof authorSchema>;
    // The model layer rethrows failures prompt injection cannot fix, which is
    // right - but the dashboard fires this action and forgets it, so an
    // uncaught throw would leave the row at `approved`, in none of the skill
    // panels, with nothing to press. Record the failure instead: `failed` is
    // listed, carries the reason, and offers Retry.
    let authored: AuthoredSkill;
    try {
      authored = await agentJson<AuthoredSkill>({
        agent: skillAuthorAgent,
        user: userPrompt,
        schema: authorSchema,
      });
    } catch (err) {
      const reason = `authoring failed before any sandbox ran: ${(err as Error).message}`;
      return await recordAuthoringFailure(ctx, skill, {
        rowReason: reason,
        reason,
        eventType: 'skill.author-failed',
      });
    }

    const body = authored.body.trim();
    const smokeTest = authored.smokeTest.trim();
    if (!body || !smokeTest) {
      const reason = 'the model returned an empty SKILL.md body or smoke test';
      return await recordAuthoringFailure(ctx, skill, {
        rowReason: reason,
        reason,
        eventType: 'skill.author-failed',
      });
    }

    // Daytona is optional, so the loop survives without it - but a skill it
    // never ran is not a verified skill. Whether the key is absent or the
    // sandbox falls over, the skill stops at `authoring` with the body kept,
    // the work item stays `needs-skill`, and the skip goes to the event feed
    // so the demo shows what was and was not checked.
    let sandboxId = '(skipped)';
    let verificationLog = '(daytona unavailable)';
    let skipReason: string | null = null;
    let verificationFailure: string | null = null;
    try {
      const result = await authorAndVerifySkill({
        skillName: skill.name,
        skillBody: body,
        smokeTest,
      });
      if (result.skipped) {
        skipReason = result.skipReason ?? 'daytona unavailable';
        verificationLog = `sandbox verification skipped - ${skipReason}`;
      } else {
        sandboxId = result.sandboxId;
        // Store the body as soon as a sandbox exists: whichever way the check
        // goes, the boss can read what was written and decide about a retry.
        await ctx.runMutation(internal.skills.setAuthoring, {
          skillId: args.skillId,
          sandboxId,
          body,
        });
        verificationLog = `stdout:\n${result.stdout}\n\nstderr:\n${result.stderr}\nok: ${result.ok}`;
        if (!result.ok) {
          verificationFailure = result.failureReason ?? 'sandbox verification failed';
        }
      }
    } catch (err) {
      skipReason = `Daytona threw: ${(err as Error).message}`;
      verificationLog = skipReason;
    }

    // Recorded outside the try: a failure while recording a failure must not be
    // reported as the sandbox throwing.
    if (verificationFailure) {
      return await recordAuthoringFailure(ctx, skill, {
        rowReason: `Daytona verification failed - ${verificationFailure}. ${verificationLog.slice(0, 400)}`,
        reason: `skill authored but verification failed - ${verificationFailure}`,
        eventType: 'skill.verification-failed',
      });
    }

    if (skipReason) {
      await ctx.runMutation(internal.skills.setAuthoring, {
        skillId: args.skillId,
        sandboxId,
        body,
        verificationLog,
      });
      await ctx.runMutation(internal.events.log, {
        agentId: skill.agentId,
        type: 'skill.sandbox-skipped',
        payload: { skillId: args.skillId, name: skill.name, reason: skipReason },
      });
      if (skill.proposedFor) {
        await ctx.runMutation(internal.work.setVerdict, {
          workItemId: skill.proposedFor,
          verdict: {
            decision: 'needs-skill',
            reason: `skill authored but not verified - ${skipReason}`,
          },
        });
      }
      return { ok: false, reason: `sandbox verification unavailable: ${skipReason}` };
    }

    await ctx.runMutation(internal.skills.setVerified, {
      skillId: args.skillId,
      body,
      verificationLog,
    });
    await ctx.runMutation(internal.skills.setRegistered, { skillId: args.skillId });

    if (skill.proposedFor) {
      await ctx.runMutation(internal.work.setVerdict, {
        workItemId: skill.proposedFor,
        verdict: { decision: 'pending-reevaluation', reason: 'skill registered, ready to retry' },
      });
    }

    return { ok: true };
  },
});
