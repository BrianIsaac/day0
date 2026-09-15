import { qualityFit } from './quality-fit';
import {
  AUTONOMOUS_WIP_LIMIT,
  COLD_START_WIP_LIMIT,
  VALUE_THRESHOLD,
  type AgentContext,
  type SkillShape,
  type WorkCandidate,
  type WorkVerdict,
} from './types';
import { verdictFor, type SurfaceLiveness } from '../surfaces/verdict';
import type { SurfaceMode } from '../surfaces/types';
import { surfaceSlug } from '../surfaces/slug';
import {
  candidateNamesSurface,
  skillNameFor,
  skillOperationLabel,
  skillShapeFor,
} from './skill-shape';
import {
  documentedSystemIdentity,
  sameSystemForHostlessMention,
  type SurfaceDiscoveryEvidence,
} from '../docs/system-discovery';

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
 *      candidate reaches skill matching but no registered skill matches, we
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
  /**
   * Returns the registered skill covering the candidate's shape, or null.
   * The shape is the evaluator's, so the name it proposes and the skill it
   * would have matched are the same thing.
   */
  findMatchingSkill: (
    candidate: WorkCandidate,
    charter: AgentContext['charter'],
    shape: SkillShape,
  ) => Promise<{ name: string; description: string } | null>;
}

export interface EvaluateOptions {
  wipLimit?: number;
}

export interface EvaluationSurface extends SurfaceLiveness {
  displayName: string;
  slug: string;
  class: string;
  endpoint?: string;
  discoveryEvidence?: readonly SurfaceDiscoveryEvidence[];
}

export interface EvalContext extends AgentContext {
  autonomousActions: boolean;
  surfaceMode: SurfaceMode;
  surfaces: readonly EvaluationSurface[];
  now?: number;
  /**
   * The manager retried this candidate after the quality-fit filter skipped
   * it, which is their decision that the work is worth doing; the filter is
   * left out and the plan gate still stands.
   */
  qualityFitWaived?: boolean;
}

import { QUALITY_FIT_SKIP_PREFIX } from './types';
export { QUALITY_FIT_SKIP_PREFIX } from './types';

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

/**
 * Whether a candidate is in scope by where it came from.
 *
 * A ticket read from a connected surface that the current documentation or
 * the charter names is work the agent was pointed at; its wording need not
 * echo the charter's. Real mode only: the mock candidates come from seeded
 * tables, not from a surface.
 *
 * Args:
 *   candidate: Work candidate being evaluated.
 *   ctx: Evaluation mode, clock and declared surfaces.
 *
 * Returns:
 *   True when the source surface is connected and currently named.
 */
function eligibleByProvenance(candidate: WorkCandidate, ctx: EvalContext): boolean {
  if (ctx.surfaceMode !== 'real' || candidate.sourceSystem === 'boss') return false;
  const now = ctx.now ?? Date.now();
  const source = surfaceForSource(candidate.sourceSystem, ctx.surfaces, now);
  if (!source || verdictFor(source, now) !== 'connected') return false;
  return source.discoveryEvidence?.some((evidence): boolean => evidence.current) === true;
}

