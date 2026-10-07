import { ConvexError, v } from 'convex/values';
import {
  internalMutation,
  internalQuery,
  mutation,
  query,
  type MutationCtx,
  type QueryCtx,
} from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { assertOwnsAgent, assertOwnsAgreement, employeeOwnerScope } from './ownership';
import { appendEvent } from './eventLog';
import { itemPersonIds } from './itemPeople';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { redactTokenShapes } from '../src/surfaces/redact';
import { surfaceSlug } from '../src/surfaces/slug';
import {
  agreementStatement,
  selectAgreements,
  type CharterBounds,
  type JudgedCorrection,
} from '../src/work/agreements';
import { awaitingCheck, type AgreementView } from '../src/work/agreement-words';
import {
  AGREEMENT_REFUSAL_REASONS,
  AGREEMENT_STATEMENT_LIMIT,
  type AgreementApprovedVia,
  type AgreementStatus,
} from '../src/work/agreement-vocabulary';

/*
 * Working agreements (wave 13, 13-W; the wave file's 5.3; A10, A14, A18): standing preferences the
 * manager keeps beside the charter. Proposed from a correction applied to a second item or from
 * corrections the model judges alike (F10), checked against the charter before a proposal is shown
 * (F11), and kept on a card: the promotion card on the Work tab, the Agreements card on the Charter
 * tab, or the "Keep this note" tick of a plan approval. A kept agreement is checked again before it
 * takes effect, by an action the keep schedules (the standard's 7.4: the browser records intent in
 * a mutation), so nothing unchecked is ever active; until the check answers the row is `proposed`
 * with `approvedAt` set. The planner reads the active ones through `selectedForCandidate`, the
 * executor the ones its approved plan applied through `forPlan`; the scope judgement never reads
 * one. Every owner-level read leads with the owner scope (13-K): `by_agent_status` is never read
 * here, since with an absent `agentId` it answers every owner's every-employee rows.
 */

/** The most agreements of one standing read for one owner and one binding (an employee, or all). */
export const AGREEMENTS_READ = 200;

/** The most charter versions walked back to find an employee's newest approved one. */
const CHARTER_VERSIONS = 50;

/** The most employees of one owner whose charters an every-employee agreement is checked against. */
export const EMPLOYEES_CHECKED = 50;

/** The most of an employee's active corrections the sameness judgement reads, newest first. */
export const CORRECTIONS_JUDGED = 20;

/**
 * How long after the last retry a kept agreement whose check never answered is checked again, at
 * the employee's next proposal run: the retries' delays summed, with room for the last check.
 */
export const CHECK_RETRY_DELAYS_MS: readonly number[] = [30_000, 120_000, 600_000];

/** How long a kept agreement may wait on its check before the next proposal run checks it again. */
export const CHECK_STALE_MS =
  CHECK_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0) + 5 * 60_000;

/** The refusal when an agreement is not in a standing the asked change applies to. */
export const AGREEMENT_MOVED_ON = 'This working agreement has changed since this page loaded.';

/** The refusal when an agreement does not bind the employee whose card it was changed on. */
export const AGREEMENT_NOT_THIS_EMPLOYEES = "This working agreement is not this employee's.";

/** The refusal of a working agreement in mock mode, where nothing reads one. */
export const AGREEMENTS_REAL_MODE_ONLY = 'Working agreements are kept in real mode only.';

/** The refusal of an empty statement. */
export const AGREEMENT_STATEMENT_EMPTY = 'Write the agreement before keeping it.';

/** The refusal of a statement longer than an agreement keeps. */
export const AGREEMENT_STATEMENT_TOO_LONG = `A working agreement keeps at most ${AGREEMENT_STATEMENT_LIMIT} characters.`;

/** The refusal of a second change of an agreement while its first waits on its check. */
export const AGREEMENT_CHANGE_WAITING = 'This working agreement has a change waiting on its check.';

/** The most items an agreement's `appliedTo` keeps, the newest: the record holds every one. */
export const AGREEMENT_APPLIED_KEPT = 100;

/** The cards a keep is made on; the plan approval's tick keeps through `approvePlan` alone. */
const cardValidator = v.union(v.literal('promotion-card'), v.literal('agreements-card'));

/** The agreements of one standing that bind one employee: its own, and every employee's. */
async function bindingAgreements(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  agentId: Id<'agents'>,
  status: AgreementStatus,
): Promise<Doc<'workingAgreements'>[]> {
  const [own, everyone] = await Promise.all(
    [agentId, undefined].map(
      async (binding) =>
        await ctx.db
          .query('workingAgreements')
          .withIndex('by_user_agent_status', (q) =>
            q.eq('userId', userId).eq('agentId', binding).eq('status', status),
          )
          .order('desc')
          .take(AGREEMENTS_READ),
    ),
  );
  return [...(own ?? []), ...(everyone ?? [])];
}

