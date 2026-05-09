"use node";

import { v } from 'convex/values';
import { action } from './_generated/server';
import { internal } from './_generated/api';
import { assertOwnsAgentAction } from './ownership';

/**
 * Seed the demo environment for an agent. Idempotent — safe to call
 * multiple times. Installs the bundled "see-internal-docs" skill and
 * seeds the mock work environment (Slack, spreadsheet, docs, twitter,
 * tickets). Work items are NOT seeded here — they're generated from
 * the boss's approved charter in `onboarding.postCharterApproval` so
 * the queue reflects the role the boss actually described.
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

export const seedDemo = action({
  args: { agentId: v.id('agents') },
  handler: async (
    ctx,
    args,
  ): Promise<{ skillsInstalled: number; mockEnvSeeded: boolean }> => {
    await assertOwnsAgentAction(ctx, args.agentId);
    await ctx.runMutation(internal.skills.installBuiltin, {
      agentId: args.agentId,
      name: 'see-internal-docs',
      description: 'Read internal team docs and synthesise an answer with inline citations.',
      body: SEE_DOCS_SKILL_BODY,
    });

    await ctx.runMutation(internal.mockSeed.seedMockEnvironment, { agentId: args.agentId });

    return { skillsInstalled: 1, mockEnvSeeded: true };
  },
});
