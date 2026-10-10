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
import { confirmedPersonOf, itemPersonIds } from './itemPeople';
import { SURFACE_MODE } from '../src/lib/surface-mode';
import { redactTokenShapes } from '../src/surfaces/redact';
import { surfaceSlug } from '../src/surfaces/slug';
import {
  agreementStatement,
  selectAgreements,
  type CharterBounds,
  type JudgedCorrection,
} from '../src/work/agreements';
import {
  awaitingCheck,
  awaitingManager,
  HOLD_PAST_THE_CHECK,
  type AgreementView,
} from '../src/work/agreement-words';
import type { ExecutionPlan } from '../src/work/types';
import {
  AGREEMENT_KEEP_REFUSAL_REASONS,
  AGREEMENT_REFUSAL_REASONS,
  AGREEMENT_STATEMENT_LIMIT,
  CHECK_STALE_MS,
  EMPLOYEES_CHECKED,
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

/** The most of an employee's active corrections the sameness judgement reads, newest first. */
export const CORRECTIONS_JUDGED = 20;

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

/**
 * The fewest words a kept note must have: a direction a later plan can follow ("Use UTC."), never a
 * one-word answer ("Yes") (W13-R32).
 */
const AGREEMENT_SENTENCE_WORDS = 2;

/** The refusal of a note kept from the plan approval that is no sentence ("Yes", "Evergreen"). */
export const AGREEMENT_NOT_A_SENTENCE =
  'A working agreement needs a sentence a later plan can follow. A one-word answer such as “Yes” is not one.';

/** The refusal of a plan note kept for a requester intake did not resolve to a confirmed person. */
export const PLAN_NOTE_NO_REQUESTER =
  'This item’s requester is not a person you confirmed, so the note cannot be kept for their asks.';

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
  // An agreement for every employee held for this employee alone binds it no longer (W14-R15).
  const held = status === 'active' ? await heldForEmployee(ctx, userId, agentId) : new Set();
  return [...(own ?? []), ...(everyone ?? []).filter((row) => !held.has(row._id))];
}

/**
 * One employee's holds (W14-R15): its own refused rows that each name an agreement for every
 * employee never checked against its charter. Read by their reason inside the index's range of the
 * employee's refused rows, so however many other refusals it holds, none hides a hold (the read
 * was the newest `AGREEMENTS_READ` refused rows, past which a hold stopped holding). At most one
 * hold stands for an agreement, and at most `AGREEMENTS_READ` agreements for every employee are
 * read as binding.
 */
async function holdsOf(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  agentId: Id<'agents'>,
): Promise<Doc<'workingAgreements'>[]> {
  return await ctx.db
    .query('workingAgreements')
    .withIndex('by_user_agent_status', (q) =>
      q.eq('userId', userId).eq('agentId', agentId).eq('status', 'refused'),
    )
    .filter((q) => q.eq(q.field('refusal.reason'), 'unchecked-for-employee'))
    .take(AGREEMENTS_READ);
}

/** The agreements for every employee held for one employee alone (W14-R15, {@link holdsOf}). */
async function heldForEmployee(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  agentId: Id<'agents'>,
): Promise<Set<Id<'workingAgreements'>>> {
  return new Set(
    (await holdsOf(ctx, userId, agentId)).flatMap((row) =>
      row.supersedes ? [row.supersedes] : [],
    ),
  );
}

