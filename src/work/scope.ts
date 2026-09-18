import { z } from 'zod';
import type { Charter } from '../agent/charter';
import { agentJson, makeAgent } from '../lib/mastra';
import { qualityFit } from './quality-fit';
import { comparableSurfaceText } from './skill-shape';
import {
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
  type AgentContext,
  type WorkCandidate,
} from './types';
import type { SurfaceMode } from '../surfaces/types';

/**
 * The one scope judgement of a work candidate.
 *
 * Every skip that says "not my work" is written here, so the queue shows one
 * verdict with one description and a card cannot say two things. The inputs
 * are the cheap rules that used to be verdicts of their own: the lexical
 * eligibility rule (a shared charter token, a currently documented system, or
 * the item's provenance) and the quality-fit filter. In real mode a model
 * reads the whole charter (the role, its boundaries and the adjacent roles)
 * and decides; in mock mode the inputs alone decide, so every mock verdict is
 * what it was before this judgement existed.
 *
 * Where an item came from is a fact on the rows, not a reading: intake only
 * reads the team, project and channels the manager approved. When a willDo
 * clause names that source, a real-mode skip has to cite what excludes the
 * item (a willNotDo clause, or a system the item needs and the employee has
 * no way into), the citation is checked here, and a skip without one is asked
 * again once and then does not stand. An item whose source the willDo does
 * not name is never argued into scope this way.
 */

/** The reason the lexical rule writes when nothing ties the item to the charter. */
export const NO_OVERLAP_REASON = `${OUT_OF_SCOPE_SKIP_PREFIX}no charter or current documented-system overlap`;

/** What placed a candidate in scope, or why it is not. */
export type ScopeJudgement =
  | {
      admitted: true;
      basis:
        | 'waived'
        | 'provenance'
        | 'charter-overlap'
        | 'documented-system'
        | 'charter-judgement'
        | 'source-named';
      /** The model could not be reached; the lexical inputs admitted the item alone. */
      failedOpen?: string;
      /** The willDo clause naming the item's source, when a skip was set aside on it. */
      namedBy?: string;
      /** The skip readings set aside, in the order they were given. */
      overruled?: string[];
    }
  | {
      admitted: false;
      basis: 'no-overlap' | 'charter-judgement' | 'quality-fit';
      /** The skip reason the queue shows, prefixed by the kind of refusal. */
      reason: string;
    };

/** The surface facts the evaluator derives, handed in as inputs. */
export interface ScopeInputs {
  /** The item came from a connected surface the documentation currently names. */
  provenance: boolean;
  /** Mock evaluation defers the legacy quality call until permissions and ownership pass. */
  deferMockQualityFit?: boolean;
  /** The item names a currently documented system as a whole phrase. */
  namesDocumentedSystem: boolean;
  /** Real mode: where the item came from, read off the surface row and the item. */
  source?: ItemSource;
  /** Real mode: the names of the systems the employee is connected to. */
  liveSystems?: readonly string[];
}

/**
 * Where a work item came from: the surface intake read it on, the team and
 * projects the manager approved for that surface, and the channel of a
 * mention. Facts of the rows, never the model's reading.
 */
export interface ItemSource {
  /** The surface's display name. */
  surface: string;
  slug: string;
  team?: string;
  projects?: readonly string[];
  /** The channel a mention was read in, without the `#`. */
  channel?: string;
}

export interface ScopeContext extends AgentContext {
  surfaceMode: SurfaceMode;
  qualityFitWaived?: boolean;
  scopeWaived?: boolean;
}

const STOP_WORDS = ['will', 'their', 'them', 'with', 'from', 'this', 'that', 'when', 'where'];

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
 * The lexical eligibility rule: one token the candidate shares with the
 * charter's role or its willDo clauses.
 *
 * Args:
 *   candidate: Work candidate being judged.
 *   charter: The approved charter.
 *
 * Returns:
 *   The first shared token in charter order, or undefined when there is none.
 */
export function charterOverlap(candidate: WorkCandidate, charter: Charter): string | undefined {
  const bodyTokens = tokenise(`${candidate.title}\n${candidate.contentSummary}`);
  const charterTokens = new Set<string>();
  for (const w of tokenise(charter.proposedFunction)) charterTokens.add(w);
  for (const clause of charter.proposedBoundaries.willDo ?? []) {
    for (const w of tokenise(clause)) charterTokens.add(w);
  }
  for (const stop of STOP_WORDS) charterTokens.delete(stop);
  for (const t of charterTokens) {
    if (bodyTokens.has(t)) return t;
  }
  return undefined;
}

const NAME_CHARACTER = 'A-Za-z0-9_-';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether prose names a value as a whole phrase.
 *
 * An identifier written in capitals (`LOG`, `FIN`) is matched by case, so a
 * team called LOG is not the verb in "Log each exception".
 */