function isEligible(candidate: WorkCandidate, ctx: EvalContext): boolean {
  if (eligibleByProvenance(candidate, ctx)) return true;
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

/** The surface slug convention, shared with the planner. */
export const evaluationSurfaceSlug = surfaceSlug;

function evaluationSurfaceIdentity(surface: EvaluationSurface) {
  return documentedSystemIdentity({
    name: surface.displayName,
    quotes: (surface.discoveryEvidence ?? []).map((evidence) => evidence.quote),
    endpoints: surface.endpoint ? [surface.endpoint] : [],
  });
}

function sameEvaluationSystem(
  left: EvaluationSurface,
  right: EvaluationSurface,
): boolean {
  const leftIdentity = evaluationSurfaceIdentity(left);
  const rightIdentity = evaluationSurfaceIdentity(right);
  return (
    sameSystemForHostlessMention(left.class, leftIdentity, right.class, rightIdentity) ||
    sameSystemForHostlessMention(right.class, rightIdentity, left.class, leftIdentity)
  );
}

function surfaceForSource(
  sourceSystem: string,
  surfaces: readonly EvaluationSurface[],
  now: number,
): EvaluationSurface | undefined {
  const sourceSlug = evaluationSurfaceSlug(sourceSystem);
  const direct = surfaces.find((surface) => surface.slug === sourceSlug);
  if (direct) {
    const aliases = surfaces.filter((surface) => sameEvaluationSystem(direct, surface));
    return aliases.find((surface) => verdictFor(surface, now) === 'connected') ?? direct;
  }

  const mention = documentedSystemIdentity({ name: sourceSystem });
  const aliases = surfaces.filter((surface) =>
    sameSystemForHostlessMention(
      surface.class,
      mention,
      surface.class,
      evaluationSurfaceIdentity(surface),
    ),
  );
  return aliases.length === 1 ? aliases[0] : undefined;
}

/**
 * Resolve the first connection required by a real-mode candidate that is not live.
 *
 * The intake provider itself is required unless the candidate came from the boss.
 * A candidate may also name a second system it expects the agent to operate on,
 * such as a connected ticket asking for work in a documented CRM.
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
  const now = ctx.now ?? Date.now();
  const sourceSurface = surfaceForSource(candidate.sourceSystem, ctx.surfaces, now);
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

  // A disconnected alias is covered by any connected surface that is the same
  // system, named by the item or not: "Update the Looker number" names only the
  // rejected charter alias, and the connected tile still satisfies it.
  const connected = ctx.surfaces.filter(
    (surface: EvaluationSurface): boolean => verdictFor(surface, now) === 'connected',
  );
  return targets.find((surface: EvaluationSurface): boolean => {
    if (verdictFor(surface, now) === 'connected') return false;
    return !connected.some((live) => sameEvaluationSystem(surface, live));
  })?.slug;
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

/**
 * Name and justify the skill a candidate needs.
 *
 * The name is the shape's, so a later candidate of the same shape finds the
 * skill by it. The rationale names the first work item as an instance and
 * quotes nothing from the charter: charter scope is this evaluator's job and
 * must not become an invoke condition inside the skill.
 *
 * Args:
 *   candidate: The work item that needs the skill.
 *   shape: Surface class and operation the candidate resolved to.
 *
 * Returns:
 *   The proposed name and the manager-facing rationale.
 */
function inferSkillRationale(
  candidate: WorkCandidate,
  shape: SkillShape,
): { name: string; rationale: string } {
  const name = skillNameFor(shape);
  const label = skillOperationLabel(shape);
  const rationale = [
    `No registered skill covers ${label} on a ${shape.surfaceClass} surface.`,
    `First needed by "${candidate.title}" from ${candidate.sourceSystem}; the skill is a reusable procedure for every later work item of this shape, taking each run's values from that item and its runbook.`,
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
    return {
      decision: 'skip',
      reason: 'out-of-scope: no charter or current documented-system overlap',
    };
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

  if (!ctx.qualityFitWaived) {
    const fit = await qualityFit({
      candidate,
      agentsMd: ctx.agentsMd,
      role: ctx.charter.proposedFunction,
    });
    if (!fit.pass) {
      return { decision: 'skip', reason: `${QUALITY_FIT_SKIP_PREFIX}${fit.reason}` };
    }
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

  const shape = skillShapeFor(candidate, ctx.surfaces, ctx.surfaceMode);
  const matchingSkill = await lookups.findMatchingSkill(candidate, ctx.charter, shape);
  if (!matchingSkill) {
    const { name, rationale } = inferSkillRationale(candidate, shape);
    return {
      decision: 'needs-skill',
      reason: `no registered skill covers ${skillOperationLabel(shape)} on a ${shape.surfaceClass} surface; agent will propose "${name}"`,
      suggestedSkillName: name,
      suggestedSkillRationale: rationale,
      suggestedSkillShape: shape,
    };
  }

  return { decision: 'claim', value, risk, requiredPermissions };
}