/** The agreements for every employee held for an employee, none for one no owner holds. */
async function heldFor(
  ctx: Pick<QueryCtx, 'db'>,
  agent: Doc<'agents'>,
): Promise<Set<Id<'workingAgreements'>>> {
  const scope = employeeOwnerScope(agent);
  return scope === undefined ? new Set() : await heldForEmployee(ctx, scope, agent._id);
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

/** An employee's newest approved charter, or nothing before its first approval. */
async function newestApprovedCharter(
  ctx: Pick<QueryCtx, 'db'>,
  agentId: Id<'agents'>,
): Promise<Doc<'charters'> | undefined> {
  const versions = await ctx.db
    .query('charters')
    .withIndex('by_agent', (q) => q.eq('agentId', agentId))
    .order('desc')
    .take(CHARTER_VERSIONS);
  return versions.find((charter) => charter.approved);
}

/** An employee's newest approved charter's boundaries, or null before its first approval. */
async function approvedBounds(
  ctx: Pick<QueryCtx, 'db'>,
  agent: Doc<'agents'>,
): Promise<CharterBounds | null> {
  const approved = await newestApprovedCharter(ctx, agent._id);
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
 * Whether an owner has more employees than the check of an agreement for every employee reads
 * (W13-R28): such an agreement is refused on its row (`every-employee-too-many`), since it would
 * bind an employee whose charter nobody checked it against.
 */
async function pastTheCheck(ctx: Pick<QueryCtx, 'db'>, userId: string): Promise<boolean> {
  return (await ownerEmployees(ctx, userId, EMPLOYEES_CHECKED + 1)).length > EMPLOYEES_CHECKED;
}

/** The most rows under one user id the employee read scans past other owner scopes (standard 10.4). */
const EMPLOYEE_SCAN_LIMIT = 500;

/**
 * An owner's employees, at most `limit`, read past rows of another owner scope under the same
 * user id rather than counting them (W13-R28: the bound was taken before the filter).
 */
async function ownerEmployees(
  ctx: Pick<QueryCtx, 'db'>,
  userId: string,
  limit: number,
): Promise<Doc<'agents'>[]> {
  const employees: Doc<'agents'>[] = [];
  for (const agent of await ctx.db
    .query('agents')
    .withIndex('by_userId', (q) => q.eq('userId', userId))
    .take(EMPLOYEE_SCAN_LIMIT)) {
    if (employeeOwnerScope(agent) !== userId) continue;
    employees.push(agent);
    if (employees.length >= limit) break;
  }
  return employees;
}

/**
 * The charters an agreement is checked against: its employee's, or, for one that binds every
 * employee, each of the owner's employees' newest approved charter (`keep` refuses an owner with
 * more than `EMPLOYEES_CHECKED`).
 */
async function chartersBound(
  ctx: Pick<QueryCtx, 'db'>,
  row: Doc<'workingAgreements'>,
): Promise<CharterBounds[]> {
  const employees =
    row.agentId !== undefined
      ? [await ctx.db.get(row.agentId)].filter((agent): agent is Doc<'agents'> => agent !== null)
      : await ownerEmployees(ctx, row.userId, EMPLOYEES_CHECKED);
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
 * Refuse a kept agreement for every employee on its row (`every-employee-too-many`, W13-R28), with
 * `agreement.refused` on the employee whose card it was kept on.
 */
async function refuseTooMany(
  ctx: MutationCtx,
  agreementId: Id<'workingAgreements'>,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  const reason = 'every-employee-too-many';
  await ctx.db.patch(agreementId, { status: 'refused', refusal: { reason, judgedAt: now } });
  await appendEvent(ctx, {
    agentId,
    type: 'agreement.refused',
    payload: { agreementId, everyEmployee: true, reason },
    createdAt: now,
  });
}

/**
 * Check a kept agreement, or refuse it at once when it binds every employee of an owner with more
 * employees than the check reads (W13-R28).
 */
async function checkOrRefuse(
  ctx: MutationCtx,
  row: Pick<Doc<'workingAgreements'>, '_id' | 'agentId' | 'userId'>,
  agentId: Id<'agents'>,
  now: number,
): Promise<void> {
  if (row.agentId === undefined && (await pastTheCheck(ctx, row.userId))) {
    await refuseTooMany(ctx, row._id, agentId, now);
    return;
  }
  await scheduleCheck(ctx, row._id, agentId);
}

/** Write a kept replacement and check it, or refuse it at once (`checkOrRefuse`). */
async function keepReplacement(
  ctx: MutationCtx,
  row: Omit<Doc<'workingAgreements'>, '_id' | '_creationTime'>,
  agentId: Id<'agents'>,
): Promise<Id<'workingAgreements'>> {
  const agreementId = await ctx.db.insert('workingAgreements', row);
  await checkOrRefuse(ctx, { ...row, _id: agreementId }, agentId, row.createdAt);
  return agreementId;
}

/** What a kept plan note is kept for: later work of the item's kind, or its requester's asks. */
export type PlanNoteKeptFor = 'kind' | 'requester';

/** What a kept plan note is scoped to: the item's source surface, or its requester. */
type PlanNoteScope =
  | { readonly scope: 'surface'; readonly scopeRef: string }
  | { readonly scope: 'person'; readonly personId: Id<'people'> };

/**
 * The scope a plan note is kept under: the item's source surface for work of its kind, or, for
 * its requester's asks, the confirmed person intake resolved the requester to.
 *
 * @throws ConvexError for a requester who is not an active person of the owner's.
 */
async function planNoteScope(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  userId: string,
  keptFor: PlanNoteKeptFor,
): Promise<PlanNoteScope> {
  if (keptFor === 'kind') return { scope: 'surface', scopeRef: surfaceSlug(row.sourceSystem) };
  const requester = await confirmedPersonOf(ctx, userId, row.requesterPerson);
  if (requester === undefined) throw new ConvexError(PLAN_NOTE_NO_REQUESTER);
  return { scope: 'person', personId: requester._id };
}

/** Whether an agreement is kept under a plan note's scope. */
function underPlanNoteScope(agreement: Doc<'workingAgreements'>, kept: PlanNoteScope): boolean {
  return kept.scope === 'surface'
    ? agreement.scope === 'surface' && agreement.scopeRef === kept.scopeRef
    : agreement.scope === 'person' && agreement.personId === kept.personId;
}

/**
 * Keep the note of a plan approval as a working agreement (the "Keep this note for later work of
 * this kind" tick), in the approval's transaction: for the item's employee, scoped to work on the
 * item's source surface or, kept for the requester (15-FX), to asks from the confirmed person the
 * requester resolved to (a `person` scope, which a Same person merge repoints, W13-R33); kept by
 * the manager on the card (A14) and active once the check that the same click schedules answers.
 * Real mode only: nothing reads an agreement in mock mode. The same note kept again under the same
 * scope keeps the agreement already in force or waiting, rather than a second one.
 *
 * @param ctx - The approval's mutation context.
 * @param row - The plan-pending work item.
 * @param note - The manager's note, as written.
 * @param keptFor - Later work of the item's kind, or later asks from its requester.
 * @returns The kept agreement, or the one already kept for the same note.
 * @throws ConvexError in mock mode, for an employee no owner holds, for a note longer than an
 *   agreement keeps or of fewer than three words (W13-R32), or, kept for the requester, for one
 *   who is not a person the manager confirmed.
 */
export async function keepPlanNoteInTransaction(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
  note: string,
  keptFor: PlanNoteKeptFor = 'kind',
): Promise<Id<'workingAgreements'>> {
  if (SURFACE_MODE !== 'real') throw new ConvexError(AGREEMENTS_REAL_MODE_ONLY);
  const agent = await ctx.db.get(row.agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (!agent || userId === undefined) throw new ConvexError(AGREEMENT_NOT_THIS_EMPLOYEES);
  // Held to what an edit keeps (W13-R32): never cut silently, and a direction, not an answer.
  if (note.replace(/\s+/g, ' ').trim().length > AGREEMENT_STATEMENT_LIMIT) {
    throw new ConvexError(AGREEMENT_STATEMENT_TOO_LONG);
  }
  const statement = agreementStatement(redactTokenShapes(note));
  if (statement === '') throw new ConvexError(AGREEMENT_STATEMENT_EMPTY);
  if (
    statement.split(' ').filter((word) => /\p{L}/u.test(word)).length < AGREEMENT_SENTENCE_WORDS
  ) {
    throw new ConvexError(AGREEMENT_NOT_A_SENTENCE);
  }
  const scope = await planNoteScope(ctx, row, userId, keptFor);
  // The same note kept again keeps the agreement already in force, or already waiting on its check.
  const kept = [
    ...(await bindingAgreements(ctx, userId, row.agentId, 'active')),
    ...(await bindingAgreements(ctx, userId, row.agentId, 'proposed')).filter(awaitingCheck),
  ].find(
    (agreement) =>
      agreement.agentId === row.agentId &&
      agreement.statement === statement &&
      underPlanNoteScope(agreement, scope),
  );
  if (kept) return kept._id;
  const now = Date.now();
  const agreementId = await ctx.db.insert('workingAgreements', {
    userId,
    agentId: row.agentId,
    kind: 'preference',
    statement,
    ...scope,
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
  const held = await heldFor(ctx, agent);
  const kept: Id<'workingAgreements'>[] = [];
  for (const raw of ids) {
    const id = typeof raw === 'string' ? ctx.db.normalizeId('workingAgreements', raw) : null;
    if (!id || kept.includes(id)) continue;
    const agreement = await ctx.db.get(id);
    if (!agreement || agreement.status !== 'active' || !binds(agreement, agent)) continue;
    // Held for this employee since the plan was drafted: its charter was never checked against it.
    if (held.has(id)) continue;
    if (!agreement.appliedTo.includes(row._id)) {
      await ctx.db.patch(id, {
        appliedTo: [...agreement.appliedTo, row._id].slice(-AGREEMENT_APPLIED_KEPT),
      });
    }
    kept.push(id);
  }
  return kept;
}

/**
 * The plan as the manager's approval leaves it (W13-R29): an agreement it applied that was retired,
 * superseded or dismissed between the draft and the approval no longer binds the run the approval
 * starts, so it leaves the plan's `appliedAgreements`.
 *
 * @param ctx - The approval's mutation context.
 * @param row - The work item being approved.
 * @returns The plan to store, or undefined when every agreement it applied still holds.
 */
export async function planAgreementsAtApproval(
  ctx: MutationCtx,
  row: Doc<'workItems'>,
): Promise<ExecutionPlan | undefined> {
  const plan = row.plan as ExecutionPlan | undefined;
  const ids = plan?.appliedAgreements;
  if (plan === undefined || ids === undefined) return undefined;
  const agent = await ctx.db.get(row.agentId);
  const held = agent ? await heldFor(ctx, agent) : new Set<Id<'workingAgreements'>>();
  const inForce: string[] = [];
  for (const raw of ids) {
    const id = ctx.db.normalizeId('workingAgreements', raw);
    const agreement = id ? await ctx.db.get(id) : null;
    // One held for this employee since the draft is not in force for it (the second pass).
    if (agent && id && agreement?.status === 'active' && binds(agreement, agent) && !held.has(id)) {
      inForce.push(raw);
    }
  }
  if (inForce.length === ids.length) return undefined;
  const settled: ExecutionPlan = { ...plan };
  delete settled.appliedAgreements;
  return inForce.length > 0 ? { ...settled, appliedAgreements: inForce } : settled;
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
  await scheduleHoldChecks(ctx, agentId);
}

/**
 * Schedule the check that lifts an employee's holds (W14-R15's lift): each agreement for every
 * employee held for it is checked against its charter once the owner has no more employees than
 * the check reads. Nothing for an employee with no hold, or while the owner is past the bound (no
 * model is asked). Called where the employee's plan is stored; a charter's approval and a resume
 * check every agreement for every employee anyway (`scheduleCharterCheck`). Real mode only.
 *
 * @param ctx - Mutation context.
 * @param agentId - The employee.
 */
async function scheduleHoldChecks(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const agent = await ctx.db.get(agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (userId === undefined) return;
  await scheduleCheckOfHolds(ctx, agentId, await holdsOf(ctx, userId, agentId), Date.now());
}

/**
 * Schedule one check of the agreements an employee's holds name, unless the owner is past the
 * employees the check reads, and stamp each hold as tried now (`refusal.judgedAt`), which is what
 * {@link scheduleDueHoldChecks} reads. A hold whose agreement is in effect for nobody any more
 * (retired, refused by another charter, replaced by an edit) is set aside here, with no check: it
 * holds nothing, and left standing it would be scheduled for ever and count against the holds
 * read (the second pass).
 *
 * @returns Whether a check was scheduled.
 */
async function scheduleCheckOfHolds(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  holds: readonly Doc<'workingAgreements'>[],
  now: number,
): Promise<boolean> {
  const moot = await mootHolds(ctx, holds);
  for (const holdId of moot) await ctx.db.patch(holdId, { status: 'dismissed' });
  const live = holds.filter((hold) => !moot.has(hold._id));
  const first = live[0];
  if (first === undefined || (await pastTheCheck(ctx, first.userId))) return false;
  for (const hold of live) {
    if (hold.refusal) await ctx.db.patch(hold._id, { refusal: { ...hold.refusal, judgedAt: now } });
  }
  await ctx.scheduler.runAfter(0, internal.workingAgreementActions.checkForCharter, {
    agentId,
    attempt: 0,
    agreementIds: live.flatMap((hold) => (hold.supersedes ? [hold.supersedes] : [])),
  });
  return true;
}

/**
 * For the stalled-step sweep (`workLoop.resumeAgentStepsInTransaction`): schedule the check of an
 * employee's holds not tried within `CHECK_STALE_MS`, so a hold written while the work was paused
 * is lifted after the pause ends, whether or not the employee itself was resumed (the pause of a
 * whole deployment resumes none by name: 14-FX's recorded gap). One check a stale window, however
 * often the sweep runs. Real mode only.
 *
 * @param ctx - The sweep's mutation context.
 * @param agentId - The employee.
 * @param now - The sweep's time.
 * @returns How many checks it scheduled: one or none.
 */
export async function scheduleDueHoldChecks(
  ctx: MutationCtx,
  agentId: Id<'agents'>,
  now: number,
): Promise<number> {
  if (SURFACE_MODE !== 'real') return 0;
  const agent = await ctx.db.get(agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (userId === undefined) return 0;
  const due = (await holdsOf(ctx, userId, agentId)).filter(
    (hold) => (hold.refusal?.judgedAt ?? 0) <= now - CHECK_STALE_MS,
  );
  return (await scheduleCheckOfHolds(ctx, agentId, due, now)) ? 1 : 0;
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

/** A refusal a check settles: the judgement's, or the keep's past the employees it reads. */
const settledRefusalValidator = v.object({
  reason: v.union(
    ...AGREEMENT_REFUSAL_REASONS.map((reason) => v.literal(reason)),
    ...AGREEMENT_KEEP_REFUSAL_REASONS.map((reason) => v.literal(reason)),
  ),
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

/**
 * What the check of a kept agreement reads: the row and the charters it would bind, and whether
 * it binds every employee of an owner with more employees than the check reads (hired since the
 * keep, W13-R28), which refuses it with no judgement.
 */
export interface CheckInputs {
  readonly agreement: Doc<'workingAgreements'>;
  readonly charters: readonly CharterBounds[];
  readonly pastTheCheck: boolean;
}

/** Internal: what the check of a kept agreement reads, or null once it no longer waits on one. */
export const checkInputs = internalQuery({
  args: { agreementId: v.id('workingAgreements') },
  handler: async (ctx, args): Promise<CheckInputs | null> => {
    const agreement = await ctx.db.get(args.agreementId);
    if (!agreement || !awaitingCheck(agreement)) return null;
    const [charters, past] = await Promise.all([
      chartersBound(ctx, agreement),
      agreement.agentId === undefined ? pastTheCheck(ctx, agreement.userId) : false,
    ]);
    return { agreement, charters, pastTheCheck: past };
  },
});

/** What the check of a newly approved charter against the owner's every-employee agreements reads. */
export interface CharterCheckInputs {
  readonly userId: string;
  /** The employee's approved charter's boundaries. */
  readonly charter: CharterBounds;
  /** The owner's active agreements for every employee, newest first. */
  readonly agreements: readonly Doc<'workingAgreements'>[];
  /** Whether the owner now has more employees than an every-employee check reads (W13-R28). */
  readonly pastTheCheck: boolean;
  /** The agreements held for this employee: one the check allows is lifted (`liftHold`). */
  readonly held: readonly Id<'workingAgreements'>[];
}

/**
 * Internal: what the check of an employee's newly approved charter against its owner's agreements
 * for every employee reads (13-W's gap: an employee hired after such an agreement was never checked
 * against it), or null for an employee no owner holds, with no approved charter, or with no such
 * agreement to check.
 */
export const charterCheckInputs = internalQuery({
  args: {
    agentId: v.id('agents'),
    /** Only these agreements, a retry's; absent, every active one for every employee. */
    agreementIds: v.optional(v.array(v.id('workingAgreements'))),
  },
  handler: async (ctx, args): Promise<CharterCheckInputs | null> => {
    const agent = await ctx.db.get(args.agentId);
    const userId = agent ? employeeOwnerScope(agent) : undefined;
    if (!agent || userId === undefined) return null;
    const [charter, agreements, past, held] = await Promise.all([
      approvedBounds(ctx, agent),
      ctx.db
        .query('workingAgreements')
        .withIndex('by_user_agent_status', (q) =>
          q.eq('userId', userId).eq('agentId', undefined).eq('status', 'active'),
        )
        .order('desc')
        .take(AGREEMENTS_READ),
      pastTheCheck(ctx, userId),
      heldForEmployee(ctx, userId, agent._id),
    ]);
    const asked =
      args.agreementIds === undefined
        ? agreements
        : agreements.filter((row) => args.agreementIds?.includes(row._id) === true);
    if (charter === null || asked.length === 0) return null;
    return { userId, charter, agreements: asked, pastTheCheck: past, held: [...held] };
  },
});

/**
 * Internal: refuse an active agreement for every employee that a newly approved charter's check
 * refused (13-W's gap), on its row, with the clause or the reason: it stops binding every employee
 * from now, as a keep refused against that charter would never have started. Nothing for a row no
 * longer active or no longer for every employee. Writes `agreement.refused` on the employee whose
 * charter was approved.
 */
export const settleCharterCheck = internalMutation({
  args: {
    agreementId: v.id('workingAgreements'),
    agentId: v.id('agents'),
    refusal: settledRefusalValidator,
  },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.agreementId);
    if (!row || row.status !== 'active' || row.agentId !== undefined) return null;
    const now = Date.now();
    await ctx.db.patch(row._id, {
      status: 'refused',
      effectiveUntil: now,
      refusal: { ...args.refusal, judgedAt: now },
    });
    // A hold of it for this employee holds nothing now: the agreement binds nobody.
    const hold = await holdOf(ctx, row, args.agentId);
    if (hold !== undefined) await ctx.db.patch(hold._id, { status: 'dismissed' });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.refused',
      payload: { agreementId: row._id, everyEmployee: true, ...args.refusal },
      createdAt: now,
    });
    return null;
  },
});

/** One employee's hold of one agreement for every employee, if it stands. */
async function holdOf(
  ctx: Pick<QueryCtx, 'db'>,
  agreement: Doc<'workingAgreements'>,
  agentId: Id<'agents'>,
): Promise<Doc<'workingAgreements'> | undefined> {
  return (await holdsOf(ctx, agreement.userId, agentId)).find(
    (row) => row.supersedes === agreement._id,
  );
}

/**
 * Internal: hold an active agreement for every employee for one employee alone, whose newly
 * approved charter it was never checked against: the charter came past the employees the check
 * reads (W14-R15), or the check could not be had after its last retry (15-FX: it fails closed,
 * where it left the agreement binding unchecked). The agreement stays in effect for every other
 * employee, and this employee's own refused row, which names it, takes it out of what this
 * employee's planner and runs read, until a check that can be had lifts it (`liftHold`). Nothing
 * for a row no longer active or no longer for every employee, or one already held for the
 * employee. Writes `agreement.refused` on the employee.
 */
export const holdForEmployee = internalMutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.agreementId);
    if (!row || row.status !== 'active' || row.agentId !== undefined) return null;
    if ((await heldForEmployee(ctx, row.userId, args.agentId)).has(row._id)) return null;
    const now = Date.now();
    const reason = 'unchecked-for-employee';
    const heldId = await ctx.db.insert('workingAgreements', {
      userId: row.userId,
      agentId: args.agentId,
      kind: row.kind,
      statement: row.statement,
      scope: row.scope,
      ...(row.scopeRef !== undefined ? { scopeRef: row.scopeRef } : {}),
      ...(row.personId !== undefined ? { personId: row.personId } : {}),
      sourceType: row.sourceType,
      status: 'refused',
      refusal: { reason, judgedAt: now },
      supersedes: row._id,
      createdAt: now,
      appliedTo: [],
    });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.refused',
      payload: { agreementId: heldId, everyEmployee: true, reason },
      createdAt: now,
    });
    return null;
  },
});

/**
 * Internal: lift one employee's hold of an agreement for every employee, once a check against its
 * charter allowed it (W14-R15's lift): the hold is set aside (`dismissed`) and the agreement binds
 * the employee from now. Nothing when no hold stands, or the agreement is no longer active for
 * every employee. Writes `agreement.activated` (`afterHold`) on the employee.
 */
export const liftHold = internalMutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<null> => {
    const row = await ctx.db.get(args.agreementId);
    if (!row || row.status !== 'active' || row.agentId !== undefined) return null;
    const hold = await holdOf(ctx, row, args.agentId);
    if (hold === undefined) return null;
    const now = Date.now();
    await ctx.db.patch(hold._id, { status: 'dismissed' });
    await appendEvent(ctx, {
      agentId: args.agentId,
      type: 'agreement.activated',
      payload: {
        agreementId: row._id,
        everyEmployee: true,
        approvedVia: row.approvedVia ?? 'agreements-card',
        afterHold: true,
      },
      createdAt: now,
    });
    return null;
  },
});