/** Whether an agreement binds an employee: its own, or every employee's of the same owner. */
function binds(row: Doc<'workingAgreements'>, agent: Doc<'agents'>): boolean {
  const scope = employeeOwnerScope(agent);
  return (
    scope !== undefined &&
    row.userId === scope &&
    (row.agentId === undefined || row.agentId === agent._id)
  );
}

/** An employee's newest approved charter's boundaries, or null before its first approval. */
async function approvedBounds(
  ctx: Pick<QueryCtx, 'db'>,
  agent: Doc<'agents'>,
): Promise<CharterBounds | null> {
  const versions = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agent._id))
    .order('desc')
    .take(CHARTER_VERSIONS);
  const approved = versions.find((charter) => charter.approved);
  if (approved === undefined) return null;
  const body = approved.body as {
    proposedBoundaries?: { willDo?: unknown; willNotDo?: unknown };
  };
  const clauses = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  return {
    name: agent.name,
    willDo: clauses(body.proposedBoundaries?.willDo),
    willNotDo: clauses(body.proposedBoundaries?.willNotDo),
  };
}

/**
 * The charters an agreement is checked against: its employee's, or, for one that binds every
 * employee, each of the owner's employees' newest approved charter.
 */
async function chartersBound(
  ctx: Pick<QueryCtx, 'db'>,
  row: Doc<'workingAgreements'>,
): Promise<CharterBounds[]> {
  const employees =
    row.agentId !== undefined
      ? [await ctx.db.get(row.agentId)].filter((agent): agent is Doc<'agents'> => agent !== null)
      : (
          await ctx.db
            .query('agents')
            .withIndex('by_userId', (q) => q.eq('userId', row.userId))
            .take(EMPLOYEES_CHECKED)
        ).filter((agent) => employeeOwnerScope(agent) === row.userId);
  const bounds = await Promise.all(
    employees.map(async (agent) => await approvedBounds(ctx, agent)),
  );
  return bounds.filter((charter): charter is CharterBounds => charter !== null);
}

/** Schedule the check of a kept agreement; the action settles it active or refused. */
async function scheduleCheck(
  ctx: MutationCtx,
  agreementId: Id<'workingAgreements'>,
  agentId: Id<'agents'>,
): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workingAgreementActions.settleKept, {
    agreementId,
    agentId,
    attempt: 0,
  });
}

/**
 * Keep the note of a plan approval as a working agreement (the "Keep this note for later work of
 * this kind" tick), in the approval's transaction: for the item's employee, scoped to work on the
 * item's source surface, kept by the manager on the card (A14) and active once the check that the
 * same click schedules answers. Real mode only: nothing reads an agreement in mock mode. The same
 * note kept again keeps the agreement already in force or waiting, rather than a second one.
 *
 * @param ctx - The approval's mutation context.
 * @param row - The plan-pending work item.
 * @param note - The manager's note, as written.
 * @returns The kept agreement, or the one already kept for the same note.
 * @throws ConvexError in mock mode, or for an employee no owner holds.
 */
