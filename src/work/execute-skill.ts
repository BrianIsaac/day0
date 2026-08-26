import { z } from 'zod';
import { Agent } from '@mastra/core/agent';
import { agentJson, MODEL_CONFIG } from '../lib/mastra';
import type { Charter } from '../agent/charter';
import {
  ACTION_TOOLS,
  type ExecutionOutput,
  type ExecutionPlan,
  type MockAction,
  type MockSurfaceSnapshot,
  type WorkCandidate,
} from './types';
import type { SurfaceRecord } from '../surfaces/types';
import { verdictFor } from '../surfaces/verdict';

/**
 * Skill executor. Lifted from Protean's `src/work/execute-skill.ts`
 * and adapted to Mastra Agent + GPT-5.5 with structured output.
 *
 * The skill body is prepended to the system prompt as a behavioural
 * prior. The executor returns:
 *   - draft: the deliverable the manager reads. Written in the same turn that
 *     emits the actions and before any of them is applied, so it is the
 *     agent's account of the work and never the record of it — that is the
 *     applied ledger the caller builds from the adapters.
 *   - notes: assumptions / open questions
 *   - actions: typed mutations against mock work surfaces (Spreadsheet,
 *     Slack, Twitter, Ticket); the workActions handler applies them in
 *     sequence so the dashboard sees the surfaces update live.
 *
 * The agent learns the actions[] schema from the per-agent how-to-update
 * guides (mockDocs category 'how-to-guide'). Those guides are injected
 * into the system prompt below so the schema is documented in-context.
 */

const SYSTEM_PROMPT_PREAMBLE = [
  'You are an autonomous workplace agent named Day0.',
  'A skill body has been loaded as your behavioural prior for this turn. The boss has approved the plan; you are authorised to act.',
  'Apply the skill to the candidate. Produce three things:',
  '  1. A draft (human-readable) — the deliverable the manager reads and decides whether to ratify.',
  '  2. Notes — short assumptions or open questions (single sentence).',
  '  3. Actions — typed mutations against mock work surfaces (spreadsheet, slack, twitter, ticket). These are the only things that reach the work environment.',
  '',
  'The draft is written before a single action has been applied, so anything it claims about completed work is a prediction, and a wrong one costs the manager their trust in every other line of it. Therefore:',
  '  - The draft may describe only what the actions in THIS response do. One change is one action: three rows appended means three `spreadsheet.appendRow` actions, not one action and a sentence saying three.',
  '  - Never name a surface, a channel, a ticket or a quantity the actions do not carry. "Notified the team" is false unless a `slack.postMessage` in this response says it.',
  '  - Work that emits no actions changes nothing and does not count as done. If the skill calls for no mutation, say so in `notes` rather than describing the work as finished.',
  '',
  'Action format: see the how-to-update guides in your context. Each action is { tool: string, args: object }. Available tools:',
  "  - spreadsheet.appendRow — { sheetSlug, tabName, cells: [{ header, value }, …] }",
  "  - slack.postMessage    — { channelSlug, threadKey?, body }",
  "  - twitter.reply        — { tweetSlug, body }",
  "  - ticket.update        — { slug, status?, comment? }",
  '',
  'Discipline:',
  '  - Stay inside charter boundaries.',
  '  - Never invent values you do not have. If a cell value is unknown, leave it blank in `cells` and flag the gap in `notes`.',
  '  - Cold-start posture: prefer drafts to manager DM (`channelSlug: "dm-manager"`) over public channel posts. The candidate has already passed the charter quality-fit gate, so it IS in scope — emit the actions the skill calls for.',
  '',
  'Closing the loop (cross-surface fanout):',
  '  - Every surface that originated or was named in this work item should see at least one entry showing the work happened. The audit trail is non-negotiable.',
  '  - BASE actions for any in-charter work are always: (a) the primary mutation(s) — e.g. `spreadsheet.appendRow` for tracker updates, or `twitter.reply` for in-scope social — AND (b) a `slack.postMessage` to `dm-manager` summarising the draft for review. The fanout rules below are appended IN ADDITION to (a) and (b); they never replace either.',
  '  - If the candidate `Source` line contains `ticket-queue`, ALSO append a `ticket.update` against the originating ticket — usually named in the candidate body (e.g. "Tracking ticket: REVOPS-203") or surfaced via the `Refs:` line. `status: "done"` for full closure, `"in-progress"` otherwise. `comment` summarises what you did in one or two sentences.',
  '  - If your draft body cites another ticket slug from the env snapshot (e.g. "REVOPS-202 already covers the Looker refresh"), ALSO fire a second `ticket.update` against that cited ticket cross-linking your work — `status: "in-progress"`, one-line `comment`.',
  '  - If the original ask came from a public Slack channel (look for "in #channel-name" or "asked in #revops-asks" in the candidate body) AND you have drafted to manager DM, ALSO post a threaded `slack.postMessage` to the originating channel — `channelSlug` is that channel, `threadKey` matches the ask thread, body says something like "Drafting for {manager} — will post here when approved."',
  '  - These extra actions are NOT optional when the conditions hold; they are how the agent demonstrates trustworthy follow-through. NEVER replace the manager DM with a ticket update — both fire.',
].join('\n');