/**
 * Schedule again, as the employee is resumed, every check its pause held (the first pre-tag's item
 * for wave 14): each kept agreement still waiting on its check that binds the employee, and the
 * check of its charter against the owner's agreements for every employee. A check the pause held
 * spent no retry, so it starts from its first. Real mode only, as a pause is.
 *
 * @param ctx - The resume's mutation context.
 * @param agentId - The employee resumed.
 */
export async function scheduleHeldChecks(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const agent = await ctx.db.get(agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (!agent || userId === undefined) return;
  const waiting = (await bindingAgreements(ctx, userId, agentId, 'proposed')).filter(awaitingCheck);
  for (const row of waiting) await scheduleCheck(ctx, row._id, agentId);
  await scheduleCharterCheck(ctx, agentId);
}

/**
 * Schedule the check of an employee's newly approved charter against its owner's agreements for
 * every employee (13-W's gap), in the approval's transaction, when the owner has one. Real mode
 * only: no agreement is kept in mock mode.
 */
export async function scheduleCharterCheck(ctx: MutationCtx, agentId: Id<'agents'>): Promise<void> {
  if (SURFACE_MODE !== 'real') return;
  const agent = await ctx.db.get(agentId);
  const userId = agent ? employeeOwnerScope(agent) : undefined;
  if (userId === undefined) return;
  // An owner with no agreement for every employee has nothing to check the charter against.
  const everyone = await ctx.db
    .query('workingAgreements')
    .withIndex('by_user_agent_status', (q) =>
      q.eq('userId', userId).eq('agentId', undefined).eq('status', 'active'),
    )
    .first();
  if (everyone === null) return;
  await ctx.scheduler.runAfter(0, internal.workingAgreementActions.checkForCharter, {
    agentId,
    attempt: 0,
  });
}

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
    refusal: v.optional(settledRefusalValidator),
  },
  handler: async (ctx, args): Promise<{ status?: AgreementStatus }> => {
    const row = await ctx.db.get(args.agreementId);
    if (!row || !awaitingCheck(row)) return {};
    const now = Date.now();
    const everyEmployee = row.agentId === undefined;
    const replaced = row.supersedes ? await ctx.db.get(row.supersedes) : null;
    // A change of an agreement the manager retired meanwhile lapses with it, whatever the check says;
    // an every-employee copy of a proposal lapses only once the proposal is set aside (W13-R31).
    const stands =
      replaced !== null && (replaced.status === 'active' || replaced.status === 'proposed');
    if (row.supersedes && !stands) {
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
      await ctx.db.patch(replaced._id, {
        status: 'superseded',
        ...(replaced.status === 'active' ? { effectiveUntil: now } : {}),
      });
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
    if (everyEmployee) await checkChartersApprovedSince(ctx, row);
    return { status: 'active' };
  },
});

