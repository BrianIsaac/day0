import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';

/**
 * Charter domain type + synthesis. Lifted from Protean's
 * `src/agent/charter.ts` and adapted to a Mastra Agent over the
 * configured model, with structured output.
 *
 * Only v0.0 is produced: the manager 1:1 is the sole evidence source
 * Day0 has. `CharterVersion` still names v0.1 (collaborator 1:1s) and
 * v0.2 (an observation layer), because the renderer and the persisted
 * rows are versioned for them — neither is implemented.
 */

export type CharterVersion = '0.0' | '0.1' | '0.2' | (string & { readonly _v?: 'charter' });

export type IntroPath = 'manager' | 'self' | 'tbd';

export interface EvidenceItem {
  text: string;
  source: string;
}

export interface NamedCollaborator {
  name: string;
  topic: string;
  introPath: IntroPath;
}

export interface ApprovalChain {
  boss: string;
  confidence: 'low' | 'medium' | 'high';
}

export interface AdjacentRole {
  who: string;
  staysOutOfTheirLaneBy: string;
}

export interface ProposedBoundaries {
  willDo: string[];
  willNotDo: string[];
  escalationTriggers: string[];
}

export interface ShortTermGoals {
  day30: string;
  day60: string;
  day90: string;
}

export const SYSTEM_CLASSES = [
  'kanban',
  'chat',
  'docs',
  'spreadsheet',
  'crm',
  'analytics',
  'social',
  'other',
] as const;

export interface NamedSystem {
  name: string;
  class: (typeof SYSTEM_CLASSES)[number];
  whereMentioned: string;
}

export interface Charter {
  version: CharterVersion;
  source: string;
  whyThisHire: string;
  proposedFunction: string;
  evidence: EvidenceItem[];
  shortTermGoals: ShortTermGoals;
  proposedBoundaries: ProposedBoundaries;
  namedCollaborators: NamedCollaborator[];
  namedSystems: NamedSystem[];
  priorityReading: string[];
  adjacentRoles: AdjacentRole[];
  approvalChain: ApprovalChain;
  openQuestions: string[];
  createdAt: string;
}

export const DAY_ONE_TOPICS = [
  'why-this-hire',
  'role-and-goals',
  'collaborators',
  'reading',
  'tools',
  'immediate',
  'open-questions',
] as const;

export type DayOneTopic = (typeof DAY_ONE_TOPICS)[number];

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0, drafting your own role charter from a Day-1 manager 1:1.',
  'You captured seven free-form answers from the manager. Distil them into a structured charter the manager can approve in under 10 minutes of cognitive load.',
  '',
  'Provenance discipline: every evidence clause carries source "from manager 1:1 day-1" because v0.0 has no other source.',
  'Conservative defaults: in proposedBoundaries.willDo, prefer concrete narrow actions; in willNotDo, list adjacent roles you must NOT step on.',
  'If the manager left a topic vague (e.g. "figure it out"), capture it under openQuestions instead of inventing a goal.',
  'List every product or service the manager names as a place where work is tracked or asks arrive, with the sentence they said it in.',
  'Return exactly one namedSystems row per product or service. Channels, DMs, pages, files, runbooks, queues, dashboards, tiles, views, sheets and tabs are locations inside a system, never separate systems.',
  'Merge aliases and duplicates: Slack is one row for every Slack channel and DM; a Looker pipeline tile is one Looker row; reading artefacts belong only in priorityReading.',
].join('\n');

const charterAgent = makeAgent('day0-charter', SYSTEM_PROMPT);

