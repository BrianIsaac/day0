"use node";

import { v } from 'convex/values';
import { action } from './_generated/server';
import { api, internal } from './_generated/api';
import {
  evaluateCandidate,
  inferRequiredPermissions,
  type EvaluateLookups,
} from '../src/work/evaluate';
import { draftExecutionPlan } from '../src/work/plan';
import { runSkill } from '../src/work/execute-skill';
import type { Charter } from '../src/agent/charter';
import type {
  MockAction,
  MockSurfaceSnapshot,
  WorkCandidate,
  WorkSourceCategory,
} from '../src/work/types';
import type { Doc, Id } from './_generated/dataModel';
import { asAgentId } from '../src/lib/ids';

/**
 * Node actions for the work loop — Layer-2 evaluation, Layer-3 plan
 * draft, and post-approval skill execution.
 */

interface SimpleSkillRow {
  _id: Id<'skills'>;
  name: string;
  description: string;
  body: string;
}

function rowToCandidate(row: Doc<'workItems'>): WorkCandidate {
  return {
    sourceCategory: row.sourceCategory as WorkSourceCategory,
    sourceSystem: row.sourceSystem,
    externalId: row.externalId,
    title: row.title,
    contentSummary: row.contentSummary,
    contentRefs: row.contentRefs,
    observedAt: new Date(row.observedAt),
    priority: row.priority,
    requesterLabel: row.requesterLabel,
  };
}

function buildLookups(args: {
  ctx: any;
  agentId: Id<'agents'>;
  registeredSkills: SimpleSkillRow[];
  grantedScopes: Set<string>;
}): EvaluateLookups {
  return {
    hasGrantForScope: async (scope) => args.grantedScopes.has(scope),
    findExistingClaim: async (sourceSystem, externalId) => {
      return await args.ctx.runQuery(api.work.findExistingClaim, {
        agentId: args.agentId,
        sourceSystem,
        externalId,
      });
    },
    countOpenClaims: async () => {
      return await args.ctx.runQuery(api.work.countOpenForAgent, { agentId: args.agentId });
    },
    findMatchingSkill: async (candidate, charter) => {
      void charter;
      const tokenise = (s: string) =>
        new Set(s.toLowerCase().split(/\W+/).filter((t) => t.length >= 4));
      const candidateTokens = tokenise(`${candidate.title} ${candidate.contentSummary}`);
      const sourceTokens = candidate.sourceSystem.toLowerCase().split(/\W+/).filter(Boolean);
      let best: SimpleSkillRow | null = null;
      let bestScore = 0;
      for (const skill of args.registeredSkills) {
        const skillTokens = tokenise(`${skill.name} ${skill.description}`);
        let score = 0;
        for (const t of candidateTokens) if (skillTokens.has(t)) score += 1;
        for (const t of sourceTokens) if (skillTokens.has(t)) score += 4;
        if (score > bestScore) {
          best = skill;
          bestScore = score;
        }
      }
      // Require either a sourceSystem hit (4 pts) or several content overlaps.
      if (!best || bestScore < 3) return null;
      return { name: best.name, description: best.description };
    },
  };
}