/**
 * The action-args schema is intentionally flat: every action lists its
 * own arg fields as optional at the top level. OpenAI's structured-
 * output strict mode rejects `z.any()`, and discriminatedUnion → oneOf
 * doesn't round-trip cleanly through openai.beta.chat.completions.
 * The flat shape keeps the JSON schema valid and readable.
 */
export const actionArgsSchema = z.object({
  // spreadsheet.appendRow — cells encoded as array of header/value pairs
  // because OpenAI structured-output strict mode rejects `propertyNames`
  // (the JSON-schema field z.record produces).
  sheetSlug: z.string().optional(),
  tabName: z.string().optional(),
  cells: z
    .array(
      z.object({
        header: z.string(),
        value: z.string(),
      }),
    )
    .optional(),
  // slack.postMessage
  channelSlug: z.string().optional(),
  threadKey: z.string().optional(),
  // shared body for slack/twitter
  body: z.string().optional(),
  // twitter.reply
  tweetSlug: z.string().optional(),
  // ticket.update
  slug: z.string().optional(),
  status: z.enum(['open', 'in-progress', 'blocked', 'done']).optional(),
  comment: z.string().optional(),
  // mcp.call and http.request. Structured provider arguments travel as JSON
  // strings, parsed and size-capped server-side, so the bag stays flat.
  surface: z.string().optional(),
  tool: z.string().optional(),
  toolArgsJson: z.string().optional(),
  method: z.string().optional(),
  path: z.string().optional(),
  headersJson: z.string().optional(),
});

export const executeSchema = z.object({
  draft: z.string(),
  notes: z.string(),
  actions: z.array(
    z.object({
      tool: z.enum(ACTION_TOOLS),
      args: actionArgsSchema,
    }),
  ),
});

export interface SelectedSkill {
  name: string;
  description: string;
  body: string;
}

export interface RunSkillArgs {
  skill: SelectedSkill;
  plan: ExecutionPlan;
  candidate: WorkCandidate;
  charter: Charter;
  mockEnv: MockSurfaceSnapshot;
  /**
   * Discovered surfaces, real mode only. When any is connected the executor is
   * told about the two surface verbs; in mock mode the prompt is unchanged.
   */
  surfaces?: readonly SurfaceRecord[];
  /** Clock for the connection verdict; defaults to now. */
  now?: number;
}

/**
 * Describe the connected surfaces and the two verbs that reach them.
 *
 * Only connected surfaces are listed: a skill may not target anything else,
 * and the executor is told so rather than left to guess from a slug. The
 * `dm-manager` fanout rule from the mock preamble maps to the chat surface's
 * manager DM channel id, which the probe stored on the surface.
 *
 * Args:
 *   surfaces: Surface rows for the agent.
 *   now: Clock used for the liveness verdict.
 *
 * Returns:
 *   Prompt lines, or an empty string when no surface is connected.
 */
export function surfaceInstructions(surfaces: readonly SurfaceRecord[], now: number): string {
  const connected = surfaces.filter((surface) => verdictFor(surface, now) === 'connected');
  if (connected.length === 0) return '';
  const lines: string[] = [
    'Connected real surfaces (name each exactly as listed; take the action shape from its runbook):',
  ];
  for (const surface of connected) {
    const detail: string[] = [`class ${surface.class}`];
    if (surface.path) detail.push(`path ${surface.path}`);
    if (surface.endpoint) detail.push(`endpoint ${surface.endpoint}`);
    detail.push(
      `allowed tools: ${surface.toolAllowlist?.length ? surface.toolAllowlist.join(', ') : '(none)'}`,
    );
    if (surface.managerDmChannelId) {
      detail.push(`manager DM channel id: ${surface.managerDmChannelId}`);
    }
    lines.push(`  - ${surface.slug} (${surface.displayName}) - ${detail.join(' · ')}`);
  }
  lines.push(
    '',
    'Two verbs reach a real surface. Their structured arguments travel as JSON strings:',
    '  - mcp.call     - { surface, tool, toolArgsJson }: `tool` must be in the surface allowlist; `toolArgsJson` is the JSON object of tool arguments.',
    '  - http.request - { surface, method, path, headersJson, body }: `path` is relative to the surface endpoint; `headersJson` is a JSON object of headers; `body` is the request body.',
    '  - Write `{{secret}}` where the runbook shows the credential; the server substitutes the stored credential. Never include a token, key or secret value.',
    '  - You may only target a surface listed above. A system without a connected surface gets no action; say so in `notes`.',
    '  - The manager DM rule (`dm-manager`) for a connected chat surface is an `http.request` to `chat.postMessage` with `channel` set to the manager DM channel id above. Posts to any other channel are held for the manager and never sent.',
    '  - Do not add a provenance trailer or a `username`: the server appends the employee name and run id to every comment or message sent through a shared credential.',
    '  - A status change on a ticket must be preceded, in the same response, by a comment on that ticket.',
  );
  return lines.join('\n');
}