export async function keepPlanNoteInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  note: string,
): Promise<Id<'workingAgreements'>> {
  if (SURFACE_MODE !== 'real') throw new ConvexError(AGREEMENTS_REAL_MODE_ONLY);
  const agent = await ctx.db.get(row.agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (!agent || userId === undefined) throw new ConvexError(AGREEMENT_NOT_THIS_EMPLOYEES);
  const statement = agreementStatement(redactTokenShapes(note));
  if (statement === '') throw new ConvexError(AGREEMENT_STATEMENT_EMPTY);
  const scopeRef = surfaceSlug(row.sourceSystem);
  // The same note kept again keeps the agreement already in force, or already waiting on its check.
  const kept = [
    ...(await bindingAgreements(ctx, userId, row.agentId, 'active')),
    ...(await bindingAgreements(ctx, userId, row.agentId, 'proposed')).filter(awaitingCheck),
  ].find(
    (agreement) =>
      agreement.agentId === row.agentId &&
      agreement.statement === statement &&
      agreement.scope === 'surface' &&
      agreement.scopeRef === scopeRef,
  );
  if (kept) return kept._id;
  const now = Date.now();
  const agreementId = await ctx.db.insert('workingAgreements', {
    userId,
    agentId: row.agentId,
    kind: 'preference',
    statement,
    scope: 'surface',
    scopeRef,
    sourceType: 'plan-approval',
    workItemId: row._id,
    status: 'proposed',
    approvedAt: now,
    approvedVia: 'plan-approval',
    createdAt: now,
    appliedTo: [],
  });
  await scheduleCheck(ctx, agreementId, row.agentId);
  return agreementId;
}

/**
 * Record that a stored plan applied agreements, keeping only the ones that may be: active, of the
 * employee's owner, and binding this employee. Each lists the newest `AGREEMENT_APPLIED_KEPT` items
 * it was applied to, so a row every employee's plans apply stays bounded; the plan itself and its
 * `work.plan-drafted` event say which agreements it applied.
 *
 * @param ctx - Mutation context.
 * @param row - The work item whose plan is being stored.
 * @param ids - The ids the plan says it applied.
 * @returns The ids kept, each now listing the work item in `appliedTo`.
 */
export async function markAgreementsAppliedInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  ids: readonly unknown[],
): Promise<Id<'workingAgreements'>[]> {
  const agent = await ctx.db.get(row.agentId);
  if (!agent) return [];
  const kept: Id<'workingAgreements'>[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? ctx.db.normalizeId('workingAgreements', raw) : null;
    if (!id || kept.includes(id)) continue;
    const agreement = await ctx.db.get(id);
    if (!agreement || agreement.status !== 'active' || !binds(agreement, agent)) continue;
    if (!agreement.appliedTo.includes(row._id)) {
      await ctx.db.patch(id, {
        appliedTo: [...agreement.appliedTo, row._id].slice(-AGREEMENT_APPLIED_KEPT),
      });
    }
    kept.push(id);
  }
  return kept;
}

/** How many distinct items a correction has governed: the one it was given on and those it was applied to. */
function itemsGoverned(correction: Doc<'corrections'>): number {
  return new Set([correction.workItemId, ...correction.appliedTo]).size;
}