/**
 * Check an agreement for every employee, as it takes effect, against each charter approved since
 * the manager kept it (W14-R57): its own check may have read the charters before that approval,
 * and the approval's check reads active agreements only, so neither had checked the pair.
 */
async function checkChartersApprovedSince(
  ctx: MutationCtx,
  row: Doc<'workingAgreements'>,
): Promise<void> {
  const since = row.approvedAt ?? row.createdAt;
  for (const employee of await ownerEmployees(ctx, row.userId, EMPLOYEES_CHECKED)) {
    const charter = await newestApprovedCharter(ctx, employee._id);
    if (charter === undefined || (charter.approvedAt ?? charter.createdAt) < since) continue;
    await ctx.scheduler.runAfter(0, internal.workingAgreementActions.checkForCharter, {
      agentId: employee._id,
      attempt: 0,
      agreementIds: [row._id],
    });
  }
}

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
function cardViewOf(row: Doc<'workingAgreements'>, checkable = false): AgreementView {
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
            ...(checkable ? { checkable: true } : {}),
          },
        }
      : {}),
  };
}

/**
 * The agreements on an employee's cards: its own and every employee's, proposed (with those kept
 * and waiting on their check, and without a proposal whose every-employee copy waits on its
 * check), active and refused, newest first. A hold of an agreement for every employee says
 * whether it can be checked now (`refusal.checkable`: the owner has no more employees than the
 * check reads), and one whose agreement is in effect for nobody any more is left out. Public,
 * guarded by `assertOwnsAgent`; writes nothing.
 */
