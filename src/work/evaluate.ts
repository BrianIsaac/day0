import { qualityFit } from './quality-fit';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  VALUE_THRESHOLD,
  type AgentContext,
  type WorkCandidate,
  type WorkVerdict,
} from './types';
import { verdictFor, type SurfaceLiveness } from '../surfaces/verdict';
import type { SurfaceMode } from '../surfaces/types';
import type { SurfaceDiscoveryEvidence } from '../docs/system-discovery';

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
 *      hard-skipping. Capability is meant to grow in place, so an
 *      unmatched candidate is a gap to fill rather than a dead end.
 */

export interface EvaluateLookups {
  /** Returns true if the agent has a live grant for this scope. */
  hasGrantForScope: (scope: string) => Promise<boolean>;
  /** Returns the state of an existing claim or null. */
  findExistingClaim: (
    sourceSystem: string,
    externalId: string,
  ) => Promise<{ state: string } | null>;
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

export interface EvaluationSurface extends SurfaceLiveness {
  displayName: string;
  slug: string;
  discoveryEvidence?: readonly SurfaceDiscoveryEvidence[];
}

export interface EvalContext extends AgentContext {
  autonomousActions: boolean;
  surfaceMode: SurfaceMode;
  surfaces: readonly EvaluationSurface[];
  now?: number;
}

export type EvaluationVerdict =
  | WorkVerdict
  | { decision: 'defer'; reason: 'awaiting-connection'; missingSurface: string };

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

function isEligible(candidate: WorkCandidate, ctx: EvalContext): boolean {
  const bodyTokens = tokenise(`${candidate.title}\n${candidate.contentSummary}`);
  const charterTokens = new Set<string>();
  for (const w of tokenise(ctx.charter.proposedFunction)) charterTokens.add(w);
  for (const clause of ctx.charter.proposedBoundaries.willDo) {
    for (const w of tokenise(clause)) charterTokens.add(w);
  }
  for (const stop of ['will', 'their', 'them', 'with', 'from', 'this', 'that', 'when', 'where']) {
    charterTokens.delete(stop);
  }
  for (const t of charterTokens) {
    if (bodyTokens.has(t)) return true;
  }
  const candidateText = `${candidate.title}\n${candidate.contentSummary}`;
  return ctx.surfaces.some((surface): boolean => {
    const currentlyNamed = surface.discoveryEvidence?.some((evidence): boolean => evidence.current);
    if (!currentlyNamed) return false;
    return candidateNamesSurface(candidateText, surface);
  });
}

/**
 * Convert a provider or candidate label to the surface slug convention.
 *
 * Args:
 *   value: Provider or candidate label.
 *
 * Returns:
 *   A lowercase URL-safe surface slug.
 */
export function evaluationSurfaceSlug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'system'
  );
}

/**
 * Normalise prose for whole-phrase surface matching.
 *
 * Args:
 *   value: Candidate prose or a surface label.
 *
 * Returns:
 *   Lowercase alphanumeric words separated by one space.
 */
function comparableSurfaceText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Check whether candidate prose names a declared surface as a whole phrase.
 *
 * Args:
 *   text: Candidate title and summary.
 *   surface: Declared surface metadata.
 *
 * Returns:
 *   True when the display name or slug is present as a complete phrase.
 */
function candidateNamesSurface(text: string, surface: EvaluationSurface): boolean {
  const haystack = ` ${comparableSurfaceText(text)} `;
  const names = [surface.displayName, surface.slug].map(comparableSurfaceText).filter(Boolean);
  return names.some((name: string): boolean => haystack.includes(` ${name} `));
}

/**
 * Resolve the first connection required by a real-mode candidate that is not live.
 *
 * The intake provider itself is required unless the candidate came from the boss.
 * A candidate may also name a second system it expects the agent to operate on,
 * such as a connected Linear issue asking for Northstar CRM work.
 *
 * Args:
 *   candidate: Work candidate being evaluated.
 *   ctx: Evaluation mode and declared surfaces.
 *
 * Returns:
 *   Missing or non-live surface slug, or undefined when every target is connected.
 */
export function missingConnectionSurface(
  candidate: WorkCandidate,
  ctx: Pick<EvalContext, 'surfaceMode' | 'surfaces' | 'now'>,
): string | undefined {
  if (ctx.surfaceMode === 'mock') return undefined;

  const sourceSlug = evaluationSurfaceSlug(candidate.sourceSystem);
  const sourceSurface = ctx.surfaces.find(
    (surface: EvaluationSurface): boolean => surface.slug === sourceSlug,
  );
  const targets: EvaluationSurface[] = [];
  if (candidate.sourceSystem !== 'boss') {
    if (!sourceSurface) return sourceSlug;
    targets.push(sourceSurface);
  }

  const candidateText = `${candidate.title}\n${candidate.contentSummary}`;
  for (const surface of ctx.surfaces) {
    if (targets.some((target: EvaluationSurface): boolean => target.slug === surface.slug))
      continue;
    if (candidateNamesSurface(candidateText, surface)) targets.push(surface);
  }

  const now = ctx.now ?? Date.now();
  return targets.find(
    (surface: EvaluationSurface): boolean => verdictFor(surface, now) !== 'connected',
  )?.slug;
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
  const verb =
    candidate.sourceSystem === 'spreadsheet'
      ? 'update-spreadsheet'
      : candidate.sourceSystem === 'ticket'
        ? 'update-ticket'
        : `${candidate.sourceSystem}-action`;
  const name = `${verb}-${candidate.externalId.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`.slice(
    0,
    60,
  );
  const rationale = [
    `Charter places me on ${charter.proposedFunction.replace(/\.\s*$/, '')}.`,
    `This candidate ("${candidate.title}") needs me to operate on ${candidate.sourceSystem} but I don't have a registered skill for it.`,
    `Proposing a new skill so I can complete this and similar work going forward.`,
  ].join(' ');
  return { name, rationale };
}

export async function evaluateCandidate(
  candidate: WorkCandidate,
  ctx: EvalContext,
  lookups: EvaluateLookups,
  opts: EvaluateOptions = {},
): Promise<EvaluationVerdict> {
  if (!isEligible(candidate, ctx)) {
    return { decision: 'skip', reason: 'out-of-scope: no charter overlap' };
  }

  const missingSurface = missingConnectionSurface(candidate, ctx);
  if (missingSurface) {
    return { decision: 'defer', reason: 'awaiting-connection', missingSurface };
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

  const wipCap =
    opts.wipLimit ?? (ctx.autonomousActions ? AUTONOMOUS_WIP_LIMIT : COLD_START_WIP_LIMIT);
  const open = await lookups.countOpenClaims();
  if (open >= wipCap) {
    const posture = ctx.autonomousActions ? 'autonomous concurrency' : 'supervised cold-start';
    return {
      decision: 'queue',
      reason: `WIP cap reached: ${posture} limit is ${wipCap}`,
      openClaims: open,
    };
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
