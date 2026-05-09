import { qualityFit } from './quality-fit';
import {
  COLD_START_WIP_LIMIT,
  VALUE_THRESHOLD,
  type AgentContext,
  type WorkCandidate,
  type WorkVerdict,
} from './types';

/**
 * Layer-2 evaluator. Lifted from Protean's `src/work/evaluate.ts`.
 * Same seven-criterion sequence — eligibility, permission, ownership,
 * quality fit, value, risk (informational), capacity. The two
 * differences for Day0:
 *
 *   1. The DB lookups (permission grants, existing claims, open-claim
 *      count) are passed in as `Lookups` callbacks instead of imported
 *      from a global store. The Convex action wires them.
 *
 *   2. There's a new terminal verdict — `needs-skill`. When the
 *      candidate is in scope but no registered skill matches, we
 *      surface this as a propose-new-skill flow rather than
 *      hard-skipping. This is the headline demo path for the
 *      hackathon.
 */

const WIP_REASON_AT_CAP = 'WIP cap reached for cold-start posture';

export interface EvaluateLookups {
  /** Returns true if the agent has a live grant for this scope. */
  hasGrantForScope: (scope: string) => Promise<boolean>;
  /** Returns the state of an existing claim or null. */
  findExistingClaim: (sourceSystem: string, externalId: string) => Promise<{ state: string } | null>;
  /** Returns the count of open claims for the agent. */
  countOpenClaims: () => Promise<number>;
  /** Returns the matching registered skill or null. */
  findMatchingSkill: (
    candidate: WorkCandidate,
    charter: AgentContext['charter'],
  ) => Promise<{ name: string; description: string } | null>;
}

export interface EvaluateOptions {
  wipLimit?: number;
}

export function inferRequiredPermissions(candidate: WorkCandidate): string[] {
  const required = new Set<string>();
  // Day0 always needs to be able to message the boss.
  required.add('boss:message');
  if (candidate.sourceSystem !== 'boss') {
    required.add(`${candidate.sourceSystem}:read`);
  }
  return [...required];
}

function tokenise(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text
    .toLowerCase()
    .split(/\W+/)
    .filter((s) => s.length >= 4)) {
    out.add(w);
  }
  return out;
}

function isEligible(candidate: WorkCandidate, charter: AgentContext['charter']): boolean {
  const bodyTokens = tokenise(`${candidate.title}\n${candidate.contentSummary}`);
  const charterTokens = new Set<string>();
  for (const w of tokenise(charter.proposedFunction)) charterTokens.add(w);
  for (const clause of charter.proposedBoundaries.willDo) {
    for (const w of tokenise(clause)) charterTokens.add(w);
  }
  for (const stop of ['will', 'their', 'them', 'with', 'from', 'this', 'that', 'when', 'where']) {
    charterTokens.delete(stop);
  }
  for (const t of charterTokens) {
    if (bodyTokens.has(t)) return true;
  }
  return false;
}

export function scoreValue(candidate: WorkCandidate): number {
  let score = 50;
  const lower = (candidate.priority ?? '').toLowerCase();
  if (lower.includes('p0') || lower.includes('urgent') || lower.includes('production-down')) {
    score += 30;
  } else if (lower.includes('p1') || lower.includes('high')) {
    score += 20;
  } else if (lower.includes('p2') || lower.includes('medium')) {
    score += 10;
  }
  const ageMinutes = (Date.now() - candidate.observedAt.getTime()) / 60_000;
  if (ageMinutes < 60) score += 10;
  if (candidate.title.length < 8) score -= 20;
  return Math.max(0, Math.min(100, score));
}

export function scoreRisk(candidate: WorkCandidate): number {
  let score = 30;
  const body = candidate.contentSummary.toLowerCase();
  if (/\b(delete|drop|destroy|remove|wipe|truncate)\b/.test(body)) score += 30;
  if (/\b(push|deploy|release|publish|merge)\b/.test(body)) score += 20;
  if (candidate.sourceCategory === 'event-stream') score += 10;
  return Math.max(0, Math.min(100, score));
}

function inferSkillRationale(
  candidate: WorkCandidate,
  charter: AgentContext['charter'],
): { name: string; rationale: string } {
  const verb = candidate.sourceSystem === 'spreadsheet'
    ? 'update-spreadsheet'
    : candidate.sourceSystem === 'ticket'
      ? 'update-ticket'
      : `${candidate.sourceSystem}-action`;
  const name = `${verb}-${candidate.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(0, 60);
  const rationale = [
    `Charter places me on ${charter.proposedFunction}.`,
    `This candidate ("${candidate.title}") needs me to operate on ${candidate.sourceSystem} but I don't have a registered skill for it.`,
    `Proposing a new skill so I can complete this and similar work going forward.`,
  ].join(' ');
  return { name, rationale };
}

export async function evaluateCandidate(
  candidate: WorkCandidate,
  ctx: AgentContext,
  lookups: EvaluateLookups,
  opts: EvaluateOptions = {},
): Promise<WorkVerdict> {
  if (!isEligible(candidate, ctx.charter)) {
    return { decision: 'skip', reason: 'out-of-scope: no charter overlap' };
  }

  const requiredPermissions = inferRequiredPermissions(candidate);
  const missing: string[] = [];
  for (const scope of requiredPermissions) {
    const ok = await lookups.hasGrantForScope(scope);
    if (!ok) missing.push(scope);
  }
  if (missing.length > 0) {
    return { decision: 'defer', reason: 'awaiting-permission', missingPermissions: missing };
  }

  const existing = await lookups.findExistingClaim(candidate.sourceSystem, candidate.externalId);
  if (existing) {
    return { decision: 'skip', reason: `already-claimed: state=${existing.state}` };
  }

  const fit = await qualityFit({
    candidate,
    agentsMd: ctx.agentsMd,
    role: ctx.charter.proposedFunction,
  });
  if (!fit.pass) {
    return { decision: 'skip', reason: `quality-fit-fail: ${fit.reason}` };
  }

  const value = scoreValue(candidate);
  if (value < VALUE_THRESHOLD) {
    return { decision: 'skip', reason: `low-value: ${value}` };
  }

  const risk = scoreRisk(candidate);

  const wipCap = opts.wipLimit ?? COLD_START_WIP_LIMIT;
  const open = await lookups.countOpenClaims();
  if (open >= wipCap) {
    return { decision: 'queue', reason: WIP_REASON_AT_CAP, openClaims: open };
  }

  const matchingSkill = await lookups.findMatchingSkill(candidate, ctx.charter);
  if (!matchingSkill) {
    const { name, rationale } = inferSkillRationale(candidate, ctx.charter);
    return {
      decision: 'needs-skill',
      reason: `in-scope but no registered skill matches; agent will propose "${name}"`,
      suggestedSkillName: name,
      suggestedSkillRationale: rationale,
    };
  }

  return { decision: 'claim', value, risk, requiredPermissions };
}