export const listForAgent = query({
  args: { agentId: v.id('agents') },
  handler: async (ctx, args): Promise<AgreementView[]> => {
    const agent = await assertOwnsAgent(ctx, args.agentId);
    const userId = employeeOwnerScope(agent);
    if (userId === undefined) return [];
    const standings: AgreementStatus[] = ['proposed', 'active', 'refused'];
    const rows = (
      await Promise.all(
        standings.map(async (status) => await bindingAgreements(ctx, userId, agent._id, status)),
      )
    ).flat();
    // A proposal kept for every employee is drawn as its copy while the copy's check runs, rather
    // than asked about again beside it (W13-R31).
    const copied = new Set(
      rows.flatMap((row) => (awaitingCheck(row) && row.supersedes ? [row.supersedes] : [])),
    );
    const holds = rows.filter((row) => row.refusal?.reason === 'unchecked-for-employee');
    const [checkable, moot] = await Promise.all([
      holds.length === 0 ? false : pastTheCheck(ctx, userId).then((past) => !past),
      mootHolds(ctx, holds),
    ]);
    return rows
      .filter((row) => !(awaitingManager(row) && copied.has(row._id)) && !moot.has(row._id))
      .sort((left, right) => right.createdAt - left.createdAt)
      .map((row) => cardViewOf(row, checkable && holds.includes(row)));
  },
});

