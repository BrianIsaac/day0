import { z } from 'zod';
import { agentJson, makeAgent } from '../lib/mastra';
import type { WorkCandidate } from './types';

/**
 * Layer-2 quality-fit check. Lifted from Protean's
 * `src/work/quality-fit.ts` and adapted to Mastra Agent + GPT-5.5
 * with structured output.
 *
 * Heuristic short-circuit: if AGENTS.md has no `## Good-habits memory`
 * section yet, returns `pass: true` without a model call. Cold-start
 * posture relies on the boss approval gate at Layer 3 to catch
 * mis-claims; refusing here would starve the agent of work before
 * good-habits research lands.
 */

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0.',
  'You are deciding whether to claim a piece of incoming work.',
  'You have a `Good-habits memory` block that captures the role norms a competent practitioner follows — habits, anti-patterns, and discipline.',
  'A user has posted, mentioned you, or filed a ticket. Decide: does this candidate look like work the role would invest time in, vs low-value-but-discoverable busywork that violates the role norms?',
  '',
  'Discipline:',
  '  - Bias toward `pass: true` when the candidate is clearly in the role and reasonable. Layer 3 still requires boss approval before execution.',
  '  - `pass: false` is for clear violations (e.g. concierge for a tangential ask, low-value formatting work when the role norm is variance commentary).',
].join('\n');

const qualityFitAgent = makeAgent('day0-quality-fit', SYSTEM_PROMPT);

const qualityFitSchema = z.object({
  pass: z.boolean(),
  reason: z.string(),
});

export interface QualityFitArgs {
  candidate: WorkCandidate;
  agentsMd: string;
  role: string;
}

export interface QualityFitResult {
  pass: boolean;
  reason: string;
}

export async function qualityFit(args: QualityFitArgs): Promise<QualityFitResult> {
  if (!/## Good-habits memory/i.test(args.agentsMd)) {
    return { pass: true, reason: 'no good-habits memory yet — defer slop filtering to Layer 3' };
  }

  const userPrompt = [
    `Role: ${args.role}`,
    '',
    '--- AGENTS.md (good-habits memory) ---',
    args.agentsMd,
    '',
    '--- Candidate ---',
    `From: ${args.candidate.requesterLabel ?? '(unknown)'}`,
    `Source: ${args.candidate.sourceSystem} / ${args.candidate.sourceCategory}`,
    `Title: ${args.candidate.title}`,
    `Body:`,
    args.candidate.contentSummary,
    '',
    'Decide whether to claim. Reference one specific role norm where possible.',
  ].join('\n');

  return await agentJson({
    agent: qualityFitAgent,
    user: userPrompt,
    schema: qualityFitSchema,
  });
}
