/*
 * The words of a working agreement (wave 13; the wave file's sections 5.1 and 5.3): a standing
 * preference the manager keeps beside the charter, proposed from repeated corrections or a note
 * kept at a plan approval, activated on a card (A14), read by the planner and the executor and
 * never by the scope judgement. `convex/schema.ts` declares the `workingAgreements` validators from
 * these lists, so the schema and the code that writes and reads them (13-W) say each one way.
 */

/** What kind of standing preference an agreement keeps. */
export const AGREEMENT_KINDS = [
  'preference',
  'convention',
  'relationship',
  'operating-decision',
] as const;

/** One of {@link AGREEMENT_KINDS}. */
export type AgreementKind = (typeof AGREEMENT_KINDS)[number];

/**
 * Which work an agreement applies to: all of it, one surface's (`scopeRef` the slug), one
 * operation's (`scopeRef` the operation) or one person's (`personId`, a person of the owner's graph
 * the candidate's requester or owner resolves to).
 */
export const AGREEMENT_SCOPES = ['global', 'surface', 'operation', 'person'] as const;

/** One of {@link AGREEMENT_SCOPES}. */
export type AgreementScope = (typeof AGREEMENT_SCOPES)[number];

/**
 * Where an agreement came from: corrections promoted, a note kept at a plan approval, the
 * manager's card, a reorientation (wave 16) or the manager's chat.
 */
export const AGREEMENT_SOURCE_TYPES = [
  'correction-promotion',
  'plan-approval',
  'manager-card',
  'reorientation',
  'manager-chat',
] as const;

/** One of {@link AGREEMENT_SOURCE_TYPES}. */
export type AgreementSourceType = (typeof AGREEMENT_SOURCE_TYPES)[number];

/**
 * An agreement's standing: `proposed` until the manager keeps it on a card, `active`,
 * `superseded` by the edit that replaced it, `retired` by the manager, `refused` before it was
 * ever shown as a proposal (it would widen the charter, see {@link AGREEMENT_REFUSAL_REASONS}),
 * and `dismissed` when the manager said "Not now".
 */
export const AGREEMENT_STATUSES = [
  'proposed',
  'active',
  'superseded',
  'retired',
  'refused',
  'dismissed',
] as const;

/** One of {@link AGREEMENT_STATUSES}. */
export type AgreementStatus = (typeof AGREEMENT_STATUSES)[number];

/**
 * Why a statement was refused as an agreement (F11): it widens the employee's scope, grants a
 * permission, names a credential, or contradicts a kept `willNotDo` clause, which the refusal
 * quotes.
 */
export const AGREEMENT_REFUSAL_REASONS = [
  'widens-scope',
  'grants-permission',
  'names-credential',
  'contradicts-will-not-do',
] as const;

/** One of {@link AGREEMENT_REFUSAL_REASONS}. */
export type AgreementRefusalReason = (typeof AGREEMENT_REFUSAL_REASONS)[number];

/**
 * Why a keep was refused before any judgement (W13-R28, ruled for 14-FX): an agreement kept for
 * every employee of an owner with more employees than its check reads. Not a verdict of the
 * judgement, so a list of its own beside {@link AGREEMENT_REFUSAL_REASONS}, which is.
 */
export const AGREEMENT_KEEP_REFUSAL_REASONS = ['every-employee-too-many'] as const;

/** One of {@link AGREEMENT_KEEP_REFUSAL_REASONS}. */
export type AgreementKeepRefusalReason = (typeof AGREEMENT_KEEP_REFUSAL_REASONS)[number];

/** Why a refused agreement's row was refused: by the judgement, or at the keep. */
export type AgreementRowRefusalReason = AgreementRefusalReason | AgreementKeepRefusalReason;

/**
 * How many employees' charters the check of an agreement for every employee reads: an owner with
 * more is refused such an agreement (W13-R28).
 */
export const EMPLOYEES_CHECKED = 50;

/**
 * Where the manager made an agreement active: the promotion card on the Work tab, the "Keep this
 * note" tick of a plan approval, or the Agreements card on the Charter tab (A18).
 */
export const AGREEMENT_APPROVED_VIA = [
  'promotion-card',
  'plan-approval',
  'agreements-card',
] as const;

/** One of {@link AGREEMENT_APPROVED_VIA}. */
export type AgreementApprovedVia = (typeof AGREEMENT_APPROVED_VIA)[number];

/** The most characters an agreement's statement keeps. */
export const AGREEMENT_STATEMENT_LIMIT = 500;

/**
 * The refusal of an agreement the caller's owner scope does not hold, the same for one that does
 * not exist (W12-R25).
 */
export const AGREEMENT_NOT_YOURS = 'This working agreement is not yours.';