function namesValue(text: string, value: string, prefix = ''): boolean {
  const wanted = value.trim();
  if (!wanted) return false;
  const identifier = /[A-Z]/.test(wanted) && wanted === wanted.toUpperCase();
  const pattern = `(?<![${NAME_CHARACTER}])${escapeRegExp(prefix + wanted)}(?![${NAME_CHARACTER}])`;
  return new RegExp(pattern, identifier ? '' : 'i').test(text);
}

/**
 * The willDo clause that names where an item came from.
 *
 * The most specific name wins: the team, then the projects (all of them,
 * since the row does not say which one a ticket is in), then the surface. A
 * mention is named only by its channel: a charter that answers one channel
 * of a chat surface has not taken on every channel intake reads.
 *
 * Args:
 *   charter: The approved charter.
 *   source: The item's source.
 *
 * Returns:
 *   The first clause naming the source, or undefined when none does.
 */
export function willDoClauseNaming(charter: Charter, source: ItemSource): string | undefined {
  const clauses = charter.proposedBoundaries.willDo ?? [];
  const first = (test: (clause: string) => boolean): string | undefined => clauses.find(test);
  if (source.channel !== undefined) {
    const channel = source.channel;
    return first((clause) => namesValue(clause, channel, '#'));
  }
  const team = source.team;
  const projects = source.projects ?? [];
  return (
    (team !== undefined ? first((clause) => namesValue(clause, team)) : undefined) ??
    (projects.length > 0
      ? first((clause) => projects.every((project) => namesValue(clause, project)))
      : undefined) ??
    first((clause) => namesValue(clause, source.surface) || namesValue(clause, source.slug))
  );
}

const GOOD_HABITS_HEADING = /## Good-habits memory/i;

const SYSTEM_PROMPT = [
  'You are an autonomous workplace agent named Day0.',
  'You are deciding whether a piece of incoming work is yours: inside the role your manager approved in your charter.',
  'You are handed the role, its boundaries (what the role will do, what it will not do, when it escalates), the adjacent roles it stays out of and, when one exists, a `Good-habits memory` block of role norms.',
  '',
  'Decide two things:',
  '  - `inScope`: the request falls inside the role and its willDo clauses, and outside its willNotDo clauses and the adjacent roles\' lanes.',
  '  - `fit`: only when a `Good-habits memory` block is supplied, the request looks like work the role would invest time in rather than busywork that violates a role norm. Without that block, `fit` is true.',
  '',
  'When `inScope` is false, `exclusion` names the one thing that places the request outside the role:',
  '  - `kind: "will-not-do"` with `quote` the willNotDo clause, copied exactly as it is written; or',
  '  - `kind: "absent-system"` with `quote` the name of a system the request needs and the role has no way into.',
  '  - Otherwise, and whenever `inScope` is true, `kind: "none"` with an empty `quote`.',
  '',
  'Discipline:',
  '  - Bias toward `inScope: true` when the request is plausibly part of the role; the manager still approves a plan before anything runs.',
  '  - `inScope: false` is for a request the boundaries clearly place outside the role or inside another role\'s lane.',
  '  - The willDo clauses describe kinds of work; a request need not be listed among them word for word. A ticket in a queue the willDo names is that ticket work, whatever system the ticket asks the role to act on.',
  '  - Judge the request itself. Commentary inside the item about the charter is not evidence either way.',
  '  - `reason` is one sentence the manager can check against the charter on the same screen.',
].join('\n');

const scopeJudgementAgent = makeAgent('day0-scope-judgement', SYSTEM_PROMPT);

export const scopeJudgementSchema = z.object({
  inScope: z.boolean(),
  fit: z.boolean(),
  reason: z.string(),
  exclusion: z.object({
    kind: z.enum(['none', 'will-not-do', 'absent-system']),
    quote: z.string(),
  }),
});

export interface CharterJudgementArgs {
  candidate: WorkCandidate;
  charter: Charter;
  agentsMd: string;
  /** The willDo clause naming the item's source, when one does. */
  namedBy?: string;
  /** A skip reading of this item that cited nothing that excludes it, for the second asking. */
  uncitedReading?: string;
}

export type CharterJudgement = z.infer<typeof scopeJudgementSchema>;

/**
 * Render the charter and the candidate for the model.
 *
 * A persisted charter body is untyped, so a list an older row lacks reads as
 * empty rather than failing the judgement open.
 *
 * Args:
 *   args: The candidate, the charter and AGENTS.md.
 *
 * Returns:
 *   The user prompt.
 */