export const charterSchema = z.object({
  whyThisHire: z.string(),
  proposedFunction: z.string(),
  evidence: z.array(
    z.object({
      text: z.string(),
      source: z.string(),
    }),
  ),
  shortTermGoals: z.object({
    day30: z.string(),
    day60: z.string(),
    day90: z.string(),
  }),
  proposedBoundaries: z.object({
    willDo: z.array(z.string()),
    willNotDo: z.array(z.string()),
    escalationTriggers: z.array(z.string()),
  }),
  namedCollaborators: z.array(
    z.object({
      name: z.string(),
      topic: z.string(),
      introPath: z.enum(['manager', 'self', 'tbd']),
    }),
  ),
  namedSystems: z.array(
    z.object({
      name: z.string(),
      class: z.enum(SYSTEM_CLASSES),
      whereMentioned: z.string(),
    }),
  ),
  priorityReading: z.array(z.string()),
  adjacentRoles: z.array(
    z.object({
      who: z.string(),
      staysOutOfTheirLaneBy: z.string(),
    }),
  ),
  approvalChain: z.object({
    boss: z.string(),
    confidence: z.enum(['low', 'medium', 'high']),
  }),
  openQuestions: z.array(z.string()),
});

type RawCharterPayload = z.infer<typeof charterSchema>;

export interface SynthesiseCharterArgs {
  answers: Record<DayOneTopic, string>;
  version: CharterVersion;
  bossLabel: string;
  createdAt?: Date;
}

function userPrompt(answers: Record<DayOneTopic, string>): string {
  return DAY_ONE_TOPICS.map(
    (t) => `[${t}]\n${(answers[t] ?? '').trim() || '(no reply yet)'}\n`,
  ).join('\n');
}

function ensureProvenance(items: EvidenceItem[]): EvidenceItem[] {
  return items.map((e) => ({
    text: e.text,
    source: e.source && e.source.trim().length > 0 ? e.source : 'from manager 1:1 day-1',
  }));
}