export const evaluateWorkItem = action({
  args: { agentId: v.id('agents'), workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ decision: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
    if (!item) throw new Error('workItem not found');
    // Race-tolerance: the dashboard's auto-progress useEffect can fire
    // evaluateWorkItem after the item already moved past `discovered`
    // (e.g. evaluator + draftPlan on the same render tick). The
    // findExistingClaim self-match below would otherwise see the
    // item's own `claimed` state and stomp the verdict back to skip.
    // No-op cleanly in that case — same posture as draftPlan and
    // executeApprovedPlan (lines below).
    if (item.state !== 'discovered') {
      return { decision: `noop-state=${item.state}` };
    }
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId: args.agentId,
    });
    if (!charterRow || !charterRow.approved) {
      throw new Error('cannot evaluate: charter not approved');
    }
    const charter = charterRow.body as Charter;
    const agentsMd = await ctx.runQuery(api.workspace.readFile, {
      agentId: args.agentId,
      fileName: 'AGENTS.md',
    });
    const registeredSkills: SimpleSkillRow[] = (
      await ctx.runQuery(api.skills.registered, { agentId: args.agentId })
    ).map((s: Doc<'skills'>) => ({
      _id: s._id,
      name: s.name,
      description: s.description,
      body: s.body,
    }));
    const grantRows: Doc<'permissionGrants'>[] = await ctx.runQuery(internal.agents.grantedScopes, {
      agentId: args.agentId,
    });
    const grantedScopes = new Set<string>(grantRows.map((g) => g.scope));

    const lookups = buildLookups({
      ctx,
      agentId: args.agentId,
      registeredSkills,
      grantedScopes,
    });
    const candidate = rowToCandidate(item);
    const verdict = await evaluateCandidate(
      candidate,
      {
        agentId: asAgentId(args.agentId),
        charter,
        agentsMd: agentsMd ?? '',
        bossLabel: charter.approvalChain.boss,
      },
      lookups,
    );
    await ctx.runMutation(internal.work.setVerdict, {
      workItemId: args.workItemId,
      verdict,
    });

    // For needs-skill, propose a new skill row immediately.
    if (verdict.decision === 'needs-skill') {
      const required = inferRequiredPermissions(candidate);
      const writeScope = `${candidate.sourceSystem}:write`;
      const requiredScopes = [...new Set([...required, writeScope])];
      const skillId = await ctx.runMutation(internal.skills.propose, {
        agentId: args.agentId,
        workItemId: args.workItemId,
        name: verdict.suggestedSkillName,
        description: `Skill proposed to handle ${candidate.sourceSystem} work like "${candidate.title}".`,
        rationale: verdict.suggestedSkillRationale,
        requiredScopes,
      });
      await ctx.runMutation(internal.work.setProposedSkill, {
        workItemId: args.workItemId,
        skillId,
      });
    }

    return { decision: verdict.decision };
  },
});

export const draftPlan = action({
  args: { agentId: v.id('agents'), workItemId: v.id('workItems') },
  handler: async (
    ctx,
    args,
  ): Promise<{ ok: boolean; reason?: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
    if (!item) return { ok: false, reason: 'workItem not found' };
    // Race-tolerant: the dashboard's auto-progress useEffect can fire
    // draftPlan after the state has already moved past 'claimed' (e.g.
    // a stale render, or an evaluator stomp). Treat the mismatch as a
    // no-op rather than an error so the React tree doesn't surface it
    // as a fatal Console Error.
    if (item.state !== 'claimed') {
      return { ok: false, reason: `state is ${item.state}; expected claimed` };
    }
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId: args.agentId,
    });
    if (!charterRow) return { ok: false, reason: 'no charter' };
    const plan = await draftExecutionPlan({
      candidate: rowToCandidate(item),
      charter: charterRow.body as Charter,
    });
    await ctx.runMutation(internal.work.setPlan, {
      workItemId: args.workItemId,
      plan,
    });
    return { ok: true };
  },
});

export const executeApprovedPlan = action({
  args: { agentId: v.id('agents'), workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<{ ok: boolean; reason?: string }> => {
    const item: Doc<'workItems'> | null = await ctx.runQuery(api.work.get, {
      workItemId: args.workItemId,
    });
    if (!item) return { ok: false, reason: 'workItem not found' };
    // Same race tolerance as draftPlan — if the auto-progress effect fires
    // after state moved past plan-approved, no-op instead of throwing.
    if (item.state !== 'plan-approved') {
      return { ok: false, reason: `state is ${item.state}; expected plan-approved` };
    }
    const charterRow = await ctx.runQuery(api.charters.latest, {
      agentId: args.agentId,
    });
    if (!charterRow) return { ok: false, reason: 'no charter' };
    const charter = charterRow.body as Charter;
    const plan = item.plan as Awaited<ReturnType<typeof draftExecutionPlan>>;
    const candidate = rowToCandidate(item);

    const skills: Doc<'skills'>[] = await ctx.runQuery(api.skills.registered, {
      agentId: args.agentId,
    });
    const lower = (candidate.title + ' ' + candidate.contentSummary + ' ' + candidate.sourceSystem).toLowerCase();
    let pickedSkill = skills.find((s) =>
      lower.includes(s.name.toLowerCase().split('-')[0] ?? ''),
    );
    if (!pickedSkill) pickedSkill = skills[0];
    if (!pickedSkill) {
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        reason: 'no registered skill available',
      });
      return { ok: false, reason: 'no registered skill available' };
    }
    await ctx.runMutation(internal.work.setExecutingWithSkill, {
      workItemId: args.workItemId,
      skillId: pickedSkill._id,
    });
    try {
      const mockEnv = await loadMockEnvSnapshot(ctx, args.agentId);
      const output = await runSkill({
        skill: { name: pickedSkill.name, description: pickedSkill.description, body: pickedSkill.body },
        plan,
        candidate,
        charter,
        mockEnv,
      });
      const applied = await applyMockActions(ctx, args.agentId, output.actions ?? []);
      await ctx.runMutation(internal.work.setCompleted, {
        workItemId: args.workItemId,
        output: { ...output, applied },
      });
      return { ok: true };
    } catch (err) {
      const reason = (err as Error).message;
      await ctx.runMutation(internal.work.setFailed, {
        workItemId: args.workItemId,
        reason,
      });
      return { ok: false, reason };
    }
  },
});

