import { ConvexError } from 'convex/values';
import type { UserIdentity } from 'convex/server';
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx, MutationCtx, ActionCtx } from './_generated/server';
import { internal } from './_generated/api';
import {
  CHARTER_NOT_YOURS,
  EMPLOYEE_GONE,
  EMPLOYEE_NOT_YOURS,
  ONE_TO_ONE_NOT_YOURS,
  SKILL_NOT_YOURS,
  SURFACE_NOT_YOURS,
  WORK_ITEM_NOT_YOURS,
} from '../src/agent/employee-access';
import {
  CUSTOMER_OIDC_ISSUER_VAR,
  customerAddressVerified,
  customerOidcAllowedDomains,
  customerOidcEmailTrusted,
  emailVerifiedClaim,
  issuerKey,
  signInRefusal,
  type CallerRefusal,
} from '../src/lib/customer-oidc';
import { providerOfIssuer } from '../src/lib/customer-oidc-presets';
import { DEV_NO_AUTH_ISSUER, DEV_NO_AUTH_SESSION_CLAIM } from '../src/lib/dev-auth-issuer';
import type { EnvReader } from '../src/lib/hosted-markers';
import { normaliseManagerAddress, sameManagerAddress } from '../src/agent/manager-address';
import {
  LOCAL_DEV_TRANSFER_REFUSAL,
  OWN_TRANSFER,
  TRANSFER_NOT_FOUND,
  UNVERIFIED_FOR_TRANSFER,
} from '../src/agent/manager-transfer';
import {
  deploymentAdministrators,
  isAdministratorAddress,
  NOT_AN_ADMINISTRATOR,
} from '../src/lib/administrators';
import { isOrganisationOwnerKey } from '../src/lib/organisation-key';
import { PERSON_NOT_YOURS, RELATIONSHIP_NOT_YOURS } from '../src/people/vocabulary';
import { AGREEMENT_NOT_YOURS } from '../src/work/agreement-vocabulary';
import { resolveDeploymentProfile } from '../src/lib/surface-mode';
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
 *
 * The anonymous-caller guard (wave 12, 12-G; P9-4): a public function's first act is one of these
 * guards, or `getCallerOrThrow` itself, before it reads a row, checks the deployment's mode or
 * does anything else, so a caller `getCaller` does not admit gets the not-authenticated refusal and
 * nothing more. `src/lib/anonymous-access.ts` names the only functions that answer such a caller,
 * and `tests/convex/anonymous-caller.test.ts` holds every public function to the rule.
 */

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
 * No token is ever keyed on the organisation's reserved key: `getCaller` answers such a token as
 * no caller, and this throws for it.
 *
 * @param identity - The verified token's identity.
 * @returns The owner key.
 * @throws Error with {@link RESERVED_OWNER_KEY_REFUSAL} when the key would be the reserved one.
 */
export function ownerKeyOf(identity: UserIdentity): string {
  const key = ownerKeyOrReserved(identity);
  if (key === undefined) throw new Error(RESERVED_OWNER_KEY_REFUSAL);
  return key;
}

/** Why a token is no caller: its owner key would be the organisation's reserved key. */
export const RESERVED_OWNER_KEY_REFUSAL =
  "a token whose subject is the organisation's reserved key is no caller";

/**
 * The owner key a token is keyed on, or undefined when it would be the organisation's reserved
 * key (`ORGANISATION_OWNER_KEY`): a bare subject is its issuer's to choose, and a caller
 * keyed on it would own every organisation row (the access plan, section 4.1; AC12).
 */