const DOCUMENT_LOCATION = /\b(?:page|runbook|folder|file|queue|documentation|handbook)\b/i;
const CHANNEL_LOCATION = /(?:^|\s)(?:#[a-z0-9_-]+|dm\b|direct message\b|channel\b)/i;
const UI_LOCATION = /\b(?:tile|dashboard|view)\b/i;

/**
 * Canonicalise a model-produced system name without maintaining a provider catalogue.
 *
 * Args:
 *   system: Raw system row from charter synthesis.
 *
 * Returns:
 *   The parent product name, or undefined when the row names only a document location.
 */
function canonicalSystemName(system: NamedSystem): string | undefined {
  const name = system.name.trim().replace(/\s+/g, ' ');
  if (!name) return undefined;
  if (DOCUMENT_LOCATION.test(name)) return undefined;
  const withoutChannel = name
    .replace(/\s+#.*$/i, '')
    .replace(/\s+(?:dm|direct message|channel)\b.*$/i, '')
    .trim();
  if (
    withoutChannel &&
    withoutChannel !== name &&
    !/^(?:manager|boss|team|public|private)$/i.test(withoutChannel)
  ) {
    return withoutChannel;
  }
  if (CHANNEL_LOCATION.test(name)) return undefined;
  if (UI_LOCATION.test(name)) {
    const prefix = name
      .split(/\s+/)
      .slice(0, -1)
      .filter((token: string, index: number): boolean => index === 0 || /^[A-Z0-9]/.test(token))
      .join(' ')
      .trim();
    return prefix || undefined;
  }
  return name;
}

const DOMAIN_SUFFIX = /\.(?:app|com|io|dev|ai|co|net|org)$/i;

/**
 * Split a product name into comparable words, ignoring a domain suffix.
 *
 * Args:
 *   name: Canonical product name.
 *
 * Returns:
 *   Lowercase alphanumeric words, so "Linear.app" and "Linear" compare equal.
 */
function productWords(name: string): string[] {
  return name
    .toLowerCase()
    .replace(DOMAIN_SUFFIX, '')
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Decide whether one name's words open the other's.
 *
 * "Northstar" opens "Northstar CRM" and "Slack" opens "Slack workspace";
 * "Microsoft Teams" and "Microsoft Excel" open neither.
 *
 * Args:
 *   left: Words of one name.
 *   right: Words of the other.
 *
 * Returns:
 *   True when the shorter list is a leading run of the longer one.
 */
function oneOpensTheOther(left: readonly string[], right: readonly string[]): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
  return (
    shorter.length > 0 &&
    shorter.every((word: string, index: number): boolean => longer[index] === word)
  );
}

interface ProductRow {
  words: string[];
  system: NamedSystem;
}

/**
 * Collapse channels, DMs, documentation artefacts, UI objects and spellings to products.
 *
 * Two rows are the same product when their words match, when one name opens
 * the other ("Northstar" and "Northstar CRM"), or when they differ only by a
 * domain suffix ("Linear.app" and "Linear"). A prefix merge is limited to rows
 * of the same class, or a row of class `other`, so "Google Sheets" does not
 * swallow "Google Docs". The shorter name is kept, because every page that
 * names the longer one also names it, and its whole-word match stays exact.
 *
 * Args:
 *   systems: Raw rows returned by charter synthesis.
 *
 * Returns:
 *   One row per product in first-mentioned order with distinct evidence merged.
 */
export function normaliseNamedSystems(systems: readonly NamedSystem[]): NamedSystem[] {
  const canonicalRows = systems.flatMap(
    (system: NamedSystem): Array<{ system: NamedSystem; name: string }> => {
      const name = canonicalSystemName(system);
      return name ? [{ system, name }] : [];
    },
  );
  const rows: ProductRow[] = [];
  for (const system of systems) {
    let name = canonicalSystemName(system);
    if (!name && CHANNEL_LOCATION.test(system.name)) {
      name = canonicalRows.find(
        (row): boolean =>
          row.system.class === system.class &&
          new RegExp(`\\b${row.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(
            system.whereMentioned,
          ),
      )?.name;
    }
    if (!name) continue;
    const words = productWords(name);
    const existing = rows.find((row: ProductRow): boolean => {
      if (row.words.join(' ') === words.join(' ')) return true;
      const compatible =
        row.system.class === system.class ||
        row.system.class === 'other' ||
        system.class === 'other';
      return compatible && oneOpensTheOther(row.words, words);
    });
    if (!existing) {
      rows.push({ words, system: { ...system, name } });
      continue;
    }
    const shorter =
      words.length < existing.words.length ||
      (words.length === existing.words.length && name.length < existing.system.name.length);
    if (shorter) {
      existing.words = words;
      existing.system.name = name;
    }
    if (existing.system.class === 'other' && system.class !== 'other') {
      existing.system.class = system.class;
    }
    if (!existing.system.whereMentioned.includes(system.whereMentioned)) {
      existing.system.whereMentioned = `${existing.system.whereMentioned}\n${system.whereMentioned}`;
    }
  }
  return rows.map((row: ProductRow): NamedSystem => row.system);
}

function assemble(raw: RawCharterPayload, args: SynthesiseCharterArgs, createdAt: string): Charter {
  return {
    version: args.version,
    source: 'day-1 manager 1:1',
    whyThisHire: raw.whyThisHire,
    proposedFunction: raw.proposedFunction,
    evidence: ensureProvenance(raw.evidence),
    shortTermGoals: raw.shortTermGoals,
    proposedBoundaries: raw.proposedBoundaries,
    namedCollaborators: raw.namedCollaborators,
    namedSystems: normaliseNamedSystems(raw.namedSystems),
    priorityReading: raw.priorityReading,
    adjacentRoles: raw.adjacentRoles,
    approvalChain: {
      boss: raw.approvalChain.boss || args.bossLabel,
      confidence: raw.approvalChain.confidence,
    },
    openQuestions: raw.openQuestions,
    createdAt,
  };
}

/**
 * How many consecutive words a clause has to share with something the agent said
 * before that is read as a copy rather than a coincidence. Six words of ordinary
 * English do not line up by chance; a manager and an agent agreeing on "the
 * support handbook" (three) routinely do.
 */
const AGENT_QUOTE_RUN = 6;

function words(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function runsOf(text: string): string[] {
  const w = words(text);
  const runs: string[] = [];
  for (let i = 0; i + AGENT_QUOTE_RUN <= w.length; i++) {
    runs.push(w.slice(i, i + AGENT_QUOTE_RUN).join(' '));
  }
  return runs;
}

/** Both halves of the conversation, told apart before either was read. */
export interface TranscriptSides {
  agent: string[];
  manager: string[];
}

/**
 * Drop every evidence clause that quotes the agent rather than the manager.
 *
 * Evidence is the charter's claim to be grounded in what the boss said, and each
 * clause is stamped `from manager 1:1 day-1`. A clause carrying the agent's own
 * words is therefore false on its face — it is the agent citing itself as the
 * source for what the boss wants — and no model has to be consulted to notice,
 * because both halves of the transcript are in hand.
 *
 * A run of words the agent said *and the manager also said* proves nothing: an
 * agent that reads an answer back, which this one is told not to do but may,
 * would otherwise have the boss's own sentence deleted from their charter as a
 * forgery. Only what the agent said and the manager never did is disqualifying.
 *
 * Dropped rather than merely flagged: a false clause left in the body is still
 * read by the boss, quoted into IDENTITY.md and carried into every downstream
 * prompt. Dropped rather than fatal: the rest of the charter came from the
 * manager's answers and refusing to produce one would leave a finished 1:1 with
 * nothing to show for it — and the retry would spend two more model calls to
 * arrive at the same place. So the clause goes, and an open question says it
 * went, because a charter that quietly lost its evidence is the same silent
 * failure in a smaller size.
 */
export function withoutAgentQuotedEvidence(
  charter: Charter,
  turns: TranscriptSides,
): { charter: Charter; rejected: EvidenceItem[] } {
  if (turns.agent.length === 0) return { charter, rejected: [] };
  const managerRuns = new Set(turns.manager.flatMap(runsOf));
  const agentRuns = new Set(turns.agent.flatMap(runsOf).filter((r) => !managerRuns.has(r)));
  if (agentRuns.size === 0) return { charter, rejected: [] };

  const rejected = charter.evidence.filter((e) => runsOf(e.text).some((r) => agentRuns.has(r)));
  if (rejected.length === 0) return { charter, rejected };

  const kept = charter.evidence.filter((e) => !rejected.includes(e));
  return {
    charter: {
      ...charter,
      evidence: kept,
      openQuestions: [
        ...charter.openQuestions,
        `Evidence check: ${rejected.length} ${
          rejected.length === 1 ? 'clause' : 'clauses'
        } in this draft quoted my own words back as if they were yours, so I dropped ${
          rejected.length === 1 ? 'it' : 'them'
        }. Which of this is actually what you told me?`,
      ],
    },
    rejected,
  };
}

export async function synthesiseCharter(args: SynthesiseCharterArgs): Promise<Charter> {
  const createdAt = (args.createdAt ?? new Date()).toISOString();
  const raw = await agentJson<RawCharterPayload>({
    agent: charterAgent,
    user: userPrompt(args.answers),
    schema: charterSchema,
  });
  return assemble(raw, args, createdAt);
}

export function renderCharter(c: Charter, date = new Date()): string {
  const isoDate = date.toISOString().slice(0, 10);
  const lines: string[] = [
    `DRAFT CHARTER — Day0 v${c.version} — ${isoDate}`,
    `SOURCE: ${c.source}`,
    '',
    'WHY THIS HIRE                                              [from manager 1:1]',
    `  ${c.whyThisHire}`,
    '',
    'PROPOSED FUNCTION                                          [from manager 1:1, refined]',
    `  ${c.proposedFunction}`,
    '',
    'EVIDENCE',
    ...renderEvidence(c.evidence),
    '',
    'SHORT-TERM GOALS                                           [from manager 1:1]',
    `  - 30-day: ${c.shortTermGoals.day30}`,
    `  - 60-day: ${c.shortTermGoals.day60}`,
    `  - 90-day: ${c.shortTermGoals.day90}`,
    '',
    'PROPOSED BOUNDARIES',
    `  - What I will do:`,
    ...renderBullets(c.proposedBoundaries.willDo, '    '),
    `  - What I will NOT do:`,
    ...renderBullets(c.proposedBoundaries.willNotDo, '    '),
    `  - Escalation triggers:`,
    ...renderBullets(c.proposedBoundaries.escalationTriggers, '    '),
    '',
    'NAMED COLLABORATORS                                        [from manager 1:1]',
    ...renderCollaborators(c.namedCollaborators),
    '',
    'NAMED SYSTEMS                                              [from manager 1:1]',
    ...(c.namedSystems ?? []).map(
      (system) => `  - ${system.name} (${system.class}) - ${system.whereMentioned}`,
    ),
    '',
    'PRIORITY READING                                           [from manager 1:1]',
    ...renderBullets(c.priorityReading, '  '),
    '',
    'ADJACENT ROLES I AM AWARE OF',
    ...renderAdjacents(c.adjacentRoles),
    '',
    'APPROVAL CHAIN',
    `  - Boss: ${c.approvalChain.boss}`,
    `  - Confidence: ${c.approvalChain.confidence}`,
    '',
    'OPEN QUESTIONS — to follow up',
    ...renderBullets(c.openQuestions, '  '),
    '',
  ];
  return lines.join('\n');
}

function renderBullets(values: string[], indent: string): string[] {
  if (values.length === 0) return [`${indent}- (none)`];
  return values.map((v) => `${indent}- ${v}`);
}

function renderEvidence(items: EvidenceItem[]): string[] {
  if (items.length === 0) return ['  - (none yet)'];
  return items.map((e) => `  - ${e.text} [${e.source}]`);
}

function renderCollaborators(items: NamedCollaborator[]): string[] {
  if (items.length === 0) return ['  - (none yet)'];
  return items.map((n) => `  - ${n.name} — ${n.topic} — intro path: ${n.introPath}`);
}

function renderAdjacents(items: AdjacentRole[]): string[] {
  if (items.length === 0) return ['  - (none flagged yet)'];
  return items.map((a) => `  - ${a.who} — ${a.staysOutOfTheirLaneBy}`);
}

export function extractRole(c: Charter): string {
  return (c.proposedFunction || c.whyThisHire || 'autonomous agent').trim();
}

export function identityFromCharter(c: Charter): string {
  const lines = [
    '# IDENTITY',
    '',
    `Role: ${c.proposedFunction}`,
    '',
    `Why this hire: ${c.whyThisHire}`,
    '',
    '## Short-term goals (manager-defined)',
    `- 30-day: ${c.shortTermGoals.day30}`,
    `- 60-day: ${c.shortTermGoals.day60}`,
    `- 90-day: ${c.shortTermGoals.day90}`,
    '',
    '## Boundaries — what I will do',
    ...renderBullets(c.proposedBoundaries.willDo, ''),
    '',
    '## Boundaries — what I will NOT do',
    ...renderBullets(c.proposedBoundaries.willNotDo, ''),
    '',
    '## Escalation triggers',
    ...renderBullets(c.proposedBoundaries.escalationTriggers, ''),
    '',
    '## Key relationships',
    ...c.namedCollaborators.map((n) => `- ${n.name} — ${n.topic} (intro path: ${n.introPath})`),
    '',
  ];
  return lines.join('\n');
}

export function toolsFromCharter(c: Charter): string {
  const reading =
    c.priorityReading.length > 0 ? c.priorityReading : ['(manager pointed nothing yet)'];
  const lines = [
    '# TOOLS',
    '',
    '## Priority reading (manager-pointed)',
    ...reading.map((r) => `- ${r}`),
    '',
    '## Known surfaces (open questions until the team names them)',
    ...(c.namedSystems ?? []).map(
      (system) => `- ${system.name} (${system.class}) - ${system.whereMentioned}`,
    ),
    ...c.openQuestions
      .filter((q) => /tool|stack|tracker|surface|dashboard|wiki|spreadsheet/i.test(q))
      .map((q) => `- ${q}`),
    '',
  ];
  return lines.join('\n');
}