function renderHowTos(guides: MockSurfaceSnapshot['howToGuides']): string {
  if (guides.length === 0) return '(no how-to guides loaded)';
  return guides.map((g) => `--- ${g.title} ---\n${g.body}`).join('\n\n');
}

function renderTeamDocs(docs: MockSurfaceSnapshot['teamDocs']): string {
  if (docs.length === 0) return '(no team docs loaded)';
  return docs.map((d) => `--- ${d.title} ---\n${d.body}`).join('\n\n');
}

function renderEnvSnapshot(env: MockSurfaceSnapshot): string {
  const lines: string[] = [];
  lines.push('## Spreadsheets');
  for (const sh of env.spreadsheets) {
    lines.push(`### ${sh.title} (slug: ${sh.slug})`);
    for (const tab of sh.tabs) {
      lines.push(`Tab "${tab.name}" headers: ${tab.headers.join(' | ')}`);
      const rowsForTab = sh.rows.filter((r) => r.tabName === tab.name);
      if (rowsForTab.length === 0) {
        lines.push('  (no rows yet)');
      } else {
        for (const r of rowsForTab.slice(-10)) {
          lines.push('  · ' + tab.headers.map((h) => `${h}=${r.cells[h] ?? ''}`).join(', '));
        }
      }
    }
  }
  lines.push('');
  lines.push('## Slack channels (recent messages)');
  for (const ch of env.slackChannels) {
    lines.push(`### ${ch.displayName} (slug: ${ch.slug}, kind: ${ch.kind})`);
    for (const m of ch.recentMessages.slice(-6)) {
      lines.push(`  · [${m.sender}${m.threadKey ? ` thread=${m.threadKey}` : ''}]: ${m.body}`);
    }
  }
  lines.push('');
  lines.push('## Tweets');
  for (const t of env.tweets) {
    lines.push(`  · ${t.handle}: ${t.body} (slug: ${t.slug})`);
  }
  lines.push('');
  lines.push('## Tickets');
  for (const t of env.tickets) {
    lines.push(`  · ${t.slug} [${t.status}] ${t.title}`);
  }
  return lines.join('\n');
}

export async function runSkill(args: RunSkillArgs): Promise<ExecutionOutput> {
  const { skill, plan, candidate, charter, mockEnv } = args;
  const surfaceGuidance = surfaceInstructions(args.surfaces ?? [], args.now ?? Date.now());
  const instructions = [
    SYSTEM_PROMPT_PREAMBLE,
    ...(surfaceGuidance ? ['', surfaceGuidance] : []),
    '',
    '--- How-to guides (action format reference) ---',
    renderHowTos(mockEnv.howToGuides),
    '',
    '--- Skill body (apply as your behavioural prior) ---',
    skill.body,
  ].join('\n');

  const skillAgent = new Agent({
    id: `day0-skill-${skill.name}`,
    name: `day0-skill-${skill.name}`,
    instructions,
    model: MODEL_CONFIG,
  });

  const userPrompt = [
    `Role: ${charter.proposedFunction}`,
    '',
    `Charter willDo: ${charter.proposedBoundaries.willDo.join(' | ')}`,
    `Charter willNotDo: ${charter.proposedBoundaries.willNotDo.join(' | ')}`,
    '',
    `Approved plan: ${plan.summary}`,
    `Plan steps: ${plan.steps.map((s, i) => `${i + 1}. ${s}`).join(' ')}`,
    `Expected output type: ${plan.expectedOutputType}`,
    '',
    '--- Candidate ---',
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `From: ${candidate.requesterLabel ?? '(unknown)'}`,
    `Title: ${candidate.title}`,
    `Refs: ${candidate.contentRefs.length > 0 ? candidate.contentRefs.join(', ') : '(none)'}`,
    `Body:`,
    candidate.contentSummary,
    '',
    '--- Current mock work environment ---',
    renderEnvSnapshot(mockEnv),
    '',
    '--- Team docs (read-only context) ---',
    renderTeamDocs(mockEnv.teamDocs),
    '',
    'Produce the draft, notes, and actions now.',
  ].join('\n');

  const raw = await agentJson<z.infer<typeof executeSchema>>({
    agent: skillAgent,
    user: userPrompt,
    schema: executeSchema,
  });
  return {
    draft: raw.draft,
    notes: raw.notes,
    actions: raw.actions as MockAction[],
  };
}
