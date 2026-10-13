/*
 * The words of a reorientation card (wave 16, 16-K; the wave file's section 5.1): a card that opens
 * when the organisation changes under an employee, with the evidence, what is affected and what the
 * employee proposes; only Approve changes anything (A11). `convex/schema.ts` declares the
 * `reorientations` and `reorientationTalks` validators from these lists, so the schema and the
 * code that writes and reads them (16-O, 16-D) say each one way. Pure and env-free: the schema
 * module imports it.
 */

/**
 * What opened a card, one kind per row of the wave file's section 3 (a row naming two events is
 * two kinds, so each has its own daily cap): the employee's manager changed (`manager.transferred`);
 * a scope was revoked (`permission.revoked`); a surface's access ended (`surface.expired`); a
 * revocation at the vendor failed (`credential.revoked-at-source` or
 * `organisation.revoked-at-source` with a failed outcome); the organisation's connection was
 * revoked (`organisation.connection-revoked`); a skill version was withdrawn (`skill.revoked`); a
 * skill is due a re-check (`skill.recheck-due`); a skill failed its stored verification
 * (`skill.verification-failed`); an approver or escalation contact changed
 * (`relationship.changed`); a person was dismissed (`person.dismissed`); a correction was kept on
 * an item that applied an agreement; three gate refusals on one scope in seven days; three
 * out-of-scope skips citing one `willNotDo` clause, or three plan rejections, in 30 days; a page
 * under an open plan was superseded, archived or made a draft
 * (`documentation.page-status-changed`); and the manager opened one by hand for a role or goal
 * change. A confirmed conflict asks a question instead and opens no card (5.2). From wave 17
 * (17-K for 17-O; RM34 (a)): the agreements could not be checked against an amended charter
 * (`agreement.check-owed`), a low card that proposes the re-check and holds nothing. A new kind is
 * added at the end: the schema's union is this list, and a stored card keeps its kind.
 */
export const REORIENTATION_TRIGGERS = [
  'manager-changed',
  'access-revoked',
  'access-ended',
  'revocation-failed',
  'connection-revoked',
  'skill-withdrawn',
  'skill-recheck-due',
  'skill-recheck-failed',
  'relationship-changed',
  'person-dismissed',
  'agreement-corrected',
  'repeated-refusal',
  'repeated-skip',
  'repeated-rejection',
  'page-status-changed',
  'role-changed',
  'agreement-check-owed',
] as const;

/** One of {@link REORIENTATION_TRIGGERS}. */
export type ReorientationTrigger = (typeof REORIENTATION_TRIGGERS)[number];

/**
 * How much a card can hold up: `high` when a write scope or held work is involved, `medium` for a
 * charter clause, `low` otherwise. A low-risk card never holds work (A11).
 */
export const REORIENTATION_RISKS = ['low', 'medium', 'high'] as const;

/** One of {@link REORIENTATION_RISKS}. */
export type ReorientationRisk = (typeof REORIENTATION_RISKS)[number];

/**
 * Where a card stands: `open` until the manager decides it; `discussing` while a Discuss
 * conversation is under way (it returns to `open` with the conversation's proposal); `applied`
 * once Approve ran its proposal; `dismissed`, which changes nothing; `deferred` until its
 * `revisitAt`, when the sweep opens it again.
 */
export const REORIENTATION_STATUSES = [
  'open',
  'discussing',
  'applied',
  'dismissed',
  'deferred',
] as const;

/** One of {@link REORIENTATION_STATUSES}. */
export type ReorientationStatus = (typeof REORIENTATION_STATUSES)[number];

/** The standings a card is still undecided in: what the inbox lists and the hold reads. */
export const UNDECIDED_REORIENTATION_STATUSES = [
  'open',
  'discussing',
] as const satisfies readonly ReorientationStatus[];

/**
 * What a card proposes. `pending` is new against the 1 October shape (decision O-2): a trigger's
 * writer is a mutation and cannot call the model, so a card opens with its proposal pending and a
 * scheduled judgement writes it. `none` is a trigger with nothing to change ("Nothing needs to
 * change; confirm or dismiss"). Each other kind names the target Approve applies it through: a
 * charter amendment, an agreement, an edge of the people graph, a page's status, a scope, or a
 * skill.
 */
export const REORIENTATION_PROPOSAL_KINDS = [
  'pending',
  'charter-change',
  'agreement',
  'relationship',
  'page-status',
  'scope',
  'skill-action',
  'none',
] as const;

/** One of {@link REORIENTATION_PROPOSAL_KINDS}. */
export type ReorientationProposalKind = (typeof REORIENTATION_PROPOSAL_KINDS)[number];

/** What Approve does to an agreement: the agreements' `keep`, `edit`, `recheck`, `retire` or `dismiss`. */
export const AGREEMENT_PROPOSAL_ACTIONS = ['keep', 'edit', 'recheck', 'retire', 'dismiss'] as const;

/** One of {@link AGREEMENT_PROPOSAL_ACTIONS}. */
export type AgreementProposalAction = (typeof AGREEMENT_PROPOSAL_ACTIONS)[number];

/** What Approve does to an edge: `editRelationship` (superseding it in place) or `retireRelationship`. */
export const RELATIONSHIP_PROPOSAL_ACTIONS = ['edit', 'retire'] as const;

/** One of {@link RELATIONSHIP_PROPOSAL_ACTIONS}. */
export type RelationshipProposalAction = (typeof RELATIONSHIP_PROPOSAL_ACTIONS)[number];

/**
 * What Approve sets a page to: one of the statuses the manager may set (`setPageStatus`), or
 * `clear`, which hands the page back to its source's own status (`clearPageStatus`).
 */
export const PAGE_STATUS_PROPOSALS = [
  'active',
  'superseded',
  'archived',
  'draft',
  'clear',
] as const;

/** One of {@link PAGE_STATUS_PROPOSALS}. */
export type PageStatusProposal = (typeof PAGE_STATUS_PROPOSALS)[number];

/** What Approve does to a scope: `revokeScope`, or the grant path. */
export const SCOPE_PROPOSAL_ACTIONS = ['revoke', 'grant'] as const;

/** One of {@link SCOPE_PROPOSAL_ACTIONS}. */
export type ScopeProposalAction = (typeof SCOPE_PROPOSAL_ACTIONS)[number];

/** What Approve does to a skill: the skill controls' `recheckNow`, `retire` or `withdraw`. */
export const SKILL_PROPOSAL_ACTIONS = ['recheck', 'retire', 'withdraw'] as const;

/** One of {@link SKILL_PROPOSAL_ACTIONS}. */
export type SkillProposalAction = (typeof SKILL_PROPOSAL_ACTIONS)[number];

/**
 * Where a Discuss conversation stands (RM10 (a): its own table, never a one-to-one session):
 * `active` while the manager and the employee talk, resumable from any point; `finished` once it
 * ended in a proposal, written onto the card; `closed` when the card was decided or the
 * conversation set aside without one.
 */
export const REORIENTATION_TALK_STATES = ['active', 'finished', 'closed'] as const;

/** One of {@link REORIENTATION_TALK_STATES}. */
export type ReorientationTalkState = (typeof REORIENTATION_TALK_STATES)[number];

/**
 * What the function log says when one of the cards' bounds cuts (W16-R24: each cut with nothing
 * said anywhere). The line carries `bound`, the constant's name, and `limit`, its value.
 */
export const BOUND_MET = 'reorientation: a bound was met, and what lay past it was left out';

/** The most work items one card holds (C6, decision O1): a card names at most ten. */
export const REORIENTATION_BLOCKING_LIMIT = 10;
