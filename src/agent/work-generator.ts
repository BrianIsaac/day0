import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from './charter';
import type { MockSurfaceSnapshot } from '../work/types';

/**
 * Generate three day-one work items grounded in the boss's charter AND
 * the agent's actual mock environment.
 *
 * No hardcoded slugs in the prompt — we render the live surface
 * snapshot (slack channels, spreadsheets, docs, tweets, tickets) so the
 * LLM picks real identifiers that exist on the agent's workbench. Each
 * generated work item references concrete surface rows the executor can
 * later mutate.
 *
 * The 3-item mix drives the standard demo narrative:
 *   1. A docs-read item — handled by the builtin `see-internal-docs` skill
 *   2. An action item — triggers the propose-new-skill loop
 *   3. An out-of-scope item — evaluator skips it
 */

const WORK_GEN_SYSTEM = [
  'You generate 3 day-one work items for a newly-deployed autonomous agent.',
  'The boss has just approved the agent\'s charter; three realistic inbox-style requests now land in the agent\'s queue — the kind of work a competent new hire would face on their first week.',
  '',
  'You will be given (a) the charter and (b) a snapshot of the agent\'s actual mock work environment with real slugs/IDs. Use ONLY surface identifiers that appear in the snapshot — never invent slugs the env doesn\'t have. Each work item\'s contentRefs must reference real rows the executor can later mutate.',
  '',
  'Generate exactly 3 items, in this order, with this purpose:',
  '',
  '1. Read-and-answer item — sourceSystem MUST be "docs". A question the agent answers by reading internal team docs (the agent has a builtin "see-internal-docs" skill). Pick a topic that fits the role described in the charter and a doc slug that actually exists in the snapshot.',
  '',
  '2. Action item — sourceSystem MUST be one of "spreadsheet" / "ticket" / "social" / "slack" — pick whichever surface best fits the charter\'s role. The task requires a write action (append a row, update a ticket, post a reply, post a message) on a surface that exists in the snapshot. This will trigger the propose-new-skill flow.',
  '',
  '3. Out-of-scope item — sourceSystem can be anything. A task that is plausibly forwarded by a colleague but lies outside the role described in the charter. Make the mismatch clear (e.g. ask a marketing-charter agent to triage RevOps tickets, or ask a RevOps-charter agent to draft marketing copy). The evaluator should skip this. May or may not reference an existing surface.',
  '',
  'Discipline:',
  '  - Each contentSummary is 2-3 sentences and includes a direct quoted request from a named person (the named collaborators in the charter, or "Manager" for the boss).',
  '  - contentRefs must use slugs/IDs that appear verbatim in the snapshot. Format: "channel://<slug>", "channel://<slug>#thread-<key>", "ticket://<slug>", "twitter://<slug>", "mock-spreadsheet://<slug>", "docs-fixture/<slug>". If the surface doesn\'t exist in the snapshot, do not invent a contentRef for it.',
  '  - externalIds are unique stable strings derived from the surface and topic (e.g. "docs-<slug>", "sheet-<slug>", "tweet-<slug>", "ticket-<slug>").',
  '  - Vary priorities: ideally one P1, one P2, one low.',
  '  - requesterLabel is a person\'s name or role; never the agent itself.',
  '  - Titles are 8-14 words.',
  '  - sourceCategory is one of "ticket-queue", "inbox", or "social-mention".',
].join('\n');

export const workGenSchema = z.object({
  items: z
    .array(
      z.object({
        sourceCategory: z.string(),
        sourceSystem: z.string(),
        externalId: z.string(),
        title: z.string(),
        contentSummary: z.string(),
        contentRefs: z.array(z.string()),
        priority: z.string(),
        requesterLabel: z.string(),
      }),
    )
    .min(3)
    .max(3),
});

export type GeneratedWorkItem = z.infer<typeof workGenSchema>['items'][number];

const workGeneratorAgent = makeAgent('day0-work-generator', WORK_GEN_SYSTEM);

/**
 * Render the mock environment snapshot as a compact, slug-forward
 * description the LLM can copy identifiers out of without hallucinating.
 */
function renderMockSnapshot(env: MockSurfaceSnapshot): string {
  const lines: string[] = [];
  if (env.slackChannels.length) {
    lines.push('Slack channels and DMs:');
    for (const c of env.slackChannels) {
      lines.push(`  - slug "${c.slug}" (${c.kind}, displayed as "${c.displayName}")`);
    }
  }
  if (env.spreadsheets.length) {
    lines.push('Spreadsheets:');
    for (const s of env.spreadsheets) {
      const tabs = s.tabs.map((t) => t.name).join(', ');
      lines.push(`  - slug "${s.slug}" titled "${s.title}" with tabs: ${tabs}`);
    }
  }
  if (env.teamDocs.length) {
    lines.push('Team docs (read-only):');
    for (const d of env.teamDocs) {
      lines.push(`  - slug "${d.slug}" titled "${d.title}"`);
    }
  }
  if (env.tweets.length) {
    lines.push('Tweets the agent could reply to:');
    for (const t of env.tweets) {
      lines.push(`  - slug "${t.slug}" by ${t.handle} (${t.author}): "${t.body.slice(0, 140)}"`);
    }
  }
  if (env.tickets.length) {
    lines.push('Tickets:');
    for (const t of env.tickets) {
      lines.push(`  - slug "${t.slug}" titled "${t.title}" (status: ${t.status})`);
    }
  }
  return lines.join('\n');
}

export async function generateWorkItemsFromCharter(
  charter: Charter,
  mockEnv: MockSurfaceSnapshot,
): Promise<GeneratedWorkItem[]> {
  const result = await agentJson<z.infer<typeof workGenSchema>>({
    agent: workGeneratorAgent,
    user: [
      'Charter:',
      JSON.stringify(charter, null, 2),
      '',
      'Live mock environment snapshot (use these EXACT slugs in contentRefs):',
      renderMockSnapshot(mockEnv),
      '',
      'Generate the 3 day-one work items now.',
    ].join('\n'),
    schema: workGenSchema,
  });
  return result.items;
}