// ---------- Mock environment helpers ----------

async function loadMockEnvSnapshot(
  ctx: any,
  agentId: Id<'agents'>,
): Promise<MockSurfaceSnapshot> {
  const docs: Doc<'mockDocs'>[] = await ctx.runQuery(api.mock.listDocs, { agentId });
  const sheets: Doc<'mockSpreadsheets'>[] = await ctx.runQuery(api.mock.listSpreadsheets, { agentId });
  const channels: Doc<'mockSlackChannels'>[] = await ctx.runQuery(api.mock.listChannels, { agentId });
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

async function applyMockActions(
  ctx: any,
  agentId: Id<'agents'>,
  actions: MockAction[],
): Promise<Array<{ tool: string; ok: boolean; reason?: string }>> {
  const applied: Array<{ tool: string; ok: boolean; reason?: string }> = [];
  for (const action of actions) {
    const args = action.args ?? {};
    try {
      switch (action.tool) {
        case 'spreadsheet.appendRow':
          if (!args.sheetSlug || !args.tabName || !args.cells) {
            applied.push({ tool: action.tool, ok: false, reason: 'missing sheetSlug/tabName/cells' });
            continue;
          }
          {
            const cellsObj: Record<string, string> = {};
            for (const c of args.cells) cellsObj[c.header] = c.value;
            await ctx.runMutation(internal.mock.appendSpreadsheetRow, {
              agentId,
              sheetSlug: args.sheetSlug,
              tabName: args.tabName,
              cells: cellsObj,
              addedBy: 'Day0 (agent)',
            });
          }
          break;
        case 'slack.postMessage':
          if (!args.channelSlug || !args.body) {
            applied.push({ tool: action.tool, ok: false, reason: 'missing channelSlug/body' });
            continue;
          }
          await ctx.runMutation(internal.mock.postSlackMessage, {
            agentId,
            channelSlug: args.channelSlug,
            threadKey: args.threadKey,
            sender: 'Day0',
            senderKind: args.channelSlug.startsWith('dm-') ? 'agent-posted' : 'agent-draft',
            body: args.body,
          });
          await ctx.scheduler.runAfter(
            3500 + Math.floor(Math.random() * 2500),
            internal.coworker.replyToAgentMessage,
            {
              agentId,
              channelSlug: args.channelSlug,
              threadKey: args.threadKey,
              originalBody: args.body,
            },
          );
          break;
        case 'twitter.reply':
          if (!args.tweetSlug || !args.body) {
            applied.push({ tool: action.tool, ok: false, reason: 'missing tweetSlug/body' });
            continue;
          }
          await ctx.runMutation(internal.mock.postTweetReply, {
            agentId,
            tweetSlug: args.tweetSlug,
            author: 'Day0',
            handle: '@day0_agent',
            body: args.body,
            isAgentDraft: true,
          });
          break;
        case 'ticket.update':
          if (!args.slug) {
            applied.push({ tool: action.tool, ok: false, reason: 'missing slug' });
            continue;
          }
          await ctx.runMutation(internal.mock.updateTicket, {
            agentId,
            slug: args.slug,
            status: args.status,
            comment: args.comment,
            commentAuthor: 'Day0',
          });
          break;
        default:
          applied.push({ tool: (action as { tool: string }).tool, ok: false, reason: 'unknown tool' });
          continue;
      }
      applied.push({ tool: action.tool, ok: true });
    } catch (err) {
      applied.push({ tool: action.tool, ok: false, reason: (err as Error).message });
    }
  }
  return applied;
}
