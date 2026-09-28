import type { UserIdentity } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx, ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import { CUSTOMER_OIDC_ISSUER_VAR } from '../src/lib/customer-oidc';
import { DEV_NO_AUTH_SESSION_CLAIM } from '../src/lib/dev-auth-issuer';
import { notAuthenticatedMessage } from './devAuth';

/**
 * Per-account ownership guards. Every public query/mutation/action that
 * touches a per-agent row calls one of these. Internal functions skip the
 * check - they're only callable from other Convex functions, which have
 * already verified the caller.
 *
 * `getCaller` is the single place a caller's identity enters the backend. Every
 * caller presents a verified token, from the local issuer, the customer's OIDC
 * issuer or Clerk (see `convex/auth.config.ts`); the owner key below is what
 * keeps two issuers from ever naming one owner.
 */

/** An issuer URL compared the way two spellings of one issuer should compare. */
function issuerKey(issuer: string): string {
  return issuer.trim().replace(/\/+$/, '');
}

/**
 * The key a caller's rows are stored under and checked against.
 *
 * A subject is unique only within its issuer, so a deployment that accepts two
 * issuers must not key rows on the subject alone: a customer token whose `sub`
 * is `dev-no-auth|local-boss` would otherwise own the local boss's rows. The
 * customer issuer's callers are keyed on `tokenIdentifier` (issuer and subject
 * together). The local issuer and Clerk keep the bare subject, since every row
 * from before a second issuer existed is keyed on it, and neither shares a
 * deployment with the other (Clerk is declared only when neither of the other
 * two is).
 *
 * @param identity - The verified token's identity.
 * @returns The owner key.
 */
export function ownerKeyOf(identity: UserIdentity): string {
  const customer = process.env[CUSTOMER_OIDC_ISSUER_VAR];
  if (customer && issuerKey(customer) === issuerKey(identity.issuer)) {
    return identity.tokenIdentifier;
  }
  return identity.subject;
}

/**
 * The browser session a caller's token was minted for, when its issuer names
 * one in `sid` (the local issuer, and OIDC issuers that follow the session
 * management claims), so a ledger can tell two browsers of one owner apart.
 *
 * @param identity - The caller's identity.
 * @returns The session id, or undefined when the token carries none.
 */
export function callerSessionId(identity: UserIdentity): string | undefined {
  const session = identity[DEV_NO_AUTH_SESSION_CLAIM];
  return typeof session === 'string' && session !== '' ? session : undefined;
}

/**
 * A verified caller: the token's own claims, `subject` included, plus the
 * owner key every guard compares and every row is keyed on ({@link ownerKeyOf}).
 */
export interface Caller extends UserIdentity {
  readonly ownerKey: string;
}

/** The verified caller, or null for an anonymous one. */
export async function getCaller(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller | null> {
  const identity = await ctx.auth.getUserIdentity();
  return identity && { ...identity, ownerKey: ownerKeyOf(identity) };
}

/** The verified caller; throws the mode's not-authenticated message for an anonymous one. */
export async function getCallerOrThrow(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller> {
  const identity = await getCaller(ctx);
  if (!identity) throw new Error(notAuthenticatedMessage());
  return identity;
}

/** The employee, if the caller owns it; throws otherwise. The guard for a row keyed by agent id; the four below cover rows keyed otherwise. */
export async function assertOwnsAgent(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.ownerKey) throw new Error('forbidden');
  return agent;
}

/** The employee, if the caller owns it, for an action that has no database handle. */
export async function assertOwnsAgentAction(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.runQuery(internal.agents.getInternal, { agentId });
  if (!agent) throw new Error('agent not found');
  if (!agent.userId) throw new Error('forbidden: agent has no owner');
  if (agent.userId !== identity.ownerKey) throw new Error('forbidden');
  return agent;
}

/** The charter, if the caller owns its employee; throws otherwise. */
export async function assertOwnsCharter(
  ctx: QueryCtx | MutationCtx,
  charterId: Id<'charters'>,
): Promise<Doc<'charters'>> {
  const charter = await ctx.db.get(charterId);
  if (!charter) throw new Error('charter not found');
  await assertOwnsAgent(ctx, charter.agentId);
  return charter;
}

/** The work item, if the caller owns its employee; throws otherwise. */
export async function assertOwnsWorkItem(
  ctx: QueryCtx | MutationCtx,
  workItemId: Id<'workItems'>,
): Promise<Doc<'workItems'>> {
  const item = await ctx.db.get(workItemId);
  if (!item) throw new Error('work item not found');
  await assertOwnsAgent(ctx, item.agentId);
  return item;
}

/** The skill, if the caller owns its employee; throws otherwise. */
export async function assertOwnsSkill(
  ctx: QueryCtx | MutationCtx,
  skillId: Id<'skills'>,
): Promise<Doc<'skills'>> {
  const skill = await ctx.db.get(skillId);
  if (!skill) throw new Error('skill not found');
  await assertOwnsAgent(ctx, skill.agentId);
  return skill;
}

/** The voice session, if the caller owns its employee; throws otherwise. */
export async function assertOwnsVoiceSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<'voiceSessions'>,
): Promise<Doc<'voiceSessions'>> {
  const session = await ctx.db.get(sessionId);
  if (!session) throw new Error('voice session not found');
  await assertOwnsAgent(ctx, session.agentId);
  return session;
}
