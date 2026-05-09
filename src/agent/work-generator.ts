import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { Charter } from './charter';

/**
 * Generate three day-one work items tailored to the boss's charter.
 *
 * Replaces the hardcoded RevOps work seed: the boss-facing demo now
 * shows work that matches the role they described in the Day-1 1:1.
 *
 * The generated mix drives the standard demo narrative:
 *   1. A docs-read item — handled by the builtin `see-internal-docs` skill
 *   2. An action item — triggers the propose-new-skill loop
 *   3. An out-of-scope item — evaluator skips it
 */

const WORK_GEN_SYSTEM = [
  'You generate 3 day-one work items for a newly-deployed autonomous agent.',
  'The boss has just approved the agent\'s charter; three realistic inbox-style requests now land in the agent\'s queue — the kind of work a competent new hire would face on their first week.',
  '',
  'The mock work environment has the following surfaces. Reference these exact identifiers in contentRefs:',
  '  - Slack channels: "revops", "revops-asks" (channels); "dm-aman", "dm-manager", "dm-priya" (DMs)',
  '  - Spreadsheet slug "q4-revenue-tracker" with tabs "closed-won" and "pipeline"',
  '  - Docs (team-doc): "team-overview", "on-call", "escalation-paths", "onboarding"',
  '  - Tweet slug "tweet-acme-feedback" by handle "@random_person"',
  '  - Tickets: "REVOPS-201", "REVOPS-202", "REVOPS-203"',
  '',
  'Generate exactly 3 items, in this order, with this purpose:',
  '',
  '1. Read-and-answer item — sourceSystem MUST be "docs". A question the agent answers by reading internal team docs (the agent has a builtin "see-internal-docs" skill). Pick a topic that fits the role described in the charter.',
  '',
  '2. Action item — sourceSystem MUST be "spreadsheet" or "ticket" or "social". A task requiring an action beyond reading — append a row, update a ticket, post a reply. This will trigger the propose-new-skill flow. Should match the role.',
  '',
  '3. Out-of-scope item — sourceSystem can be anything. A task that is plausibly forwarded by a colleague but lies outside the role in the charter. Make the mismatch clear (e.g. ask a RevOps agent to do marketing copy, or ask a marketing agent to triage on-call tickets). The evaluator should skip this.',
  '',
  'Discipline:',
  '  - Each contentSummary is 2-3 sentences and includes a direct quoted request from a named person (Manager, Priya, Aman, or a teammate).',
  '  - contentRefs reference the surface identifiers above (e.g. "ticket://REVOPS-203", "channel://revops-asks#thread-pipeline-coverage", "twitter://1234567890", "mock-spreadsheet://q4-revenue-tracker", "docs-fixture/team-overview.md").',
  '  - externalIds are unique stable strings (e.g. "docs-pipeline-segments", "sheet-Q4-revenue", "ticket-revops-203", "tweet-acme-feedback").',
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

export async function generateWorkItemsFromCharter(
  charter: Charter,
): Promise<GeneratedWorkItem[]> {
  const result = await agentJson<z.infer<typeof workGenSchema>>({
    agent: workGeneratorAgent,
    user: [
      'Charter:',
      JSON.stringify(charter, null, 2),
      '',
      'Generate the 3 day-one work items now.',
    ].join('\n'),
    schema: workGenSchema,
  });
  return result.items;
}