/** The holds whose agreement for every employee is no longer in effect, so they hold nothing. */
async function mootHolds(
  ctx: Pick<QueryCtx, 'db'>,
  holds: readonly Doc<'workingAgreements'>[],
): Promise<Set<Id<'workingAgreements'>>> {
  const held = await Promise.all(
    holds.map(async (hold) => (hold.supersedes ? await ctx.db.get(hold.supersedes) : null)),
  );
  return new Set(
    holds
      .filter((_, index) => held[index]?.status !== 'active' || held[index]?.agentId !== undefined)
      .map((hold) => hold._id),
  );
}

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
 * It carries the corrections the agreement came from, so once it is in effect the planner reads
 * them as the agreement and not again beside it (W13-R5).
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
    ...(agreement.correctionIds !== undefined
      ? { correctionIds: [...agreement.correctionIds] }
      : {}),
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
 * Keep, for one employee alone, an agreement whose keep for every employee was refused past the
 * bound (W14-R15): a new agreement of that employee's own with the same words, kind and scope,
 * checked against its charter. The refused row stays, for the other employees' cards. Kept again
 * for the same employee, the one already in force or waiting on its check stands.
 */
async function keepForOneEmployee(
  ctx: MutationCtx,
  refused: Doc<'workingAgreements'>,
  kept: {
    readonly agentId: Id<'agents'>;
    readonly via: AgreementApprovedVia;
    readonly now: number;
  },
): Promise<void> {
  const own = [
    ...(await bindingAgreements(ctx, refused.userId, kept.agentId, 'active')),
    ...(await bindingAgreements(ctx, refused.userId, kept.agentId, 'proposed')).filter(
      awaitingCheck,
    ),
  ];
  const already = own.some(
    (row) =>
      row.agentId === kept.agentId &&
      row.statement === refused.statement &&
      row.scope === refused.scope &&
      row.scopeRef === refused.scopeRef &&
      row.personId === refused.personId,
  );
  if (already) return;
  // No `supersedes`: the refused row was never in effect, and a change of a row that does not
  // stand lapses at its check (`settleCheck`).
  const agreementId = await ctx.db.insert('workingAgreements', {
    ...replacementOf(refused, {
      agentId: kept.agentId,
      statement: refused.statement,
      via: kept.via,
      now: kept.now,
    }),
    supersedes: undefined,
  });
  await scheduleCheck(ctx, agreementId, kept.agentId);
}

