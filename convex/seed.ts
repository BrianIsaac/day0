"use node";

import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgentAction } from './ownership';

/**
 * Seed the demo environment for an agent. Idempotent — safe to call
 * multiple times. Installs the one bundled "see-docs" skill, plus
 * the three synthetic work items that drive the demo narrative.
 */

const SEE_DOCS_SKILL_BODY = `# SKILL: see-internal-docs

## When to invoke
The boss or a teammate has asked a question whose answer is plausibly in the team's internal docs (wiki pages, runbooks, onboarding material).

## Inputs
- \`query\` (string): the question or topic to look up.
- \`docs_index\` (array of {title, body}): the searchable internal-docs corpus exposed by Day0's docs surface.

## Procedure
1. Tokenise the query; identify 2-4 key terms (proper nouns, domain words, action verbs).
2. Score each doc by token overlap with title (weight 3) + body (weight 1).
3. Take the top 3 docs, read them in full.
4. Synthesise an answer in 2-4 sentences. Cite each fact back to its doc title in parentheses.
5. If the docs do not answer the question, say so explicitly. Do not invent.

## Output
- \`answer\` (string): the synthesised answer with inline citations.
- \`docs_consulted\` (array of strings): titles of docs read.
- \`coverage\` ("complete" | "partial" | "none"): your confidence the docs covered the question.

## Boundaries
- Drafts only — never claim an answer was posted to the team.
- If the question implies needing to *change* something (update a spreadsheet, file a ticket), surface that as a follow-up; this skill is read-only.
`;

const WORK_ITEMS = [
  {
    sourceCategory: 'ticket-queue',
    sourceSystem: 'spreadsheet',
    externalId: 'sheet-Q4-revenue',
    title: "Update Q4 revenue tracker with last week's closed-won deals",
    contentSummary: [
      "Manager: \"Can you take the three closed-won deals from last Friday's standup and add them to the Q4 Revenue Tracker spreadsheet? Acme ($45k), Beta Corp ($72k), Gamma LLC ($28k). They go under the 'closed-won' tab.\"",
      'Standup transcript link is pasted below for context. This is the kind of revops tracker maintenance asked of the new hire — needs spreadsheet write access.',
      'Tracking ticket: REVOPS-203 (open). Close it once the rows are in.',
    ].join('\n'),
    contentRefs: ['mock-spreadsheet://q4-revenue-tracker', 'ticket://REVOPS-203'],
    priority: 'P1',
    requesterLabel: 'Manager',
  },
  {
    sourceCategory: 'inbox',
    sourceSystem: 'docs',
    externalId: 'docs-pipeline-segments',
    title: 'Tier-2 ask: where is enterprise pipeline coverage trending?',
    contentSummary: [
      'New joiner asked in #revops-asks (thread: thread-pipeline-coverage): "What does our enterprise segment pipeline coverage look like over the last four weeks? Trying to brief the CRO ahead of Tuesday."',
      'Pipeline + segment trend — exactly the tier-2 RevOps work the new analyst was hired to draft answers for, using internal docs and tracker data.',
    ].join('\n'),
    contentRefs: [
      'docs-fixture/team-overview.md',
      'docs-fixture/escalation-paths.md',
      'channel://revops-asks#thread-pipeline-coverage',
    ],
    priority: 'P2',
    requesterLabel: 'Priya (senior analyst)',
  },
  {
    sourceCategory: 'inbox',
    sourceSystem: 'social',
    externalId: 'tweet-1234',
    title: "Reply cleverly to @random_person's tweet about our brand",
    contentSummary: [
      'Random person on Twitter said "@AcmeCo your product is fine I guess." Manager forwarded asking if the new hire could "respond cleverly with some brand voice."',
      'Marketing-adjacent chatter, no analytical or tracker angle. Forwarded to the team but does not match the revops scope.',
    ].join('\n'),
    contentRefs: ['twitter://1234567890'],
    priority: 'low',
    requesterLabel: 'Manager (forwarded)',
  },
];

export const seedDemo = action({
  args: { agentId: v.id('agents') },
  handler: async (
    ctx,
    args,
  ): Promise<{ skillsInstalled: number; workItemsSeeded: number; mockEnvSeeded: boolean }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    const skillId = await ctx.runMutation(internal.skills.installBuiltin, {
      agentId: args.agentId,
      name: 'see-internal-docs',
      description: 'Read internal team docs and synthesise an answer with inline citations.',
      body: SEE_DOCS_SKILL_BODY,
    });
    void skillId;

    let seeded = 0;
    for (const item of WORK_ITEMS) {
      await ctx.runMutation(internal.work.seedItem, {
        agentId: args.agentId,
        ...item,
      });
      seeded += 1;
    }

    await ctx.runMutation(internal.mockSeed.seedMockEnvironment, { agentId: args.agentId });

    return { skillsInstalled: 1, workItemsSeeded: seeded, mockEnvSeeded: true };
  },
});