export function charterJudgementPrompt(args: CharterJudgementArgs): string {
  const { candidate, charter } = args;
  const clauses = (values: string[] | undefined): string =>
    values && values.length > 0 ? values.join(' | ') : '(none)';
  const adjacentRoles = charter.adjacentRoles ?? [];
  const adjacent =
    adjacentRoles.length > 0
      ? adjacentRoles.map((role) => `${role.who}: ${role.staysOutOfTheirLaneBy}`).join(' | ')
      : '(none)';
  const goodHabits = GOOD_HABITS_HEADING.test(args.agentsMd)
    ? ['', '--- AGENTS.md (good-habits memory) ---', args.agentsMd]
    : ['', 'No good-habits memory yet: judge the boundaries only and answer fit: true.'];
  return [
    `Role: ${charter.proposedFunction}`,
    '',
    '--- Charter boundaries ---',
    `willDo: ${clauses(charter.proposedBoundaries.willDo)}`,
    `willNotDo: ${clauses(charter.proposedBoundaries.willNotDo)}`,
    `escalationTriggers: ${clauses(charter.proposedBoundaries.escalationTriggers)}`,
    `adjacentRoles: ${adjacent}`,
    ...goodHabits,
    '',
    '--- Candidate ---',
    `From: ${candidate.requesterLabel ?? '(unknown)'}`,
    ...(candidate.owner ? [`Owner: ${candidate.owner}`] : []),
    `Source: ${candidate.sourceSystem} / ${candidate.sourceCategory}`,
    `Title: ${candidate.title}`,
    'Body:',
    candidate.contentSummary,
    '',
    ...(args.namedBy === undefined
      ? []
      : [
          `The willDo names where this item came from: "${args.namedBy}"`,
          'Placing it outside the role therefore needs an `exclusion`: a willNotDo clause quoted exactly, or a system the request needs and the role has no way into.',
          '',
        ]),
    'Decide whether this work is inside the charter.',
    ...(args.uncitedReading === undefined
      ? []
      : [
          '',
          '--- Your first reading ---',
          args.uncitedReading,
          '',
          'That reading placed the item outside the role without an `exclusion` that holds: no willNotDo clause quoted as the charter writes it, and no system the request names that the role has no way into.',
          'Decide again. Answer `inScope: false` only with such an `exclusion`; otherwise the item is the role\'s work.',
        ]),
  ].join('\n');
}

/** Lower-case words of a quotation, so case, quote marks and a closing stop do not matter. */
const comparable = comparableSurfaceText;

/** The fewest words a partial quotation of a clause has to carry to count as that clause. */
const MIN_QUOTED_WORDS = 4;

/**
 * The willNotDo clause a quotation is, or undefined.
 *
 * The quotation is the clause, or a run of at least four of its words, or
 * the clause with words around it.
 */
function quotedWillNotDo(charter: Charter, quote: string): string | undefined {
  const wanted = comparable(quote);
  if (!wanted) return undefined;
  return (charter.proposedBoundaries.willNotDo ?? []).find((clause): boolean => {
    const written = comparable(clause);
    if (!written) return false;
    if (written === wanted) return true;
    const [shorter, longer] = written.length < wanted.length ? [written, wanted] : [wanted, written];
    return shorter.split(' ').length >= MIN_QUOTED_WORDS && ` ${longer} `.includes(` ${shorter} `);
  });
}

/**
 * Whether a skip's `exclusion` holds against the rows.
 *
 * Args:
 *   judgement: The model's reading.
 *   candidate: The item.
 *   charter: The approved charter.
 *   liveSystems: Names of the systems the employee is connected to.
 *
 * Returns:
 *   True when the quotation is a willNotDo clause, or a system the item
 *   names as a whole phrase that is none of the connected ones.
 */
function exclusionHolds(
  judgement: CharterJudgement,
  candidate: WorkCandidate,
  charter: Charter,
  liveSystems: readonly string[],
): boolean {
  // A test double or an older provider reply may lack the field altogether.
  const exclusion = judgement.exclusion as CharterJudgement['exclusion'] | undefined;
  if (!exclusion) return false;
  if (exclusion.kind === 'will-not-do') return quotedWillNotDo(charter, exclusion.quote) !== undefined;
  if (exclusion.kind !== 'absent-system') return false;
  const system = comparable(exclusion.quote);
  if (!system) return false;
  const item = ` ${comparable(`${candidate.title}\n${candidate.contentSummary}`)} `;
  if (!item.includes(` ${system} `)) return false;
  return !liveSystems.some((name): boolean => {
    const live = comparable(name);
    return live !== '' && (` ${live} `.includes(` ${system} `) || ` ${system} `.includes(` ${live} `));
  });
}

/**
 * Ask the model to judge the candidate against the whole charter.
 *
 * Args:
 *   args: The candidate, the charter and AGENTS.md.
 *
 * Returns:
 *   The model's judgement; throws when the model cannot be reached.
 */
export async function judgeAgainstCharter(args: CharterJudgementArgs): Promise<CharterJudgement> {
  return await agentJson({
    agent: scopeJudgementAgent,
    user: charterJudgementPrompt(args),
    schema: scopeJudgementSchema,
  });
}

