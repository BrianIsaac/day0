import { ConvexError } from 'convex/values';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './_generated/server';
import { eventsOfType } from './eventLog';
import { acceptingTransferOf } from './transferInFlight';
import { clippedEmployeeName } from '../src/agent/employee-name';
import {
  isTransferDue,
  openTransferRefusal,
  OPEN_MANAGER_TRANSFER_STATES,
} from '../src/agent/manager-transfer';

/*
 * The fences a handover puts round an employee in real mode (the transfer plan, sections 6 and
 * 10.4; the wave 9 review's M5, U3-m2, U3-m3 and U5-m4). Two rules decide them: nothing of the old
 * owner's that the employee does not need becomes readable or usable by the new one, and the
 * old manager widens nothing once the new one has accepted. So a write an action prepared under
 * one owner is refused once the employee has another (a credential of the old owner's, a read
 * made with the old owner's token), and the old manager's grants of authority are refused while
 * the acceptance waits for the runs in flight. This module imports nothing of the move's or the
 * loop's, so every writer it fences can import it (standard 10.2).
 */

/**
 * Why a credential is not bound to the employee: it is not its current owner's. A credential
 * row is its owner's (the ciphertext's associated data names them), and the decrypt opens it by
 * that owner alone, so a binding to another owner's row would let this employee act through it.
 */
export const CREDENTIAL_NOT_THE_OWNERS =
  'This credential belongs to a manager this employee no longer reports to, so it was not attached.';

/**
 * Why a credential would not be bound to the employee, or null when it may be: the row must
 * exist and belong to the employee's owner as the caller's transaction reads it. An action that
 * stored or resolved the credential under the owner it started with, and writes after a handover
 * moved the employee, meets this.
 *
 * @param db - The writer's reader.
 * @param agentId - The employee the credential would serve.
 * @param credentialId - The credential to bind.
 * @returns The refusal's words, or null.
 */
export async function credentialOwnerRefusal(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  credentialId: Id<'credentials'>,
): Promise<string | null> {
  const [agent, credential] = await Promise.all([db.get(agentId), db.get(credentialId)]);
  if (agent === null || credential === null || agent.userId === undefined) {
    return CREDENTIAL_NOT_THE_OWNERS;
  }
  return credential.userId === agent.userId ? null : CREDENTIAL_NOT_THE_OWNERS;
}

/**
 * Refuse to bind a credential that is not the employee's current owner's
 * ({@link credentialOwnerRefusal}).
 *
 * @throws ConvexError with {@link CREDENTIAL_NOT_THE_OWNERS}.
 */
export async function assertCredentialOfOwner(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  credentialId: Id<'credentials'>,
): Promise<void> {
  const refusal = await credentialOwnerRefusal(db, agentId, credentialId);
  if (refusal !== null) throw new ConvexError(refusal);
}

/**
 * Whether the employee changed hands after an instant: a `manager.transferred` event, which the
 * move appends in its own transaction, was written since. The fence for a write whose work began
 * at that instant under the owner the employee had then; one indexed read.
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 * @param since - When the work the write belongs to began.
 */
export async function handedOverSince(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  since: number,
): Promise<boolean> {
  const moved = await eventsOfType({ db }, agentId, 'manager.transferred', {
    after: since,
  }).first();
  return moved !== null;
}

/**
 * The employee's open request, as both managers' screens read it: an `accepting` one, or an
 * `asked` one not yet past its expiry. At most one is open (`MAX_OPEN_TRANSFERS_PER_EMPLOYEE`).
 *
 * @param db - Any reader.
 * @param agentId - The employee.
 * @param now - The instant expiry is judged against.
 */
export async function openTransferOf(
  db: QueryCtx['db'],
  agentId: Id<'agents'>,
  now: number,
): Promise<Doc<'managerTransfers'> | null> {
  for (const state of OPEN_MANAGER_TRANSFER_STATES) {
    const open = await db
      .query('managerTransfers')
      .withIndex('by_agent_state', (q) => q.eq('agentId', agentId).eq('state', state))
      .first();
    if (open !== null && !isTransferDue(open, now)) return open;
  }
  return null;
}

/**
 * Refuse a grant of authority while the new manager's acceptance waits for the runs in flight
 * (U3-m3): a scope, a skill's approval and the autonomy switch would all move with the employee
 * after the new manager's preview, and a run already executing would apply under them. In the
 * words of an accepted handover, as a second ask meets them.
 *
 * @param db - The writer's reader.
 * @param agent - The employee.
 * @throws ConvexError with {@link openTransferRefusal}'s words for an accepting request.
 */
export async function assertNotBeingHandedOver(
  db: QueryCtx['db'],
  agent: Pick<Doc<'agents'>, '_id' | 'name'>,
): Promise<void> {
  const accepting = await acceptingTransferOf(db, agent._id);
  if (accepting === null) return;
  throw new ConvexError(
    openTransferRefusal(clippedEmployeeName(agent.name), accepting.toAddress, 'accepting'),
  );
}

/**
 * Refuse a change to the employee's manager while a handover of it is open (U5-m4): the request
 * names who the employee goes to, and the move would overwrite what the change wrote. In the
 * open request's own terms, as a second ask meets them.
 *
 * @param db - The writer's reader.
 * @param agent - The employee.
 * @param now - The instant expiry is judged against.
 * @throws ConvexError with {@link openTransferRefusal}'s words for the open request.
 */
export async function assertNoHandoverOpen(
  db: QueryCtx['db'],
  agent: Pick<Doc<'agents'>, '_id' | 'name'>,
  now: number,
): Promise<void> {
  const open = await openTransferOf(db, agent._id, now);
  if (open === null) return;
  throw new ConvexError(
    openTransferRefusal(
      clippedEmployeeName(agent.name),
      open.toAddress,
      open.state === 'accepting' ? 'accepting' : 'asked',
    ),
  );
}