/**
 * Keep an agreement from a card (A14): a proposal for its employee, or for every employee of the
 * owner (A10); or an employee's own active agreement, now for every employee. The keep is recorded
 * here and the check it schedules makes it active, or refused with the clause; an active one kept
 * for every employee stays in effect for its employee until its every-employee copy passes. A
 * keep for every employee refused past the bound (`every-employee-too-many`) is kept for the
 * card's employee alone (the control behind "You can keep it for a single employee instead",
 * W14-R15). Public, guarded by `assertOwnsAgreement` first and the card's employee after. Writes
 * the agreement and schedules its check.
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
    const ownEmployees = agreement.agentId !== undefined;
    if (agreement.refusal?.reason === 'every-employee-too-many' && !args.forEveryEmployee) {
      if (agreement.status !== 'refused') throw new ConvexError(AGREEMENT_MOVED_ON);
      await keepForOneEmployee(ctx, agreement, { agentId: args.agentId, via: args.via, now });
      return { ok: true };
    }
    if (awaitingManager(agreement) && !(args.forEveryEmployee && ownEmployees)) {
      await ctx.db.patch(agreement._id, { approvedAt: now, approvedVia: args.via });
      await checkOrRefuse(ctx, agreement, args.agentId, now);
      return { ok: true };
    }
    // An employee's own proposal or agreement kept for every employee is a copy for every
    // employee, as an edit is (W13-R31): the employee's own stays until the copy passes, so a
    // copy refused leaves it for its employee.
    const ownOpen = awaitingManager(agreement) || agreement.status === 'active';
    if (ownOpen && ownEmployees && args.forEveryEmployee) {
      await refuseWhileChangeWaits(ctx, agreement);
      await keepReplacement(
        ctx,
        replacementOf(agreement, {
          agentId: undefined,
          statement: agreement.statement,
          via: args.via,
          now,
        }),
        args.agentId,
      );
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
    const agreementId = await keepReplacement(
      ctx,
      replacementOf(agreement, {
        agentId: agreement.agentId,
        statement,
        via: 'agreements-card',
        now,
      }),
      args.agentId,
    );
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
    // A hold for one employee is not a refusal to set aside: dismissed, the agreement for every
    // employee would bind that employee unchecked (the second pass on W14-R15).
    const held = agreement.refusal?.reason === 'unchecked-for-employee';
    if (!open || held) throw new ConvexError(AGREEMENT_MOVED_ON);
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
 * Try the check of a kept agreement again from a card (W13-R30): one whose check could not be had,
 * whose card says so once it is stale; or check an agreement for every employee held for the
 * card's employee against its charter (W14-R15's lift), refused while the owner has more employees
 * than the check reads. Public, guarded by `assertOwnsAgreement` first and the card's employee
 * after; refused for one neither waiting on its check nor a hold. Schedules the check.
 */
