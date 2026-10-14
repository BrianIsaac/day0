/**
 * What a reorientation card's Approve moved, and whether a plan the card held rests on it (wave 18,
 * 18-O; the review's D-2 (b), taken 14 October; O-1 (a)). One Approve of an edge for everyone at
 * fifty-one employees sent every held plan back to drafting (W17-R32); a plan is drafted again only
 * where its cites, the people it names or its own words reach what moved, the narrow test the
 * conflict question applies to a plan's cites and words (`src/work/plan-cites.ts`,
 * `src/work/conflict-hold.ts`). The rest are asked their decision again, which goes to the manager
 * whatever the autonomy switch says (RM43 (a)). Where the test cannot tell (a plan with no words,
 * a change it does not read, a plan that declares no reads and writes beside an access), the plan
 * is drafted again: a redraft costs a model call, a plan asked again under the wrong ground costs
 * the manager a decision on what no longer holds. Pure.
 */

import { contentWords } from './manager-questions';
import { planObligations } from '../work/obligations';
import type { ExecutionPlan } from '../work/types';

/** One thing an Approve changed that a plan may have been drafted under. */
export type MovedGround =
  /** An edge: its person, by name, and its scope before and after (an empty scope says nothing). */
  | { readonly kind: 'edge'; readonly person: string; readonly scopes: string[] }
  /** Clauses of the charter or of a working agreement, each before and after. */
  | { readonly kind: 'clauses'; readonly texts: string[] }
  /** A page's status. */
  | {
      readonly kind: 'page';
      readonly sourceId: string;
      readonly ref: string;
      readonly title: string;
    }
  /** An access granted or revoked, by the system it is for. */
  | { readonly kind: 'access'; readonly system: string }
  /** A skill retired or withdrawn. */
  | { readonly kind: 'skill'; readonly skillId: string; readonly name: string }
  /** A change the narrow test does not read (a charter's function, its systems, its people). */
  | { readonly kind: 'everything' };

/** A held row as the narrow test reads it: its plan as stored, the skill it runs, its system. */
export interface HeldPlanRow {
  readonly plan?: unknown;
  readonly skillId?: string;
  readonly sourceSystem?: string;
}

/** A stored plan's words and cites, as far as the test reads them. */
type PlanParts = Partial<Pick<ExecutionPlan, 'summary' | 'steps' | 'riskNotes' | 'obligations'>> & {
  readonly cites?: ReadonlyArray<{ readonly sourceId?: string; readonly pageRef?: string }>;
};

/** The plan's own content words: its summary, its steps and its risk notes. */
function planWords(plan: PlanParts): Set<string> {
  const steps = Array.isArray(plan.steps)
    ? plan.steps.filter((step) => typeof step === 'string')
    : [];
  return new Set(contentWords([plan.summary ?? '', ...steps, plan.riskNotes ?? ''].join(' ')));
}

/** The phrases a scope is made of: "journal changes and REVOPS close plans" is two. */
function scopePhrases(scope: string): string[][] {
  return scope
    .split(/[,;]|\band\b|\bor\b/iu)
    .map(contentWords)
    .filter((words) => words.length > 0);
}

/**
 * Whether a plan's words reach a clause: at least half of the clause's content words, and two of
 * them where it has two or more. A clause is a sentence, and a plan says what it does rather than
 * repeating its rules, so every word is too much to ask and one shared word too little.
 */
function reachesClause(words: ReadonlySet<string>, clause: string): boolean {
  const said = contentWords(clause);
  if (said.length === 0) return false;
  const shared = said.filter((word) => words.has(word)).length;
  return shared >= Math.max(Math.min(2, said.length), Math.ceil(said.length / 2));
}

/** Whether every word of a phrase is among the plan's words. */
function names(words: ReadonlySet<string>, phrase: readonly string[]): boolean {
  return phrase.length > 0 && phrase.every((word) => words.has(word));
}

/**
 * Whether a held plan rests on one thing an Approve moved: drafted again if so, asked again if not.
 *
 * @param row - The held row, its plan as stored.
 * @param moved - What the Approve changed.
 * @returns True where its cites, the people it names or its own words reach the change, or where
 *   the test cannot tell.
 */
export function planRestsOn(row: HeldPlanRow, moved: MovedGround): boolean {
  if (moved.kind === 'everything') return true;
  if (typeof row.plan !== 'object' || row.plan === null) return true;
  const plan = row.plan as PlanParts;
  const words = planWords(plan);
  if (words.size === 0) return true;
  switch (moved.kind) {
    case 'edge':
      return (
        names(words, contentWords(moved.person)) ||
        moved.scopes.some((scope) => scopePhrases(scope).some((phrase) => names(words, phrase)))
      );
    case 'clauses':
      return moved.texts.some((text) => reachesClause(words, text));
    case 'page': {
      const cites = Array.isArray(plan.cites) ? plan.cites : [];
      const title = contentWords(moved.title);
      return (
        cites.some((cite) => cite.sourceId === moved.sourceId && cite.pageRef === moved.ref) ||
        (title.length >= 2 && names(words, title))
      );
    }
    case 'access': {
      const system = moved.system.toLowerCase();
      if (row.sourceSystem?.toLowerCase() === system) return true;
      const declared = planObligations({
        steps: Array.isArray(plan.steps) ? plan.steps : [],
        ...(plan.obligations !== undefined ? { obligations: plan.obligations } : {}),
      });
      if (declared === undefined) return true;
      return declared.steps.some((step) =>
        [...step.reads, ...step.writes].some((surface) => surface.toLowerCase() === system),
      );
    }
    case 'skill': {
      if (row.skillId === moved.skillId) return true;
      const named = contentWords(moved.name.replace(/[-_]/gu, ' '));
      return named.length >= 2 && names(words, named);
    }
  }
}

/**
 * Whether a held plan rests on anything an Approve moved.
 *
 * @param row - The held row, its plan as stored.
 * @param moved - Everything the Approve changed; empty when it changed nothing a plan rests on.
 */
export function planRestsOnAny(row: HeldPlanRow, moved: readonly MovedGround[]): boolean {
  return moved.some((ground) => planRestsOn(row, ground));
}