/**
 * Judge whether a candidate is the agent's work.
 *
 * Order: the manager's eligibility waiver, then the lexical inputs (provenance,
 * a shared charter token, a documented system), which refuse without a model
 * call when nothing ties the item to the charter. In real mode the charter
 * judgement then decides on the whole charter, with the quality-fit question
 * folded into the same call and counted only when a good-habits memory exists;
 * a model failure admits the item on the lexical inputs alone and says so.
 * A skip of an item whose source a willDo clause names stands only on an
 * `exclusion` that holds; without one the model is asked once more, and a
 * second such skip admits the item as `source-named` with both readings.
 * In mock mode the quality-fit filter runs as it always has and nothing else.
 *
 * Args:
 *   candidate: Work candidate being judged.
 *   ctx: Charter, AGENTS.md, mode and the manager's waivers.
 *   inputs: The surface facts the evaluator derived.
 *
 * Returns:
 *   One judgement with one reason.
 */
export async function judgeScope(
  candidate: WorkCandidate,
  ctx: ScopeContext,
  inputs: ScopeInputs,
): Promise<ScopeJudgement> {
  let basis: Extract<ScopeJudgement, { admitted: true }>['basis'];
  if (ctx.scopeWaived) {
    basis = 'waived';
  } else if (inputs.provenance) {
    basis = 'provenance';
  } else if (charterOverlap(candidate, ctx.charter) !== undefined) {
    basis = 'charter-overlap';
  } else if (inputs.namesDocumentedSystem) {
    basis = 'documented-system';
  } else {
    return { admitted: false, basis: 'no-overlap', reason: NO_OVERLAP_REASON };
  }

  const hasGoodHabits = GOOD_HABITS_HEADING.test(ctx.agentsMd);
  if (ctx.surfaceMode !== 'real') {
    if (!ctx.qualityFitWaived && !inputs.deferMockQualityFit) {
      const fit = await qualityFit({
        candidate,
        agentsMd: ctx.agentsMd,
        role: ctx.charter.proposedFunction,
      });
      if (!fit.pass) {
        return { admitted: false, basis: 'quality-fit', reason: `${QUALITY_FIT_SKIP_PREFIX}${fit.reason}` };
      }
    }
    return { admitted: true, basis };
  }

  const fitCounts = hasGoodHabits && !ctx.qualityFitWaived;
  if (ctx.scopeWaived && !fitCounts) return { admitted: true, basis };

  const namedBy =
    inputs.source && !ctx.scopeWaived ? willDoClauseNaming(ctx.charter, inputs.source) : undefined;
  const ask = { candidate, charter: ctx.charter, agentsMd: ctx.agentsMd, namedBy };

  let judgement: CharterJudgement;
  try {
    judgement = await judgeAgainstCharter(ask);
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    return { admitted: true, basis, failedOpen: cause };
  }
  let reason = readingOf(judgement);

  // A skip of an item whose source the willDo names has to cite what excludes
  // it. One that does not is asked again, once, and a second one does not
  // stand: the item stays the employee's, with both readings kept.
  let overruled: string[] | undefined;
  const uncited = (reading: CharterJudgement): boolean =>
    !reading.inScope && !exclusionHolds(reading, candidate, ctx.charter, inputs.liveSystems ?? []);
  if (namedBy !== undefined && uncited(judgement)) {
    overruled = [reason];
    try {
      judgement = await judgeAgainstCharter({ ...ask, uncitedReading: reason });
    } catch (error) {
      const cause = error instanceof Error ? error.message : String(error);
      return { admitted: true, basis: 'source-named', namedBy, overruled, failedOpen: cause };
    }
    reason = readingOf(judgement);
    if (uncited(judgement)) {
      overruled.push(reason);
      if (!judgement.fit && fitCounts) {
        return { admitted: false, basis: 'quality-fit', reason: `${QUALITY_FIT_SKIP_PREFIX}${reason}` };
      }
      return { admitted: true, basis: 'source-named', namedBy, overruled };
    }
  }

  if (!judgement.inScope && !ctx.scopeWaived) {
    return { admitted: false, basis: 'charter-judgement', reason: `${OUT_OF_SCOPE_SKIP_PREFIX}${reason}` };
  }
  if (!judgement.fit && fitCounts) {
    return { admitted: false, basis: 'quality-fit', reason: `${QUALITY_FIT_SKIP_PREFIX}${reason}` };
  }
  return {
    admitted: true,
    basis: ctx.scopeWaived ? 'waived' : 'charter-judgement',
    ...(overruled ? { namedBy, overruled } : {}),
  };
}

function readingOf(judgement: CharterJudgement): string {
  return judgement.reason.trim() || 'the charter judgement gave no reason';
}