export const recheck = mutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    const hold =
      agreement.status === 'refused' && agreement.refusal?.reason === 'unchecked-for-employee';
    if (hold && agreement.supersedes !== undefined) {
      if (await pastTheCheck(ctx, agreement.userId)) throw new ConvexError(HOLD_PAST_THE_CHECK);
      await ctx.scheduler.runAfter(0, internal.workingAgreementActions.checkForCharter, {
        agentId: args.agentId,
        attempt: 0,
        agreementIds: [agreement.supersedes],
      });
      return { ok: true };
    }
    if (!awaitingCheck(agreement)) throw new ConvexError(AGREEMENT_MOVED_ON);
    await scheduleCheck(ctx, agreement._id, args.agentId);
    return { ok: true };
  },
});

/**
 * Retire the corrections a retired agreement came from, each as the Corrections panel's Retire
 * does, so no later plan reads the same words as a correction (W13-R5). A correction already
 * retired, gone, or of another owner's employee is left as it is.
 */
async function retireSourceCorrections(
  ctx: MutationCtx,
  agreement: Doc<'workingAgreements'>,
  now: number,
): Promise<void> {
  for (const correctionId of agreement.correctionIds ?? []) {
    const correction = await ctx.db.get(correctionId);
    if (correction === null || correction.retiredAt !== undefined) continue;
    const employee = await ctx.db.get(correction.agentId);
    if (employee === null || employeeOwnerScope(employee) !== agreement.userId) continue;
    await ctx.db.patch(correction._id, { retiredAt: now });
    await appendEvent(ctx, {
      agentId: correction.agentId,
      type: 'work.correction-retired',
      payload: { correctionId: correction._id, workItemId: correction.workItemId },
      createdAt: now,
    });
  }
}

/**
 * Retire an active agreement: no later plan reads it, nor the corrections it came from. Idempotent
 * for one already retired. Public, guarded by `assertOwnsAgreement` first and the card's employee
 * after. Writes the status, when it stopped, `agreement.retired`, and each source correction's
 * `retiredAt` with its `work.correction-retired`.
 */
export const retire = mutation({
  args: { agreementId: v.id('workingAgreements'), agentId: v.id('agents') },
  handler: async (ctx, args): Promise<{ ok: true }> => {
    const { agreement } = await ownedOnCard(ctx, args.agreementId, args.agentId);
    if (agreement.status === 'retired') return { ok: true };
    if (agreement.status !== 'active') throw new ConvexError(AGREEMENT_MOVED_ON);
    const now = Date.now();
    await ctx.db.patch(agreement._id, { status: 'retired', effectiveUntil: now });
    await retireSourceCorrections(ctx, agreement, now);
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
