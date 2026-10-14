import { v, type ObjectType } from 'convex/values';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { appendEvent } from './eventLog';
import type { CardAffected } from './reorientationReach';
import { reorientationTalkProposalValidator } from './schema';
import type { Charter } from '../src/agent/charter';
import { RELATIONSHIP_NOUNS } from '../src/people/words';
import { PLAN_CANCELLED_REASON } from '../src/work/stop';
import { redactTokenShapes } from '../src/surfaces/redact';
import {
  BOUND_MET,
  UNDECIDED_REORIENTATION_STATUSES,
  type ReorientationStatus,
} from '../src/agent/reorientation-vocabulary';
import { log } from '../src/lib/logger';
import {
  COUNTED_EVENTS_SHOWN,
  agreementActionsOf,
  countedEventLine,
  type ClauseField,
  type CountedEvent,
  type ProposalCandidate,
  type ProposalInput,
} from '../src/agent/reorientation-proposal';

/*
 * What a reorientation card's judgement reads and what it writes back (wave 18, 18-s): the
 * candidates a card offers, the lines of evidence its prompt reads, the basis a proposal is
 * written onto, and the bodies of `reorientation.proposalInput`, `writeProposal` and
 * `recordProposalFailure`, which stay registered in `convex/reorientation.ts` at the paths the
 * judgement's action holds (S-1). Beside them, the readers the region shares with the card's
 * store, moved down so that neither imports the other's: the charter's approved clauses and its
 * reporting-line rules, the standings a card waits in, and a list's bound and its once-each
 * keeping. Moved out of `convex/reorientation.ts` as they stood. Below it: this module never
 * imports `./reorientation`.
 */

/**
 * The most ids one list of a card's evidence or affected set keeps: a later trigger of the day adds
 * to a card's lists, and Convex refuses an array past 8,192 values, so each list keeps its first
 * hundred (16-K's handover, "Bound every list on a card"). What a list left out is not recorded.
 */
export const CARD_LIST_LIMIT = 100;

/** The standings a card still waits in, deferred among them: it holds and a trigger joins it. */
export const STANDING_STATUSES = [
  ...UNDECIDED_REORIENTATION_STATUSES,
  'deferred',
] as const satisfies readonly ReorientationStatus[];

/** The list's values once each, by a key, at most `CARD_LIST_LIMIT` of them. */
export function unique<T>(
  lists: ReadonlyArray<readonly T[] | undefined>,
  keyOf: (value: T) => string,
): T[] {
  const seen = new Set<string>();
  const kept: T[] = [];
  let leftOut = 0;
  for (const value of lists.flatMap((list) => list ?? [])) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length < CARD_LIST_LIMIT) kept.push(value);
    else leftOut += 1;
  }
  // A value past the bound is not on the card, so a repeat of it is not recognised as carried:
  // said in the function log, where it was said nowhere (W16-R24).
  if (leftOut > 0)
    log.warn(BOUND_MET, { bound: 'CARD_LIST_LIMIT', limit: CARD_LIST_LIMIT, leftOut });
  return kept;
}

/** An id as its own key, for {@link unique}. */
export const idKey = (id: string): string => id;

