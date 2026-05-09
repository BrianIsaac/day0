import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';

/**
 * Charter domain type + synthesis. Lifted from Protean's
 * `src/agent/charter.ts` and adapted to Mastra Agent + GPT-5.5 with
 * structured output.
 *
 * Day0 stays at v0.0 for the hackathon — the v0.1 (collaborator 1:1s)
 * and v0.2 (observation layer) versions are out of scope.
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

export interface Charter {
  version: CharterVersion;
  source: string;
  whyThisHire: string;
  proposedFunction: string;
  evidence: EvidenceItem[];
  shortTermGoals: ShortTermGoals;
  proposedBoundaries: ProposedBoundaries;
  namedCollaborators: NamedCollaborator[];
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
].join('\n');

const charterAgent = makeAgent('day0-charter', SYSTEM_PROMPT);

const charterSchema = z.object({
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
    ...c.openQuestions
      .filter((q) => /tool|stack|tracker|surface|dashboard|wiki|spreadsheet/i.test(q))
      .map((q) => `- ${q}`),
    '',
  ];
  return lines.join('\n');
}