function ownerKeyOrReserved(identity: UserIdentity): string | undefined {
  const customer = process.env[CUSTOMER_OIDC_ISSUER_VAR];
  const key =
    customer && issuerKey(customer) === issuerKey(identity.issuer)
      ? identity.tokenIdentifier
      : identity.subject;
  return isOrganisationOwnerKey(key) ? undefined : key;
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

/**
 * The verified caller, or null for an anonymous one, for a customer-issuer
 * caller the domain rule refuses (decision S2): the second of the two places it
 * is checked, after the sign-in's callback, so a token forced past the callback
 * is refused here; for a caller of a generic-preset issuer whose address is not
 * verified (decision 7 (b)), which the callback does not check; and for a token
 * whose owner key would be the organisation's reserved key. The local issuer and
 * Clerk keep their own rules.
 */
export async function getCaller(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  if (customerCallerRefused(identity, deploymentEnv)) return null;
  const ownerKey = ownerKeyOrReserved(identity);
  if (ownerKey === undefined) return null;
  return { ...identity, ownerKey };
}

/** The deployment's own env, as the auth config and the owner key read it. */
function deploymentEnv(name: string): string | undefined {
  return process.env[name];
}

/**
 * Whether the domain rule refuses a caller: one the customer's issuer signed
 * whose `email` (and, for Google, `hd`) is outside `DAY0_OIDC_ALLOWED_DOMAINS`,
 * or, under the generic preset, whose address is not verified. With no domain
 * configured every such caller is refused, as the sign-in's callback refuses
 * them; an unreadable list refuses them too.
 */
function customerCallerRefused(identity: UserIdentity, read: EnvReader): boolean {
  return callerRefusal(identity, read) !== undefined;
}

/**
 * Why the deployment refuses a caller the customer's issuer signed, or undefined when it admits
 * them or another issuer signed them: outside the allowed domains (the domain rule), or, under the
 * generic preset, an address the issuer did not verify (decision 7 (b)). `config.whoAmI` answers
 * the live check with it, so the check can say which.
 *
 * @param identity - The caller's verified token.
 * @param read - Reads one name of the deployment's env; its own by default.
 */
export function callerRefusal(
  identity: UserIdentity,
  read: EnvReader = deploymentEnv,
): CallerRefusal | undefined {
  if (callerIssuer(identity, read) !== 'customer') return undefined;
  let allowed: readonly string[];
  try {
    allowed = customerOidcAllowedDomains(read);
  } catch {
    // An entry that is not a domain: `check:setup` names it; meanwhile nobody is admitted by it.
    allowed = [];
  }
  if (
    signInRefusal({ email: identity.email, hd: identity.hd }, allowed, identity.issuer) !==
    undefined
  ) {
    return 'outside-domains';
  }
  return unverifiedUnderGenericPreset(identity, read) ? 'unverified-address' : undefined;
}

/**
 * Whether a caller signed in through an issuer the generic preset serves has no verified address
 * (the wave 10 review's S-m2, decision 7 (b)). Entra, Okta and Google control the addresses they
 * issue, so the domain rule alone admits their people; a generic issuer may let anyone register
 * an address in an allowed domain, so its caller must also present the address verified by the
 * issuer's own rule ({@link verifiedAddressOf}: the claim, or the deployment's declared trust
 * when the issuer sends none).
 */
function unverifiedUnderGenericPreset(identity: UserIdentity, read: EnvReader): boolean {
  if (providerOfIssuer(identity.issuer) !== 'oidc') return false;
  return verifiedAddressOf(identity, read) === undefined;
}

/** The three issuers a deployment accepts tokens from (`convex/auth.config.ts`). */
type CallerIssuer = 'local' | 'customer' | 'clerk';

/**
 * Which issuer signed a caller in. The auth config admits only these three,
 * and declares Clerk only when neither other one is configured, so a token
 * from neither the local issuer nor the customer's is Clerk's.
 */
function callerIssuer(identity: UserIdentity, read: EnvReader): CallerIssuer {
  const issuer = issuerKey(identity.issuer);
  if (issuer === issuerKey(DEV_NO_AUTH_ISSUER)) return 'local';
  const customer = read(CUSTOMER_OIDC_ISSUER_VAR);
  if (customer && issuer === issuerKey(customer)) return 'customer';
  return 'clerk';
}

/**
 * The caller's verified address, trimmed and lower-cased: the address the
 * caller's own token proves, which is what makes a caller the manager of the
 * employees it owns and lets it answer a handover named to that address
 * (the transfer plan, section 3.2). Read per issuer:
 *
 * - Clerk: the `convex` template's `email`, when `email_verified` is true.
 * - The local issuer: the configured manager address the token route mints
 *   as `email`, with `email_verified` true, for whoever holds the signing key.
 * - The customer's issuer: `email` when `email_verified` is true; when the
 *   issuer sends no `email_verified`, when Entra's `xms_edov` is true (S4), and
 *   with neither claim only if the deployment declares its addresses trusted
 *   (`DAY0_OIDC_EMAIL_TRUSTED`, D3). An issuer that says `false` is taken at
 *   its word, flag or not, and an address at `day0.local` is never its.
 *
 * The claim is read in either spelling ({@link emailVerifiedClaim}), and only
 * a boolean `true` asserts it. Pure: it reads the token's claims and the
 * deployment env, nothing else.
 *
 * @param identity - The caller's verified token.
 * @param read - Reads one name of the deployment's env; its own by default.
 * @returns The address, or undefined when the token asserts none verified or it is not shaped like one.
 */
export function verifiedAddressOf(
  identity: UserIdentity,
  read: EnvReader = deploymentEnv,
): string | undefined {
  if (!addressVerified(identity, read)) return undefined;
  const address = normaliseManagerAddress(identity.email);
  if (address === undefined) return undefined;
  // The product's own domain has no mailbox, so no customer issuer can have verified one there;
  // only the local issuer, whose domain it is, vouches for it (the wave 9 review's U1-m4).
  if (address.endsWith(LOCAL_DOMAIN) && callerIssuer(identity, read) === 'customer') {
    return undefined;
  }
  return address;
}

/** The domain the local issuer's and the evaluation harness's addresses live at. */
const LOCAL_DOMAIN = '@day0.local';

/**
 * Whether the caller's token asserts its address verified, by its issuer's rule (D3). A
 * customer issuer that sends no `email_verified` may send Entra's `xms_edov` (S4): a boolean
 * `true` verifies the address, anything else is the issuer's word against it; only with neither
 * claim does the trust flag decide.
 */
function addressVerified(identity: UserIdentity, read: EnvReader): boolean {
  const claim = emailVerifiedClaim(identity);
  const issuer = callerIssuer(identity, read);
  switch (issuer) {
    case 'clerk':
    case 'local':
      return claim === true;
    case 'customer':
      return customerAddressVerified(identity, customerOidcEmailTrusted(read));
    default: {
      const unknown: never = issuer;
      throw new Error(`unhandled issuer ${String(unknown)}`);
    }
  }
}

/**
 * The verified caller; throws the mode's not-authenticated message for an anonymous one, as a
 * `ConvexError` so a page or a dialog can say it after production strips every other error's
 * text (standard 6.3).
 */
export async function getCallerOrThrow(ctx: QueryCtx | MutationCtx | ActionCtx): Promise<Caller> {
  const identity = await getCaller(ctx);
  if (!identity) throw new ConvexError(notAuthenticatedMessage());
  return identity;
}

/** An administrator of the deployment: the verified caller and the address the list names. */
export interface Administrator {
  readonly caller: Caller;
  readonly address: string;
}

/**
 * The caller, if the deployment names its verified address as an administrator's
 * (`DAY0_ADMINISTRATORS`; B8, the access plan section 4.1): the guard of every public function
 * that lands, rotates, revokes or lists the organisation's connections. It says nothing about any
 * employee: an administrator owns no card through it, and each employee's access keeps its one
 * approval, the manager's. The operator's CLI acts as administrator through internal functions
 * with the deployment's admin key, and never reaches this guard.
 *
 * @throws ConvexError with {@link NOT_AN_ADMINISTRATOR} for a signed-in caller the list does not
 *   name, or whose token does not assert the address verified; the not-authenticated error for an
 *   anonymous caller.
 */
export async function assertAdministrator(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<Administrator> {
  const caller = await getCallerOrThrow(ctx);
  const address = administratorAddressOf(caller, deploymentEnv);
  if (address === undefined) throw new ConvexError(NOT_AN_ADMINISTRATOR);
  return { caller, address };
}

/**
 * Whether the caller is one of the deployment's administrators, for a read that only shows or
 * hides the organisation page's way in. Never a guard: a write calls {@link assertAdministrator}.
 */
export async function callerIsAdministrator(
  ctx: QueryCtx | MutationCtx | ActionCtx,
): Promise<boolean> {
  const caller = await getCaller(ctx);
  return caller !== null && administratorAddressOf(caller, deploymentEnv) !== undefined;
}

/** The caller's verified address when the deployment names it as an administrator's. */
function administratorAddressOf(identity: UserIdentity, read: EnvReader): string | undefined {
  const address = verifiedAddressOf(identity, read);
  if (address === undefined) return undefined;
  return isAdministratorAddress(address, deploymentAdministrators(read)) ? address : undefined;
}

/**
 * Refuse an employee the caller does not own, or one no owner holds, in the manager's words
 * ({@link EMPLOYEE_NOT_YOURS}) as a `ConvexError`: a dialog says the backend's words, which
 * production strips from a plain `Error` (the cockpit's item).
 */
function assertCallerOwns(agent: Doc<'agents'>, caller: Caller): void {
  if (!agent.userId || agent.userId !== caller.ownerKey) throw new ConvexError(EMPLOYEE_NOT_YOURS);
}

/** The employee, if the caller owns it; throws otherwise. The guard for a row keyed by agent id; the four below cover rows keyed otherwise. */
export async function assertOwnsAgent(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  return await callersAgent(ctx, await getCallerOrThrow(ctx), agentId);
}

/** The employee, if the caller the guard already admitted owns it; throws otherwise. */
async function callersAgent(
  ctx: QueryCtx | MutationCtx,
  caller: Caller,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const agent = await ctx.db.get(agentId);
  if (!agent) throw new ConvexError(EMPLOYEE_GONE);
  assertCallerOwns(agent, caller);
  return agent;
}

/**
 * The employee, if the caller owns it, or null when no such row exists: the read for a page
 * that must answer a retired employee or a stale link rather than fail. Another owner's employee
 * is refused with {@link EMPLOYEE_NOT_YOURS} as a `ConvexError`, so the page can tell the refusal
 * from a crash after production strips every other error's text.
 */
export async function ownedAgentOrNull(
  ctx: QueryCtx | MutationCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'> | null> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.db.get(agentId);
  if (agent === null) return null;
  if (!agent.userId || agent.userId !== identity.ownerKey) {
    throw new ConvexError(EMPLOYEE_NOT_YOURS);
  }
  return agent;
}

/** The employee, if the caller owns it, for an action that has no database handle. */
export async function assertOwnsAgentAction(
  ctx: ActionCtx,
  agentId: Id<'agents'>,
): Promise<Doc<'agents'>> {
  const identity = await getCallerOrThrow(ctx);
  const agent = await ctx.runQuery(internal.agents.getInternal, { agentId });
  if (!agent) throw new ConvexError(EMPLOYEE_GONE);
  assertCallerOwns(agent, identity);
  return agent;
}

/**
 * Whether no second account can exist on this deployment for this caller: it
 * signed in through the local issuer, which signs every browser in as one
 * subject, and the profile is `local-dev`. Under `customer-local` the local
 * account is one more manager beside the customer's issuer (the transfer plan,
 * section 8). The handover's ask (`convex/managerTransfers.ts`) calls it too.
 *
 * @param identity - The caller's verified token.
 */
export function signedInAsTheOneLocalManager(identity: UserIdentity): boolean {
  return (
    issuerKey(identity.issuer) === issuerKey(DEV_NO_AUTH_ISSUER) &&
    resolveDeploymentProfile() === 'local-dev'
  );
}

/** A handover request and the account it names, as {@link assertNamedInTransfer} answers them. */
export interface NamedInTransfer {
  readonly transfer: Doc<'managerTransfers'>;
  readonly caller: Caller;
}

/**
 * The handover request and its caller, if the caller is the account it names:
 * signed in with a verified address equal to the request's `toAddress`, and
 * not the account that asked, whatever its addresses (the transfer plan,
 * section 5.1). The guard for the named manager's reads and answers, the
 * counterpart of {@link assertOwnsAgent} for the employee's owner; it says
 * nothing about the request's state, which each caller checks for its own move.
 *
 * The one local manager of a `local-dev` deployment (every browser on the local
 * key is one subject) is refused as it is at the ask, since it cannot be told
 * apart from whoever else holds the key (the wave 9 review's U1-m3). An
 * unverified caller is refused before anything is read, and every caller the
 * request does not name reads it as one that does not exist, as does a string
 * that is not a request's id (a link pasted wrong, another table's row): an id
 * is confirmed to nobody it does not name (the wave 9 review's U1-m2, U4-m1).
 *
 * @param transferId - The request's id as the caller gave it, checked here.
 * @throws ConvexError with {@link LOCAL_DEV_TRANSFER_REFUSAL}, {@link UNVERIFIED_FOR_TRANSFER},
 *   {@link TRANSFER_NOT_FOUND} or {@link OWN_TRANSFER}, words the dialog shows; the
 *   not-authenticated error for an anonymous caller.
 */
export async function assertNamedInTransfer(
  ctx: QueryCtx | MutationCtx,
  transferId: string,
): Promise<NamedInTransfer> {
  const caller = await getCallerOrThrow(ctx);
  if (signedInAsTheOneLocalManager(caller)) throw new ConvexError(LOCAL_DEV_TRANSFER_REFUSAL);
  const address = verifiedAddressOf(caller);
  if (address === undefined) throw new ConvexError(UNVERIFIED_FOR_TRANSFER);
  const id = ctx.db.normalizeId('managerTransfers', transferId);
  const transfer = id === null ? null : await ctx.db.get(id);
  if (!transfer || !sameManagerAddress(address, transfer.toAddress)) {
    throw new ConvexError(TRANSFER_NOT_FOUND);
  }
  if (caller.ownerKey === transfer.fromOwnerKey) throw new ConvexError(OWN_TRANSFER);
  return { transfer, caller };
}

/**
 * A row keyed by its employee, if the caller owns that employee; throws the row's one refusal
 * otherwise, the same for a row that is gone, one whose employee is gone and one of an employee
 * another owner holds, so an id confirms nothing (W12-R25). The caller is admitted before the
 * row is read, so a caller the guard does not admit is refused alike for any id (12-G).
 *
 * @param read - Reads the row.
 * @param refusal - The row's refusal, a `ConvexError`'s data.
 * @throws ConvexError with `refusal`; the not-authenticated error for an anonymous caller.
 */
async function ownedEmployeeRow<Row extends { agentId: Id<'agents'> }>(
  ctx: QueryCtx | MutationCtx,
  read: () => Promise<Row | null>,
  refusal: string,
): Promise<Row> {
  const caller = await getCallerOrThrow(ctx);
  const row = await read();
  const agent = row === null ? null : await ctx.db.get(row.agentId);
  if (row === null || agent === null || !agent.userId || agent.userId !== caller.ownerKey) {
    throw new ConvexError(refusal);
  }
  return row;
}

/**
 * The charter, if the caller owns its employee; throws {@link CHARTER_NOT_YOURS} otherwise. This
 * guard and the three below admit the caller before they read the row (12-G).
 */
export async function assertOwnsCharter(
  ctx: QueryCtx | MutationCtx,
  charterId: Id<'charters'>,
): Promise<Doc<'charters'>> {
  return await ownedEmployeeRow(ctx, async () => await ctx.db.get(charterId), CHARTER_NOT_YOURS);
}

/**
 * The connection card, if the caller owns its employee; throws {@link SURFACE_NOT_YOURS} otherwise,
 * the same for a card that does not exist (W13-R13).
 */
export async function assertOwnsSurface(
  ctx: QueryCtx | MutationCtx,
  surfaceId: Id<'surfaces'>,
): Promise<Doc<'surfaces'>> {
  return await ownedEmployeeRow(ctx, async () => await ctx.db.get(surfaceId), SURFACE_NOT_YOURS);
}

/** The work item, if the caller owns its employee; throws {@link WORK_ITEM_NOT_YOURS} otherwise. */
export async function assertOwnsWorkItem(
  ctx: QueryCtx | MutationCtx,
  workItemId: Id<'workItems'>,
): Promise<Doc<'workItems'>> {
  return await ownedEmployeeRow(ctx, async () => await ctx.db.get(workItemId), WORK_ITEM_NOT_YOURS);
}

/** The skill, if the caller owns its employee; throws {@link SKILL_NOT_YOURS} otherwise. */
export async function assertOwnsSkill(
  ctx: QueryCtx | MutationCtx,
  skillId: Id<'skills'>,
): Promise<Doc<'skills'>> {
  return await ownedEmployeeRow(ctx, async () => await ctx.db.get(skillId), SKILL_NOT_YOURS);
}

/** The voice session, if the caller owns its employee; throws {@link ONE_TO_ONE_NOT_YOURS} otherwise. */
export async function assertOwnsVoiceSession(
  ctx: QueryCtx | MutationCtx,
  sessionId: Id<'voiceSessions'>,
): Promise<Doc<'voiceSessions'>> {
  return await ownedEmployeeRow(ctx, async () => await ctx.db.get(sessionId), ONE_TO_ONE_NOT_YOURS);
}

/**
 * The owner scope a caller's owner-level rows are keyed and read under (wave 13, 13-K; the wave
 * file's section 5.1): the people graph, its identities and edges, and the working agreements.
 * Every owner-level lookup of the caller's goes through it, so keying them by a company rather
 * than an owner later is a change here alone (the enhancements plan, section 12.2). Today it is
 * the owner key ({@link ownerKeyOf}).
 *
 * @param caller - A caller a guard admitted.
 * @returns The scope every owner-level index leads with.
 */
export function ownerScope(caller: Pick<Caller, 'ownerKey'>): string {
  return caller.ownerKey;
}

/**
 * The owner scope of an employee's owner, for a path that writes or reads the owner's rows with no
 * caller (an internal function, a migration, the work loop): the same scope {@link ownerScope}
 * gives the owner when they call, or undefined for an employee no owner holds, whose owner-level
 * rows do not exist.
 *
 * @param agent - The employee, or any row carrying its owner key.
 */
export function employeeOwnerScope(agent: Pick<Doc<'agents'>, 'userId'>): string | undefined {
  return agent.userId === undefined ? undefined : ownerScope({ ownerKey: agent.userId });
}

/**
 * A row of an owner-level table if the caller's owner scope holds it; throws the one refusal for
 * a row of another scope and a row that does not exist. The caller is admitted before the read.
 */
async function ownedInScope<Row extends { readonly userId: string }>(
  ctx: QueryCtx | MutationCtx,
  read: () => Promise<Row | null>,
  refusal: string,
): Promise<Row> {
  const scope = ownerScope(await getCallerOrThrow(ctx));
  const row = await read();
  if (row === null || row.userId !== scope) throw new ConvexError(refusal);
  return row;
}

/**
 * The person, if the caller's owner scope holds it (13-K for 13-P): the guard of every public
 * function that reads or changes one person of the graph. The caller is admitted before the row is
 * read, and a person of another owner reads as one that does not exist.
 *
 * @throws ConvexError with {@link PERSON_NOT_YOURS}; the not-authenticated error for an anonymous
 *   caller.
 */
export async function assertOwnsPerson(
  ctx: QueryCtx | MutationCtx,
  personId: Id<'people'>,
): Promise<Doc<'people'>> {
  return await ownedInScope(ctx, async () => await ctx.db.get(personId), PERSON_NOT_YOURS);
}

/**
 * The edge, if the caller's owner scope holds it (13-K for 13-P): the guard of every public
 * function that changes or retires one edge. Admits the caller before the read.
 *
 * @throws ConvexError with {@link RELATIONSHIP_NOT_YOURS}; the not-authenticated error for an
 *   anonymous caller.
 */
export async function assertOwnsRelationship(
  ctx: QueryCtx | MutationCtx,
  relationshipId: Id<'relationships'>,
): Promise<Doc<'relationships'>> {
  return await ownedInScope(
    ctx,
    async () => await ctx.db.get(relationshipId),
    RELATIONSHIP_NOT_YOURS,
  );
}

/**
 * The working agreement, if the caller's owner scope holds it (13-K for 13-W): the guard of every
 * public function that keeps, edits, promotes or retires one, whether it binds one employee or
 * every employee. Admits the caller before the read.
 *
 * @throws ConvexError with {@link AGREEMENT_NOT_YOURS}; the not-authenticated error for an
 *   anonymous caller.
 */
export async function assertOwnsAgreement(
  ctx: QueryCtx | MutationCtx,
  agreementId: Id<'workingAgreements'>,
): Promise<Doc<'workingAgreements'>> {
  return await ownedInScope(ctx, async () => await ctx.db.get(agreementId), AGREEMENT_NOT_YOURS);
}