/** The employee's charter as approved last, or undefined. */
export async function approvedCharter(
  ctx: QueryCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | undefined> {
  const latest = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .first();
  return latest?.approved ? latest : undefined;
}

/** The charter's list clauses, each by its list, its place and its text. */
export function clausesOf(body: Charter): CardAffected['charterClauses'] {
  const lists: ReadonlyArray<readonly [ClauseField, readonly string[] | undefined]> = [
    ['willDo', body.proposedBoundaries?.willDo],
    ['willNotDo', body.proposedBoundaries?.willNotDo],
    ['escalationTriggers', body.proposedBoundaries?.escalationTriggers],
  ];
  return lists.flatMap(([field, clauses]) =>
    (clauses ?? []).map((text, index) => ({ field, index, text })),
  );
}

/**
 * Whether a clause carries one of the charter's reporting-line rules: the rule's bound clauses
 * name it by list and place (`binds`), or, for a rule drafted before rules were bound, its wording
 * is in the clause.
 */
export function carriesReportingLine(
  clause: CardAffected['charterClauses'][number],
  body: Charter,
): boolean {
  return (body.constraints ?? []).some(
    (rule) =>
      rule.kind === 'reporting-line' &&
      rule.struck !== true &&
      (rule.binds !== undefined
        ? rule.binds.some((bound) => bound.field === clause.field && bound.index === clause.index)
        : rule.wording.some((phrase) => clause.text.includes(phrase))),
  );
}

/**
 * The words of each reporting-line rule the charter carries that binds none of its clauses (W16-R21,
 * W7a): a rule drafted before rules were bound has neither `binds` nor `wording`, so no clause
 * carries it and a handover's card would name nothing of what the old manager's rule was.
 */
export function unboundReportingLines(body: Charter): string[] {
  const clauses = clausesOf(body);
  return (body.constraints ?? []).flatMap((rule) =>
    rule.kind === 'reporting-line' &&
    rule.struck !== true &&
    rule.quote.trim() !== '' &&
    !clauses.some((clause) => carriesReportingLine(clause, { ...body, constraints: [rule] }))
      ? [rule.quote.trim()]
      : [],
  );
}

/** The scope a card offers the judgement: a repeated refusal's counted scope. */
function scopesOf(card: Doc<'reorientations'>): string[] {
  // A revoked scope is not offered: its only action would grant back what the manager just
  // revoked, one click from Approve (the second pass's minor).
  return card.trigger === 'repeated-refusal' && card.triggerKey.startsWith(REFUSAL_KEY_PREFIX)
    ? [card.triggerKey.slice(REFUSAL_KEY_PREFIX.length)]
    : [];
}

/** How a repeated refusal's key opens: the scope follows it. */
export const REFUSAL_KEY_PREFIX = 'refusal:';

/** Whether the employee holds a scope now. */
async function holdsScope(ctx: QueryCtx, agentId: Id<'agents'>, scope: string): Promise<boolean> {
  const grants = await ctx.db
    .query('permissionGrants')
    .withIndex('by_agent_scope', (q) => q.eq('agentId', agentId).eq('scope', scope))
    .take(10);
  return grants.some((grant) => grant.revokedAt === undefined);
}

/** A page by its source and ref, or null. */
async function pageOf(
  ctx: QueryCtx,
  page: { readonly sourceId: Id<'docSources'>; readonly ref: string },
): Promise<Doc<'docPages'> | null> {
  return await ctx.db
    .query('docPages')
    .withIndex('by_source_ref', (q) => q.eq('sourceId', page.sourceId).eq('ref', page.ref))
    .first();
}

/** An edge of the people graph in the card's words: who, what to the employee, and its scope. */
async function edgeWords(ctx: QueryCtx, edge: Doc<'relationships'>): Promise<string> {
  const person = await ctx.db.get(edge.toPersonId);
  const scope = edge.scope !== undefined && edge.scope !== '' ? `, for ${edge.scope}` : '';
  return `${person?.displayName ?? 'someone'} (${RELATIONSHIP_NOUNS[edge.type]}${scope}), ${edge.status}`;
}

/** The candidates a card offers its judgement, in the prompt's order. */
async function candidatesOf(
  ctx: QueryCtx,
  card: Doc<'reorientations'>,
  charter: Doc<'charters'> | undefined,
): Promise<ProposalCandidate[]> {
  const clauses =
    card.trigger === 'role-changed' && charter !== undefined
      ? clausesOf(charter.body as Charter).slice(0, CARD_LIST_LIMIT)
      : card.affected.charterClauses;
  const candidates: ProposalCandidate[] = clauses.map((clause) => ({
    kind: 'charter-clause' as const,
    ...clause,
  }));
  for (const id of card.affected.agreements) {
    const agreement = await ctx.db.get(id);
    if (agreement !== null) {
      candidates.push({
        kind: 'agreement',
        agreementId: id,
        statement: agreement.statement,
        // An owed check's card offers the check and nothing else of the agreement (RM34 (a)).
        actions:
          card.trigger === 'agreement-check-owed' ? ['recheck'] : agreementActionsOf(agreement),
      });
    }
  }
  for (const id of unique([card.affected.relationships, card.evidence.relationshipIds], idKey)) {
    const edge = await ctx.db.get(id);
    // An edge already retired or superseded has nothing left to change (the walk's W-3).
    if (edge !== null && edge.status !== 'superseded' && edge.status !== 'retired') {
      candidates.push({
        kind: 'relationship',
        relationshipId: id,
        description: await edgeWords(ctx, edge),
        type: edge.type,
      });
    }
  }
  for (const ref of card.evidence.pageRefs) {
    const page = await pageOf(ctx, ref);
    if (page === null) continue;
    const successor = page.supersededBy !== undefined ? await pageOf(ctx, page.supersededBy) : null;
    candidates.push({
      kind: 'page',
      page: { sourceId: page.sourceId, ref: page.ref },
      title: page.title,
      status: page.status ?? 'active',
      setByManager: page.statusSource === 'manager',
      ...(successor !== null
        ? {
            supersededBy: {
              page: { sourceId: successor.sourceId, ref: successor.ref },
              title: successor.title,
            },
          }
        : {}),
    });
  }
  for (const scope of scopesOf(card)) {
    candidates.push({ kind: 'scope', scope, held: await holdsScope(ctx, card.agentId, scope) });
  }
  for (const id of unique([card.affected.skills, card.evidence.skillIds], idKey)) {
    const skill = await ctx.db.get(id);
    // Only a registered skill takes a re-check, a retirement or a withdrawal (the walk's W-2).
    if (skill?.state === 'registered') {
      candidates.push({ kind: 'skill', skillId: id, name: skill.name });
    }
  }
  return candidates;
}

/** What the card rests on and reaches, one line each, for the judgement's prompt. */
async function evidenceLines(ctx: QueryCtx, card: Doc<'reorientations'>): Promise<string[]> {
  const lines: string[] = [];
  for (const id of card.evidence.relationIds) {
    const relation = await ctx.db.get(id);
    if (relation === null) continue;
    const [from, to] = await Promise.all([pageOf(ctx, relation.from), pageOf(ctx, relation.to)]);
    lines.push(
      `Pages “${from?.title ?? relation.from.ref}” and “${to?.title ?? relation.to.ref}”: ${relation.kind.replace(/_/g, ' ')}, ${relation.status}`,
    );
  }
  for (const id of card.evidence.correctionIds) {
    const correction = await ctx.db.get(id);
    if (correction !== null)
      lines.push(`Correction on “${correction.itemTitle}”: ${correction.text}`);
  }
  lines.push(...(await countedEventLines(ctx, card)));
  if (card.trigger === 'manager-changed') {
    const charter = await approvedCharter(ctx, card.agentId);
    for (const quote of charter === undefined
      ? []
      : unboundReportingLines(charter.body as Charter)) {
      lines.push(
        `A reporting-line rule of the previous manager’s that the charter carries: “${redactTokenShapes(quote)}”`,
      );
    }
  }
  for (const id of card.affected.workItems.slice(0, 10)) {
    const row = await ctx.db.get(id);
    if (row !== null) lines.push(`Work affected: “${row.title}”, ${row.state}`);
  }
  return lines;
}

/**
 * The events a counted card rests on, up to `COUNTED_EVENTS_SHOWN` of each type, as evidence lines
 * (W16-R4, D-4 (a)): the rejections' reasons, the skips' clauses and reasons, the refusals'
 * withheld reasons, each by its item's title. Other events a card carries say nothing here.
 */
async function countedEventLines(ctx: QueryCtx, card: Doc<'reorientations'>): Promise<string[]> {
  const lines: string[] = [];
  const shown = new Map<string, number>();
  for (const id of card.evidence.eventIds) {
    const event = await ctx.db.get(id);
    if (event === null) continue;
    const counted = await countedEventOf(ctx, event);
    if (counted === undefined || (shown.get(counted.type) ?? 0) >= COUNTED_EVENTS_SHOWN) continue;
    const line = countedEventLine(counted);
    if (line === undefined) continue;
    shown.set(counted.type, (shown.get(counted.type) ?? 0) + 1);
    lines.push(line);
  }
  return lines;
}

/** A counted event with its item's title, or undefined for an event of another type. */
async function countedEventOf(
  ctx: QueryCtx,
  event: Doc<'events'>,
): Promise<CountedEvent | undefined> {
  const payload = event.payload as {
    workItemId?: Id<'workItems'>;
    reason?: unknown;
    clause?: unknown;
    withheld?: ReadonlyArray<{ reason?: unknown }>;
  };
  if (
    event.type !== 'work.cancelled' &&
    event.type !== 'work.skipped' &&
    event.type !== 'work.actions-withheld'
  ) {
    return undefined;
  }
  const item = payload.workItemId === undefined ? null : await ctx.db.get(payload.workItemId);
  const title = item?.title ?? 'an item no longer listed';
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value.trim() !== '' ? value : undefined;
  switch (event.type) {
    case 'work.cancelled':
      return { type: event.type, title, reason: text(payload.reason) ?? PLAN_CANCELLED_REASON };
    case 'work.skipped': {
      const clause = text(payload.clause);
      const reason = text(payload.reason);
      return {
        type: event.type,
        title,
        ...(clause === undefined ? {} : { clause }),
        ...(reason === undefined ? {} : { reason }),
      };
    }
    case 'work.actions-withheld':
      return {
        type: event.type,
        title,
        reasons: (payload.withheld ?? []).flatMap((row) => text(row.reason) ?? []),
      };
  }
}

/**
 * What a proposal about one card is drawn from: the employee, what changed, what the card rests on
 * and the numbered candidates. Null when the employee is gone. Read by the judgement
 * (`proposalInput`) and by a Discuss conversation (`convex/reorientationTalk.ts`, 16-D), so both
 * choose among the same candidates in the same order.
 */
export async function proposalInputOf(
  ctx: QueryCtx,
  card: Doc<'reorientations'>,
): Promise<ProposalInput | null> {
  const agent = await ctx.db.get(card.agentId);
  if (agent === null) return null;
  const charter = await approvedCharter(ctx, card.agentId);
  return {
    employeeName: agent.name,
    roleFunction:
      charter !== undefined ? (charter.body as Charter).proposedFunction : 'not yet chartered',
    trigger: card.trigger,
    summary: card.triggerSummary,
    evidence: await evidenceLines(ctx, card),
    candidates: await candidatesOf(ctx, card, charter),
  };
}

/** What `reorientation.proposalInput` takes. */
export const proposalInputArgs = { reorientationId: v.id('reorientations') };

/**
 * What the judgement reads of one card, or null when the card is decided or gone.
 * The body of `reorientation.proposalInput`.
 */
export async function proposalInputInTransaction(
  ctx: QueryCtx,
  args: ObjectType<typeof proposalInputArgs>,
): Promise<{ input: ProposalInput; basis: string } | null> {
  const card = await ctx.db.get(args.reorientationId);
  if (card === null || card.proposed.kind !== 'pending') return null;
  if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return null;
  const input = await proposalInputOf(ctx, card);
  return input === null ? null : { input, basis: proposalBasis(card) };
}

/**
 * What of a card a join changes, as one string: the judgement's proposal is written only onto the
 * card it read (the second pass's M6). A join while the model answers schedules its own judgement,
 * which reads the joined card; the earlier answer is then set aside, not written.
 */
export function proposalBasis(card: Doc<'reorientations'>): string {
  return JSON.stringify([card.evidence, card.affected, card.risk]);
}

/** What `reorientation.writeProposal` takes. */
export const writeProposalArgs = {
  reorientationId: v.id('reorientations'),
  proposed: reorientationTalkProposalValidator,
  basis: v.string(),
};

/**
 * Write the judgement's proposal onto its card, which never applies it.
 * The body of `reorientation.writeProposal`.
 */
export async function writeProposalInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof writeProposalArgs>,
): Promise<{ written: boolean }> {
  const card = await ctx.db.get(args.reorientationId);
  if (card === null || card.proposed.kind !== 'pending') return { written: false };
  if (!(STANDING_STATUSES as readonly string[]).includes(card.status)) return { written: false };
  if (proposalBasis(card) !== args.basis) return { written: false };
  await ctx.db.patch(card._id, { proposed: args.proposed });
  await appendEvent(ctx, {
    agentId: card.agentId,
    type: 'reorientation.proposed',
    payload: {
      reorientationId: card._id,
      summary: card.triggerSummary,
      kind: args.proposed.kind,
      by: 'judgement',
    },
    createdAt: Date.now(),
  });
  return { written: true };
}

/** What `reorientation.recordProposalFailure` takes. */
export const recordProposalFailureArgs = {
  reorientationId: v.id('reorientations'),
  failure: v.string(),
  /** What the judgement read; absent when it failed before it read the card (W16-R23). */
  basis: v.optional(v.string()),
};

/**
 * Record that the judgement could not propose: the card stays open with nothing proposed.
 * The body of `reorientation.recordProposalFailure`.
 */
export async function recordProposalFailureInTransaction(
  ctx: MutationCtx,
  args: ObjectType<typeof recordProposalFailureArgs>,
): Promise<void> {
  const card = await ctx.db.get(args.reorientationId);
  if (card === null || card.proposed.kind !== 'pending') return;
  if (args.basis !== undefined && proposalBasis(card) !== args.basis) return;
  await ctx.db.patch(card._id, {
    proposed: { kind: 'pending', failedAt: Date.now(), failure: args.failure },
  });
}