/** The employee's active corrections not yet proposed into an agreement, newest first, bounded. */
async function unproposedCorrections(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Doc<'corrections'>[]> {
  const active = await ctx.db
    .query('corrections')
    .withIndex('by_agent_active_createdAt', (q) =>
      q.eq('agentId', agentId).eq('retiredAt', undefined),
    )
    .order('desc')
    .take(CORRECTIONS_JUDGED);
  return active.filter((correction) => correction.agreementId === undefined);
}

/** Whether an agreement is a proposal still waiting on the manager, which a repeat may join. */
function openProposal(row: Doc<'workingAgreements'> | null): row is Doc<'workingAgreements'> {
  return row !== null && row.status === 'proposed' && row.approvedAt === undefined;
}

/**
 * The corrections the sameness judgement reads: the employee's active ones, newest first, bounded,
 * not yet proposed or proposed into an agreement still waiting on the manager, which a correction
 * that repeats one of them joins (so its card says the manager said it twice).
 */
async function judgeableCorrections(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Array<{ correction: Doc<'corrections'>; open?: Id<'workingAgreements'> }>> {
  const active = await ctx.db
    .query('corrections')
    .withIndex('by_agent_active_createdAt', (q) =>
      q.eq('agentId', agentId).eq('retiredAt', undefined),
    )
    .order('desc')
    .take(CORRECTIONS_JUDGED);
  const judged = await Promise.all(
    active.map(async (correction) => {
      if (correction.agreementId === undefined) return [{ correction }];
      const agreement = await ctx.db.get(correction.agreementId);
      return openProposal(agreement) ? [{ correction, open: agreement._id }] : [];
    }),
  );
  return judged.flat();
}

/**
 * Schedule the employee's proposal run when a plan just stored gives it work: a correction the plan
 * applied may now govern a second item, a correction governs one and was not shown (its check could
 * not be had), a correction the sameness judgement has not read yet (one kept before this release,
 * or one whose judgement failed), or a kept agreement still waits on a check whose retries were
 * spent. Real mode only, as corrections are.
 *
 * @param ctx - The storing mutation's context, after the plan's corrections were marked applied.
 * @param agentId - The employee.
 */
export async function scheduleProposalsAfterPlan(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const open = await unproposedCorrections(ctx, agentId);
  const due =
    open.some(
      (correction) => correction.agreementJudgedAt === undefined || itemsGoverned(correction) >= 2,
    ) || (await staleChecksOf(ctx, agentId)).length > 0;
  if (due) await scheduleProposals(ctx, agentId);
}

/**
 * The agreements binding an employee that were kept and still wait on a check whose retries were
 * spent: the proposal run checks them again.
 */
async function staleChecksOf(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Doc<'workingAgreements'>[]> {
  const agent = await ctx.db.get(agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (userId === undefined) return [];
  const staleBefore = Date.now() - CHECK_STALE_MS;
  return (await bindingAgreements(ctx, userId, agentId, 'proposed')).filter(
    (row) => awaitingCheck(row) && (row.approvedAt ?? 0) < staleBefore,
  );
}

/**
 * Schedule the employee's proposal run: corrections applied to a second item, corrections the
 * model judges alike, each checked before it is shown. Called where a correction is kept and where
 * a plan is stored.
 *
 * @param ctx - Mutation context.
 * @param agentId - The employee.
 */
export async function scheduleProposals(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.workingAgreementActions.proposeFromCorrections, {
    agentId,
  });
}

/** What the proposal run reads: the employee's charter, its unproposed corrections, kept agreements whose check went stale. */
export interface ProposalInputs {
  readonly userId: string;
  readonly charter: CharterBounds;
  readonly corrections: ReadonlyArray<
    JudgedCorrection & {
      readonly id: Id<'corrections'>;
      readonly sourceSystem: string;
      readonly itemsGoverned: number;
      /** The proposal still waiting on the manager it was proposed into, which a repeat joins. */
      readonly openAgreementId?: Id<'workingAgreements'>;
    }
  >;
  readonly staleChecks: readonly Id<'workingAgreements'>[];
}

/**
 * Internal: what the employee's proposal run reads. Null for an employee no owner holds or with no
 * approved charter, whose statements cannot be checked.
 */
export const proposalInputs = internalQuery({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<ProposalInputs | null> => {
    const agent = await ctx.db.get(args.agentId);
    const userId = agent ? employeeOwnerScope(agent) : undefined;
    if (!agent || userId === undefined) return null;
    const charter = await approvedBounds(ctx, agent);
    if (charter === null) return null;
    const corrections = await judgeableCorrections(ctx, args.agentId);
    const staleChecks = await staleChecksOf(ctx, args.agentId);
    return {
      userId,
      charter,
      corrections: corrections.map(({ correction, open }) => ({
        id: correction._id,
        text: correction.text,
        itemTitle: correction.itemTitle,
        createdAt: correction.createdAt,
        isNew: correction.agreementJudgedAt === undefined,
        sourceSystem: correction.sourceSystem,
        itemsGoverned: itemsGoverned(correction),
        ...(open !== undefined ? { openAgreementId: open, inProposal: true } : {}),
      })),
      staleChecks: staleChecks.map((row) => row._id),
    };
  },
});

/**
 * Add corrections that repeat a proposal still waiting on the manager to that proposal, oldest
 * first, each then naming it, so its card says how often the manager said it.
 */
async function joinProposal(
  ctx: MutationCtx,
  agreement: Doc<'workingAgreements'>,
  joining: readonly Doc<'corrections'>[],
): Promise<void> {
  const members = [
    ...(await Promise.all((agreement.correctionIds ?? []).map((id) => ctx.db.get(id)))).filter(
      (correction): correction is Doc<'corrections'> => correction !== null,
    ),
    ...joining,
  ].sort(
    (left, right) => left.createdAt - right.createdAt || left._creationTime - right._creationTime,
  );
  await ctx.db.patch(agreement._id, { correctionIds: members.map((member) => member._id) });
  for (const correction of joining) {
    await ctx.db.patch(correction._id, { agreementId: agreement._id });
  }
}

const refusalValidator = v.object({
  reason: v.union(...AGREEMENT_REFUSAL_REASONS.map((reason) => v.literal(reason))),
  clause: v.optional(v.string()),
});

/**
 * Internal: record the proposal run's outcome. Keeps each checked proposal as `proposed`, or
 * `refused` with its clause, unless one of its corrections was proposed or retired since the run
 * read it, or joins a proposal still waiting on the manager in the same words; adds each
 * correction that repeats such a proposal to it; and marks the corrections the sameness judgement read, but for those of a proposal or
 * a join so skipped, which are judged again. Each correction then names its
 * agreement, so it is never proposed twice. Writes `agreement.proposed` or `agreement.refused`.
 */
export const recordProposals = internalMutation({
  args: {
    agentId: v.id('agents'),
    judged: v.array(v.id('corrections')),
    proposals: v.array(
      v.object({
        correctionIds: v.array(v.id('corrections')),
        statement: v.string(),
        refusal: v.optional(refusalValidator),
      }),
    ),
    /** Corrections that repeat a proposal still waiting on the manager, to join it. */
    joins: v.optional(
      v.array(
        v.object({
          agreementId: v.id('workingAgreements'),
          correctionIds: v.array(v.id('corrections')),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<{ proposed: Id<'workingAgreements'>[] }> => {
    const agent = await ctx.db.get(args.agentId);
    const userId = agent ? employeeOwnerScope(agent) : undefined;
    if (!agent || userId === undefined) return { proposed: [] };
    const now = Date.now();
    const proposed: Id<'workingAgreements'>[] = [];
    const skipped = new Set<Id<'corrections'>>();
    for (const proposal of args.proposals) {
      const corrections = await Promise.all(proposal.correctionIds.map((id) => ctx.db.get(id)));
      const open = corrections.filter(
        (correction): correction is Doc<'corrections'> =>
          correction !== null &&
          correction.agentId === args.agentId &&
          correction.retiredAt === undefined &&
          correction.agreementId === undefined,
      );
      if (open.length !== proposal.correctionIds.length || proposal.statement === '') {
        // Another run proposed one of them first: these are judged again with the next new one.
        for (const id of proposal.correctionIds) skipped.add(id);
        continue;
      }
      // The same words already waiting in a proposal: these corrections join it, never a second one.
      if (!proposal.refusal) {
        const waiting = (await bindingAgreements(ctx, userId, args.agentId, 'proposed')).find(
          (row) =>
            openProposal(row) &&
            row.agentId === args.agentId &&
            row.statement === proposal.statement,
        );
        if (waiting) {
          await joinProposal(ctx, waiting, open);
          continue;
        }
      }
      const surfaces = new Set(open.map((correction) => surfaceSlug(correction.sourceSystem)));
      const [surface] = [...surfaces];
      const agreementId = await ctx.db.insert('workingAgreements', {
        userId,
        agentId: args.agentId,
        kind: 'preference',
        statement: proposal.statement,
        ...(surfaces.size === 1 && surface !== undefined
          ? { scope: 'surface' as const, scopeRef: surface }
          : { scope: 'global' as const }),
        sourceType: 'correction-promotion',
        correctionIds: proposal.correctionIds,
        status: proposal.refusal ? 'refused' : 'proposed',
        ...(proposal.refusal ? { refusal: { ...proposal.refusal, judgedAt: now } } : {}),
        createdAt: now,
        appliedTo: [],
      });
      for (const correction of open) await ctx.db.patch(correction._id, { agreementId });
      await appendEvent(
        ctx,
        proposal.refusal
          ? {
              agentId: args.agentId,
              type: 'agreement.refused',
              payload: { agreementId, everyEmployee: false, ...proposal.refusal },
              createdAt: now,
            }
          : {
              agentId: args.agentId,
              type: 'agreement.proposed',
              payload: {
                agreementId,
                everyEmployee: false,
                source: 'correction-promotion',
                correctionIds: proposal.correctionIds,
              },
              createdAt: now,
            },
      );
      if (!proposal.refusal) proposed.push(agreementId);
    }
    for (const join of args.joins ?? []) {
      const agreement = await ctx.db.get(join.agreementId);
      const joining = (await Promise.all(join.correctionIds.map((id) => ctx.db.get(id)))).filter(
        (correction): correction is Doc<'corrections'> =>
          correction !== null &&
          correction.agentId === args.agentId &&
          correction.retiredAt === undefined &&
          correction.agreementId === undefined,
      );
      if (!openProposal(agreement) || agreement.agentId !== args.agentId || joining.length === 0) {
        for (const id of join.correctionIds) skipped.add(id);
        continue;
      }
      await joinProposal(ctx, agreement, joining);
    }
    for (const id of args.judged) {
      if (skipped.has(id)) continue;
      const correction = await ctx.db.get(id);
      if (correction && correction.agentId === args.agentId) {
        await ctx.db.patch(id, { agreementJudgedAt: now });
      }
    }
    return { proposed };
  },
});

/** What the check of a kept agreement reads: the row and the charters it would bind. */
export interface CheckInputs {
  readonly agreement: Doc<'workingAgreements'>;
  readonly charters: readonly CharterBounds[];
}

/** Internal: what the check of a kept agreement reads, or null once it no longer waits on one. */
export const checkInputs = internalQuery({
  args: { agreementId: v.id('workingAgreements') },
  handler: async (ctx, args): Promise<CheckInputs | null> => {
    const agreement = await ctx.db.get(args.agreementId);
    if (!agreement || !awaitingCheck(agreement)) return null;
    return { agreement, charters: await chartersBound(ctx, agreement) };
  },
});

/**
 * Internal: settle a kept agreement once its check answered. Kept: it takes effect, with the
 * statement as redacted, and the agreement it supersedes (an edit, or the employee's own one kept
 * for every employee) gives way. Refused: it is stored refused with the clause, and one it would
 * have superseded stays as it was. A change of an agreement retired meanwhile lapses (`dismissed`).
 * Nothing happens to a row that no longer waits on a check (the manager withdrew it meanwhile). Writes `agreement.activated` or `agreement.refused` on the
 * employee whose card or item it came from.
 */
export const settleCheck = internalMutation({
  args: {
    agreementId: v.id('workingAgreements'),
    agentId: v.id('agents'),
    statement: v.string(),
    refusal: v.optional(refusalValidator),
  },
  handler: async (ctx, args): Promise<{ status?: AgreementStatus }> => {
    const row = await ctx.db.get(args.agreementId);
    if (!row || !awaitingCheck(row)) return {};
    const now = Date.now();
    const everyEmployee = row.agentId === undefined;
    const replaced = row.supersedes ? await ctx.db.get(row.supersedes) : null;
    // A change of an agreement the manager retired meanwhile lapses with it, whatever the check says.
    if (row.supersedes && replaced?.status !== 'active') {
      await ctx.db.patch(row._id, { status: 'dismissed' });
      return { status: 'dismissed' };
    }
    if (args.refusal) {
      await ctx.db.patch(row._id, {
        statement: args.statement,
        status: 'refused',
        refusal: { ...args.refusal, judgedAt: now },
      });
      await appendEvent(ctx, {
        agentId: args.agentId,
        type: 'agreement.refused',
        payload: { agreementId: row._id, everyEmployee, ...args.refusal },
        createdAt: now,
      });
      return { status: 'refused' };
    }
    await ctx.db.patch(row._id, {
      statement: args.statement,
      status: 'active',
      effectiveFrom: now,
    });
    if (replaced) {
      await ctx.db.patch(replaced._id, { status: 'superseded', effectiveUntil: now });
    }
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.activated',
      payload: {
        agreementId: row._id,
        everyEmployee,
        approvedVia: row.approvedVia ?? 'agreements-card',
        ...(row.supersedes ? { supersedes: row.supersedes } : {}),
        ...(row.workItemId ? { workItemId: row.workItemId } : {}),
      },
      createdAt: now,
    });
    return { status: 'active' };
  },
});

/**
 * Internal: the active agreements a candidate is planned with, selected in code (8 rows, 2,000
 * characters, newest kept first) from this employee's and every employee's of its owner. The
 * candidate's people (a `person` scope) are the confirmed people its requester and owner resolve to
 * (13-P's `requesterPerson` / `ownerPerson`, read by `itemPersonIds`), so an agreement scoped to
 * one of them applies.
 */
export const selectedForCandidate = internalQuery({
  args: { workItemId: v.id('workItems') },
  handler: async (ctx, args): Promise<Doc<'workingAgreements'>[]> => {
    const item = await ctx.db.get(args.workItemId);
    const agent = item ? await ctx.db.get(item.agentId) : null;
    const userId = agent ? employeeOwnerScope(agent) : undefined;
    if (!item || !agent || userId === undefined) return [];
    const skill = item.skillId ? await ctx.db.get(item.skillId) : null;
    const [rows, personIds] = await Promise.all([
      bindingAgreements(ctx, userId, agent._id, 'active'),
      itemPersonIds(ctx, item, agent),
    ]);
    return selectAgreements(rows, {
      agentId: agent._id,
      sourceSystem: item.sourceSystem,
      ...(skill?.operation ? { operation: skill.operation } : {}),
      personIds,
    });
  },
});

/**
 * Internal: the agreements an approved plan applied, for its executor: the plan's own snapshot, so
 * one retired or superseded after the plan was approved still reaches the run the manager approved
 * with it. Never one of another owner, or of another employee alone.
 */
export const forPlan = internalQuery({
  args: { agentId: v.id('agents'), ids: v.array(v.string()) },
  handler: async (ctx, args): Promise<Doc<'workingAgreements'>[]> => {
    const agent = await ctx.db.get(args.agentId);
    if (!agent) return [];
    const rows: Doc<'workingAgreements'>[] = [];
    for (const raw of args.ids) {
      const id = ctx.db.normalizeId('workingAgreements', raw);
      const row = id ? await ctx.db.get(id) : null;
      if (row && binds(row, agent) && !rows.some((kept) => kept._id === row._id)) rows.push(row);
    }
    return rows;
  },
});

/** The active agreements that bind an employee, newest kept first, for the projection. */
export async function activeAgreementsOf(
  ctx: Pick<QueryCtx, 'db'>,
  agent: Doc<'agents'>,
): Promise<Doc<'workingAgreements'>[]> {
  const userId = employeeOwnerScope(agent);
  if (userId === undefined) return [];
  return (await bindingAgreements(ctx, userId, agent._id, 'active')).sort(
    (left, right) =>
      (right.effectiveFrom ?? right.createdAt) - (left.effectiveFrom ?? left.createdAt),
  );
}

/**
 * An agreement as the cards read it: what they draw, and not the items it was applied to, which
 * change with every plan stored.
 */
function cardViewOf(row: Doc<'workingAgreements'>): AgreementView {
  return {
    _id: row._id,
    ...(row.agentId !== undefined ? { agentId: row.agentId } : {}),
    statement: row.statement,
    status: row.status,
    sourceType: row.sourceType,
    ...(row.correctionIds !== undefined ? { correctionIds: row.correctionIds } : {}),
    ...(row.approvedAt !== undefined ? { approvedAt: row.approvedAt } : {}),
    ...(row.effectiveFrom !== undefined ? { effectiveFrom: row.effectiveFrom } : {}),
    createdAt: row.createdAt,
    ...(row.refusal !== undefined
      ? {
          refusal: {
            reason: row.refusal.reason,
            ...(row.refusal.clause !== undefined ? { clause: row.refusal.clause } : {}),
          },
        }
      : {}),
  };
}

/**
 * The agreements on an employee's cards: its own and every employee's, proposed (with those kept
 * and waiting on their check), active and refused, newest first. Public, guarded by
 * `assertOwnsAgent`; writes nothing.
 */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgreementView[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const userId = employeeOwnerScope(agent);
    if (userId === undefined) return [];
    const standings: AgreementStatus[] = ['proposed', 'active', 'refused'];
    const rows = await Promise.all(
      standings.map(async (status) => await bindingAgreements(ctx, userId, agent._id, status)),
    );
    return rows
      .flat()
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(cardViewOf);
  },
});

/**
 * The agreement a card changes, if the caller owns it and it binds the card's employee. The
 * agreement's guard is the first act, before the employee's.
 */
async function ownedOnCard(
  ctx: MutationCtx,
  agreementId: Id<'workingAgreements'>,
  agentId: Id<'agents'>,
): Promise<{ agreement: Doc<'workingAgreements'>; agent: Doc<'agents'> }> {
  const agreement = await assertOwnsAgreement(ctx, agreementId);
  const agent = await assertOwnsAgent(ctx, agentId);
  if (!binds(agreement, agent)) throw new ConvexError(AGREEMENT_NOT_THIS_EMPLOYEES);
  return { agreement, agent };
}

/** Refuse a change of an active agreement while an earlier change of it waits on its check. */
async function refuseWhileChangeWaits(
  ctx: Pick<QueryCtx, 'db'>,
  agreement: Doc<'workingAgreements'>,
): Promise<void> {
  const waiting = await ctx.db
    .query('workingAgreements')
    .withIndex('by_user_status', (q) => q.eq('userId', agreement.userId).eq('status', 'proposed'))
    .take(AGREEMENTS_READ);
  if (waiting.some((row) => row.supersedes === agreement._id && awaitingCheck(row))) {
    throw new ConvexError(AGREEMENT_CHANGE_WAITING);
  }
}

/** What a replacement of an active agreement changes: whom it binds, its words, the card, when. */
interface Replacement {
  readonly agentId: Id<'agents'> | undefined;
  readonly statement: string;
  readonly via: AgreementApprovedVia;
  readonly now: number;
}

/**
 * A kept replacement of an active agreement, waiting on its check: the same kind and scope, the
 * new binding or words, made on the manager's card, superseding the one it replaces once it passes.
 */
function replacementOf(
  agreement: Doc<'workingAgreements'>,
  replacement: Replacement,
): Omit<Doc<'workingAgreements'>, '_id' | '_creationTime'> {
  return {
    userId: agreement.userId,
    ...(replacement.agentId !== undefined ? { agentId: replacement.agentId } : {}),
    kind: agreement.kind,
    statement: replacement.statement,
    scope: agreement.scope,
    ...(agreement.scopeRef !== undefined ? { scopeRef: agreement.scopeRef } : {}),
    ...(agreement.personId !== undefined ? { personId: agreement.personId } : {}),
    sourceType: 'manager-card',
    sourceRef: agreement._id,
    status: 'proposed',
    supersedes: agreement._id,
    approvedAt: replacement.now,
    approvedVia: replacement.via,
    createdAt: replacement.now,
    appliedTo: [],
  };
}

/**
 * Keep an agreement from a card (A14): a proposal for its employee, or for every employee of the
 * owner (A10); or an employee's own active agreement, now for every employee. The keep is recorded
 * here and the check it schedules makes it active, or refused with the clause; an active one kept
 * for every employee stays in effect for its employee until its every-employee copy passes.
 * Public, guarded by `assertOwnsAgreement` first and the card's employee after. Writes the
 * agreement and schedules its check.
 */
export const keep = mutation({
  args: {
    agreementId: v.id('workingAgreements'),
    agentId: v.id('agents'),
    forEveryEmployee: v.boolean(),
    via: cardValidator,
  },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    const now = Date.now();
    if (agreement.status === 'proposed' && agreement.approvedAt === undefined) {
      await ctx.db.patch(agreement._id, {
        approvedAt: now,
        approvedVia: args.via,
        ...(args.forEveryEmployee ? { agentId: undefined } : {}),
      });
      await scheduleCheck(ctx, agreement._id, args.agentId);
      return { ok: true };
    }
    if (agreement.status === 'active' && agreement.agentId !== undefined && args.forEveryEmployee) {
      await refuseWhileChangeWaits(ctx, agreement);
      const copy = await ctx.db.insert(
        'workingAgreements',
        replacementOf(agreement, {
          agentId: undefined,
          statement: agreement.statement,
          via: args.via,
          now,
        }),
      );
      await scheduleCheck(ctx, copy, args.agentId);
      return { ok: true };
    }
    throw new ConvexError(AGREEMENT_MOVED_ON);
  },
});

/**
 * Change an active agreement's words from the Agreements card: an edit is a supersede, so the new
 * words are kept as a new agreement that replaces the old one once its check passes, and the old
 * one stays in effect if the new words are refused. Public, guarded by `assertOwnsAgreement` first
 * and the card's employee after. Writes the new agreement and schedules its check.
 */
export const edit = mutation({
  args: {
    agreementId: v.id('workingAgreements'),
    agentId: v.id('agents'),
    statement: v.string(),
  },
  handler: async (ctx, args): Promise<{ agreementId: Id<'workingAgreements'> }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    if (agreement.status !== 'active') throw new ConvexError(AGREEMENT_MOVED_ON);
    if (args.statement.replace(/\s+/g, ' ').trim().length > AGREEMENT_STATEMENT_LIMIT) {
      throw new ConvexError(AGREEMENT_STATEMENT_TOO_LONG);
    }
    const statement = agreementStatement(redactTokenShapes(args.statement));
    if (statement === '') throw new ConvexError(AGREEMENT_STATEMENT_EMPTY);
    await refuseWhileChangeWaits(ctx, agreement);
    const now = Date.now();
    const agreementId = await ctx.db.insert(
      'workingAgreements',
      replacementOf(agreement, {
        agentId: agreement.agentId,
        statement,
        via: 'agreements-card',
        now,
      }),
    );
    await scheduleCheck(ctx, agreementId, args.agentId);
    return { agreementId };
  },
});

/**
 * Set a proposal aside ("Not now"), withdraw a keep still waiting on its check, or dismiss a
 * refusal: it is never shown again, never takes effect, and the corrections it came from are never
 * proposed again. Public, guarded by `assertOwnsAgreement`
 * first and the card's employee after. Writes the status and `agreement.retired` (`dismissed`).
 */
export const dismiss = mutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    const open = agreement.status === 'proposed' || agreement.status === 'refused';
    if (!open) throw new ConvexError(AGREEMENT_MOVED_ON);
    await ctx.db.patch(agreement._id, { status: 'dismissed' });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.retired',
      payload: {
        agreementId: agreement._id,
        everyEmployee: agreement.agentId === undefined,
        how: 'dismissed',
      },
      createdAt: Date.now(),
    });
    return { ok: true };
  },
});

/**
 * Retire an active agreement: no later plan reads it. Idempotent for one already retired. Public,
 * guarded by `assertOwnsAgreement` first and the card's employee after. Writes the status, when it
 * stopped, and `agreement.retired`.
 */
export const retire = mutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    if (agreement.status === 'retired') return { ok: true };
    if (agreement.status !== 'active') throw new ConvexError(AGREEMENT_MOVED_ON);
    const now = Date.now();
    await ctx.db.patch(agreement._id, { status: 'retired', effectiveUntil: now });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.retired',
      payload: {
        agreementId: agreement._id,
        everyEmployee: agreement.agentId === undefined,
        how: 'retired',
      },
      createdAt: now,
    });
    return { ok: true };
  },
});
