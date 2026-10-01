/**
 * The event contract (decisions N10 and Q14): every event type Day0 writes to
 * its ledger, and the payload each one carries.
 *
 * `events.payload` stays untyped at the database, because a typed column
 * would validate every historic row at each push; the types live here
 * instead, in the one module the writers, the export and the recompute all
 * import. Every writer goes through `appendEvent` or `logEvent`
 * (`convex/eventLog.ts`), which take a `NewEvent` or a `LoggedEvent`, so a
 * type this module does not list, or a payload that is not its type's, fails
 * the typecheck. `tests/src/events/contract.test.ts` holds the other
 * direction: a listed type that no writer writes fails the suite.
 *
 * A reader still meets rows an older release wrote, whose payloads may lack a
 * field a newer writer adds; a field read for a figure is read defensively.
 */
import type { Doc, Id } from '../../convex/_generated/dataModel';
import type { CharterChange, FieldDiff } from '../agent/charter-amendment';
import type { TransferCancelReason } from '../agent/manager-transfer';
import type { ModelCallReport } from '../lib/model-call-telemetry';
import type { SurfaceMode } from '../lib/surface-mode';
import type { ClaimHolder } from '../work/claim-key';
import type { DecisionKind } from '../work/manager-channel';
import type { ManagerNotificationMode } from '../work/manager-notes';
import type { PlannerObligations } from '../work/plan-obligations';
import type { ReconciliationEntry } from '../work/reconciliation';
import type { TicketSnapshot } from '../work/ticket-ownership';
import type { ExecutionPlan, PlanObligations } from '../work/types';

type WorkItemId = Id<'workItems'>;
type SurfaceId = Id<'surfaces'>;
type SkillId = Id<'skills'>;
type CharterId = Id<'charters'>;
type RunId = Id<'events'>;
type SessionId = Id<'voiceSessions'>;

/** Where a charter amendment came from. */
export type AmendmentVia = 'dashboard' | 'plan-approval';

/** Where the manager decided a plan or a held set. */
export type DecidedVia = 'dashboard' | 'channel';

/** The authority path that created a grant. */
export type GrantSource = 'deploy' | 'manager' | 'skill' | 'surface';

/** What sent a parked row back for a fresh evaluation. */
export type RequeueTrigger =
  | 'charter'
  | 'documentation'
  | 'surface'
  | 'claim-released'
  | 'verdict-write'
  | 'check'
  | 'skill-registered';

/** The policy changes `work.reevaluation` records. */
export type ReevaluationTrigger = 'charter' | 'documentation' | 'surface' | 'claim-released';

/** The loop step or authoring run a model call belongs to. */
export type ModelCallStage = 'evaluation' | 'draft' | 'execution' | 'closing' | 'authoring';

/**
 * Which authoring of the closing set a closing-stage call belongs to. One run
 * can author the set up to four times, and each re-sends the whole prompt, so
 * the ledger says which one each call was.
 */
export type ClosingAuthoring =
  | 'first'
  | 'post-apply-round'
  | 'after-carried-reads'
  | 'holder-changed'
  | 'hold-repair';

/** Who finished a voice session's finalisation. */
export type VoiceFinisher = 'browser' | 'webhook' | 'recovery';

/** The indexes a held or auto-applied action set was split into. */
interface ActionSetSplit {
  readonly workItemId: WorkItemId;
  readonly runId: RunId;
  readonly actionCount: number;
  readonly autoIndexes: number[];
  readonly heldIndexes: number[];
  readonly refusedIndexes: number[];
  readonly refusals?: ActionRefusal[];
  readonly dependentPhase?: true;
  readonly transitionDirectedByNote?: true;
  /** The revocation driver's trial the row belongs to. */
  readonly trialId?: string;
}

/** A skill named on its own event. */
interface SkillNamed {
  readonly skillId: SkillId;
  readonly name: string;
}

/** A skill event that says why. */
interface SkillReason extends SkillNamed {
  readonly reason: string;
}

/** A surface event that names only its surface. */
interface SurfaceNamed {
  readonly surfaceId: SurfaceId;
}

/** A surface event that says why. */
interface SurfaceReason extends SurfaceNamed {
  readonly reason: string;
}

/** A work-item event that names only its item. */
interface WorkItemNamed {
  readonly workItemId: WorkItemId;
}

/** A work-item event that names its item and a run of it. */
interface WorkItemRun extends WorkItemNamed {
  readonly runId: RunId;
}

/** A decision request's event: the item and the request's code. */
interface DecisionNamed extends WorkItemNamed {
  readonly decisionId: string;
}

/** The verdict a `work.evaluated` event records, as the evaluator wrote it. */
export interface EvaluatedVerdict {
  readonly decision: string;
  readonly [field: string]: unknown;
}

/** A charter question the manager answered with a plan approval. */
export interface AnsweredQuestion {
  readonly question: string;
  readonly questionId?: Id<'managerQuestions'>;
}

/** A member a batched decision left undecided, and why. */
export interface SkippedBatchMember {
  readonly decisionId: string;
  readonly reason: string;
}

/** A refused action of a set, and why. */
export interface ActionRefusal {
  readonly index: number;
  readonly reason: string;
}

/** One member of a batched decision request. */
export interface DecisionBatchMember {
  readonly workItemId: WorkItemId;
  readonly decisionId: string;
  readonly pendingRunId: RunId;
}

// The employee, its grants and its manager.

/** The payload of `agent.deployed`. */
export interface AgentDeployedPayload {
  readonly bossEmail: string;
  readonly arm: 'day0' | 'baseline';
  readonly zone: string;
  readonly mode: SurfaceMode;
}

/** The payload of `agent.notifications-changed`. */
export interface AgentNotificationsChangedPayload {
  readonly from: ManagerNotificationMode;
  readonly to: ManagerNotificationMode;
  readonly reason: string;
}

/** The payload of `agent.zone-changed`. */
export interface AgentZoneChangedPayload {
  readonly from: string;
  readonly to: string;
}

/** The payload of `agent.autonomy-changed`. */
export interface AgentAutonomyChangedPayload {
  readonly from: boolean;
  readonly to: boolean;
  readonly reason: string;
}

/** The payload of `agent.retired`: the retire's record is the named `retirements` row, under its owner. */
export interface AgentRetiredPayload {
  readonly retirementId: Id<'retirements'>;
  readonly agentId: Id<'agents'>;
  readonly retiredAt: number;
}

/** The payload of `permission.granted`. */
export interface PermissionGrantedPayload {
  readonly scope: string;
  readonly source: GrantSource;
}

/** The payload of `permission.revoked`. */
export interface PermissionRevokedPayload {
  readonly scope: string;
  readonly by: 'manager';
  readonly reason?: string;
}

/** `manager.changed` from the dashboard: the manager's address was changed on the card. */
export interface ManagerChangedOnDashboard {
  readonly via: 'dashboard';
  readonly bossEmail: string;
}

/** `manager.changed` from a probe that resolved a different manager on the chat provider. */
export interface ManagerChangedByProbe {
  readonly via: 'probe';
  readonly surfaceId: SurfaceId;
  readonly previousManagerUserId: string;
  readonly managerUserId: string;
}

/** The payload of `manager.changed`, by where the change was seen. */
export type ManagerChangedPayload = ManagerChangedOnDashboard | ManagerChangedByProbe;

/**
 * What every event of a handover request carries: the request, who asked and
 * the address it names, so the record reads the same whichever manager holds
 * it. Both addresses are personal keys, which the export drops.
 */
export interface TransferRequestEvent {
  readonly transferId: Id<'managerTransfers'>;
  readonly fromAddress: string;
  readonly toAddress: string;
}

/** The payload of `manager.transfer-asked`: a manager asked another to take the employee on. */
export interface ManagerTransferAskedPayload extends TransferRequestEvent {
  readonly hasNote: boolean;
}

/** The payload of `manager.transfer-cancelled`: an asked request ended before its answer. */
export interface ManagerTransferCancelledPayload extends TransferRequestEvent {
  readonly reason: TransferCancelReason;
}

/** The payload of `manager.transfer-declined`: the named manager declined, with or without a reason. */
export interface ManagerTransferDeclinedPayload extends TransferRequestEvent {
  readonly hasReason: boolean;
}

/** The payload of `manager.transfer-expired`: the request went unanswered past its expiry. */
export type ManagerTransferExpiredPayload = TransferRequestEvent;

// The charter.

/** The payload of `charter.drafted`. */
export interface CharterDraftedPayload {
  readonly charterId: CharterId;
  readonly version: string;
}

/** The payload of `charter.approved`. */
export interface CharterApprovedPayload {
  readonly charterId: CharterId;
  readonly version: string;
  readonly struckConstraints?: string[];
}

/** The payload of `charter.amended`. */
export interface CharterAmendedPayload {
  readonly charterId: CharterId;
  readonly previousCharterId: CharterId;
  readonly version: string;
  readonly previousVersion: string;
  readonly via: AmendmentVia;
  readonly reason?: string;
  readonly changes: readonly CharterChange[];
  readonly diff: FieldDiff[];
}

/** The payload of `charter.request_changes`. */
export interface CharterRequestChangesPayload {
  readonly charterId: CharterId;
  /** The manager's note, empty when the draft was sent back without one. */
  readonly notes: string;
  /** Whether the employee redrafts from its transcript and the note; absent on events before the redraft existed. */
  readonly redrafting?: boolean;
}

/** The payload of `charter.question-asked`. */
export interface CharterQuestionAskedPayload {
  readonly questionId: Id<'managerQuestions'>;
  readonly workItemId: WorkItemId;
  readonly question: string;
  readonly touchedBy: 'plan' | 'candidate';
}

/**
 * The payload of `charter.question-answered`. The question row is named when
 * a plan asked the question; an answer given on the charter card to a
 * question no plan asked has none.
 */
export interface CharterQuestionAnsweredPayload {
  readonly questionId?: Id<'managerQuestions'>;
  readonly via: AmendmentVia;
  readonly amended: boolean;
  readonly charterId?: CharterId;
}

/** The payload of `charter.evidence-rejected`. */
export interface CharterEvidenceRejectedPayload {
  readonly count: number;
  readonly texts: string[];
}

/** The payload of `charter.seeding-failed`. */
export interface CharterSeedingFailedPayload {
  readonly charterId: CharterId;
  readonly attempt: number;
  readonly reason: string;
  readonly retrying: boolean;
}

/** The payload of `work.charter-derived`. */
export interface WorkCharterDerivedPayload {
  readonly count: number;
  readonly role: string;
}

// Colleagues, documentation and the evaluation harness.

/** The payload of `coworker.replied`. */
export interface CoworkerRepliedPayload {
  readonly channelSlug: string;
  readonly responder: string;
}

/** The payload of `documentation.systems-discovered`. */
export interface DocumentationSystemsDiscoveredPayload {
  readonly sourceId: Id<'docSources'>;
  readonly systems: number;
  readonly created: number;
  readonly updated: number;
  readonly retired: number;
  readonly scheduled: number;
}

/** The payload of `evaluation.transport-ready`. */
export interface EvaluationTransportReadyPayload {
  readonly workItemId: WorkItemId;
  readonly checkpoint: string;
  readonly scope: string;
}

// The voice 1:1.

/** The payload of `voice.started`. */
export interface VoiceStartedPayload {
  readonly sessionId: SessionId;
  readonly mode: Doc<'voiceSessions'>['mode'];
}

/** The payload of `voice.answer-recorded`. */
export interface VoiceAnswerRecordedPayload {
  readonly topic: string;
}

/** The payload of `voice.finalisation-reclaimed`. */
export interface VoiceFinalisationReclaimedPayload {
  readonly sessionId: SessionId;
  readonly heldForMs: number;
  readonly claimedBy: VoiceFinisher;
}

/** The payload of `voice.completed`. */
export interface VoiceCompletedPayload {
  readonly sessionId: SessionId;
  readonly charterId: CharterId;
  readonly via: VoiceFinisher | 'unknown';
}

/** The payload of `voice.finalisation-failed`. */
export interface VoiceFinalisationFailedPayload {
  readonly sessionId: SessionId;
  readonly reason: string;
  readonly retryScheduled: boolean;
}

/** The payload of `voice.finalisation-abandoned`. */
export interface VoiceFinalisationAbandonedPayload {
  readonly sessionId: SessionId;
  readonly reason: string;
  readonly attempts: number;
  readonly hadTranscript: boolean;
}

// Skills.

/** The payload of `skill.authoring-refused`. */
export interface SkillAuthoringRefusedPayload extends SkillNamed {
  readonly attempted: 'authoring-progress' | 'register' | 'fail' | 'park-unverified' | 'defer';
  readonly state: Doc<'skills'>['state'];
}

/** The payload of `skill.builtin-installed`. */
export type SkillBuiltinInstalledPayload = SkillNamed;

/** The payload of `skill.proposed`. */
export interface SkillProposedPayload extends SkillNamed {
  readonly rationale: string;
  readonly forWorkItem: WorkItemId;
}

/** The payload of `skill.approved`. */
export interface SkillApprovedPayload extends SkillNamed {
  readonly scopes: string[];
}

/** The payload of `skill.rejected`. */
export type SkillRejectedPayload = SkillNamed;

/** The payload of `skill.revision-requested`. */
export type SkillRevisionRequestedPayload = SkillNamed;

/** The payload of `skill.retired`. */
export type SkillRetiredPayload = SkillReason;

/** The payload of `skill.authoring-superseded`. */
export interface SkillAuthoringSupersededPayload extends SkillNamed {
  readonly heldForMs: number;
}

/** The payload of `skill.authoring-claimed`. */
export interface SkillAuthoringClaimedPayload extends SkillNamed {
  readonly fromState: Doc<'skills'>['state'];
}

/** The payload of `skill.authoring`. */
export interface SkillAuthoringPayload {
  readonly skillId: SkillId;
  readonly sandboxId: string;
}

/** The payload of `skill.registered`. */
export type SkillRegisteredPayload = SkillNamed;

/** The payload of `skill.failed`. */
export type SkillFailedPayload = SkillReason;

/** The payload of `skill.author-failed`. */
export type SkillAuthorFailedPayload = SkillReason;

/** The payload of `skill.verification-failed`. */
export type SkillVerificationFailedPayload = SkillReason;

/** The payload of `skill.sandbox-skipped`. */
export type SkillSandboxSkippedPayload = SkillReason;

/** The payload of `skill.sandbox-waiting`. */
export interface SkillSandboxWaitingPayload extends SkillNamed {
  readonly heldForMs: number;
  readonly retryInMs: number;
}

/** The payload of `skill.authoring-deferred`: the model provider could not be reached. */
export interface SkillAuthoringDeferredPayload extends SkillReason {
  readonly retryInMs: number;
  /** This deferral's place in the run of them, from 1. */
  readonly attempt: number;
}

// Surfaces.

/** The payload of `surface.charter-match-ambiguous`. */
export interface SurfaceCharterMatchAmbiguousPayload {
  readonly namedSystem: string;
  readonly class: string;
  readonly candidateSlugs: string[];
}

/** The payload of `surface.proposed`. */
export interface SurfaceProposedPayload extends SurfaceNamed {
  readonly path?: string;
  readonly source?: 'revocation-evaluation-folder-fixture';
}

/** `surface.oriented` for a system orientation found a way to reach. */
export interface SurfaceOrientedProposed extends SurfaceNamed {
  readonly verdict: 'proposed';
}

/** `surface.oriented` for a system orientation found no way to reach, with where it looked. */
export interface SurfaceOrientedAbsent extends SurfaceNamed {
  readonly verdict: 'absent';
  readonly searched: string[];
}

/** The payload of `surface.oriented`, by what orientation found. */
export type SurfaceOrientedPayload = SurfaceOrientedProposed | SurfaceOrientedAbsent;

/** The payload of `surface.proposal-requested`. */
export interface SurfaceProposalRequestedPayload extends SurfaceNamed {
  readonly slug: string;
}

/** The payload of `surface.orientation-failed`. */
export type SurfaceOrientationFailedPayload = SurfaceReason;

/** The payload of `surface.app-provisioned`. */
export interface SurfaceAppProvisionedPayload extends SurfaceNamed {
  readonly appId: string;
  readonly appName: string;
}

/** The payload of `surface.install-failed`. */
export type SurfaceInstallFailedPayload = SurfaceReason;

/** The payload of `surface.shared-credential-retired`. */
export interface SurfaceSharedCredentialRetiredPayload extends SurfaceReason {
  readonly credentialId: Id<'credentials'>;
}

/**
 * The payload of `credential.superseded`: a page credential the synced
 * documentation no longer carries, as one agent's feed tells it. Never the
 * value, and never the ref's value fingerprint: the page alone.
 */
export interface CredentialSupersededPayload {
  readonly credentialId: Id<'credentials'>;
  readonly label: string;
  readonly sourceId: Id<'docSources'>;
  /** The page the credential was found on. */
  readonly page: string;
  /** This agent's surfaces it was bound to, each sent back to landing a credential. */
  readonly surfaceIds: readonly SurfaceId[];
}

/** The payload of `surface.reoriented`: orientation the manager's re-run placed for one surface. */
export type SurfaceReorientedPayload = SurfaceNamed;

/** The payload of `surface.app-installed`. */
export interface SurfaceAppInstalledPayload extends SurfaceNamed {
  readonly appId?: string;
}

/** The payload of `surface.probe-failed`. */
export interface SurfaceProbeFailedPayload extends SurfaceReason {
  readonly verdict: 'ungranted' | 'listed-dead';
}

/** The payload of `surface.probe-retried`. */
export interface SurfaceProbeRetriedPayload extends SurfaceReason {
  readonly path?: string;
  readonly retryAfterMs: number;
}

/** The payload of `surface.probe-demoted`. */
export interface SurfaceProbeDemotedPayload extends SurfaceReason {
  readonly from?: string;
  readonly to: string;
}

/** The payload of `surface.connected`. */
export interface SurfaceConnectedPayload extends SurfaceNamed {
  readonly withheldTools?: string[];
}

/** The payload of `surface.expired`. Older code wrote this without the end date. */
export interface SurfaceExpiredPayload extends SurfaceNamed {
  readonly expiresAt?: number;
}

/** The payload of `surface.access-set`. */
export interface SurfaceAccessSetPayload extends SurfaceNamed {
  readonly by: 'approval' | 'manager' | 'upgrade';
  readonly days: number;
  readonly expiresAt: number;
  readonly renewed?: boolean;
  /** The end date the upgrade replaced. */
  readonly from?: number;
}

/** The payload of `surface.expiring`. */
export interface SurfaceExpiringPayload extends SurfaceNamed {
  readonly expiresAt: number;
  /**
   * The calendar day, `YYYY-MM-DD` in the agent's zone, the week's notice
   * falls due (Q5, N12). Absent on a notice written before the zone.
   */
  readonly noticeDay?: string;
}

/** The payload of `surface.approved`. */
export type SurfaceApprovedPayload = SurfaceNamed;

/** The payload of `surface.rejected`. */
export type SurfaceRejectedPayload = SurfaceReason;

/** The payload of `surface.tools-approved`: the manager's approved list, and how it changed. */
export interface SurfaceToolsApprovedPayload extends SurfaceNamed {
  readonly tools: string[];
  readonly added: string[];
  readonly removed: string[];
}

/** The payload of `surface.reopened`. */
export type SurfaceReopenedPayload = SurfaceReason;

/** The payload of `surface.scope-reapproval-required`. */
export interface SurfaceScopeReapprovalRequiredPayload extends SurfaceNamed {
  readonly sourceId: Id<'docSources'>;
}

/** The payload of `surface.configuration-token-revoked`. */
export interface SurfaceConfigurationTokenRevokedPayload extends SurfaceNamed {
  readonly atProvider: boolean;
  readonly reason?: string;
}

/** The payload of `surface.app-unrecorded`. */
export interface SurfaceAppUnrecordedPayload extends SurfaceNamed {
  readonly appId?: string;
}

// Plans and their obligations.

/** The payload of `plan.obligations-judged`. */
export interface PlanObligationsJudgedPayload extends WorkItemNamed {
  readonly obligations: PlanObligations;
}

/** The payload of `plan.obligations-failed-open`. */
export interface PlanObligationsFailedOpenPayload extends WorkItemNamed {
  readonly reason: string;
  readonly planner?: PlannerObligations;
}

/** The payload of `plan.obligations-disagreed`. */
export interface PlanObligationsDisagreedPayload extends WorkItemNamed {
  readonly planner: PlannerObligations;
  readonly judgement: PlanObligations;
  readonly differences: string[];
}

/** The payload of `audit.corrected`. */
export interface AuditCorrectedPayload extends WorkItemRun {
  readonly removedIndices: number[];
  readonly reason: string;
}

// Work items: intake and evaluation.

/** The payload of `work.listed`. */
export interface WorkListedPayload extends WorkItemNamed {
  readonly tracker: TicketSnapshot;
  readonly refused?: string;
}

/** The payload of `work.withdrawn`. */
export interface WorkWithdrawnPayload extends WorkItemNamed {
  readonly reason: string;
  readonly fromState: Doc<'workItems'>['state'];
}

/** The payload of `work.returned`. */
export interface WorkReturnedPayload extends WorkItemNamed {
  readonly title: string;
}

/** The payload of `work.discovered`. */
export interface WorkDiscoveredPayload extends WorkItemNamed {
  readonly title: string;
  readonly tracker?: TicketSnapshot;
  readonly trialId?: string;
  readonly seededPastScopeStage?: true;
}

/** The payload of `work.scope-skip-overruled`. */
export interface WorkScopeSkipOverruledPayload extends WorkItemNamed {
  readonly basis: string;
  readonly namedBy?: string;
  readonly overruled?: string[];
}

/** The payload of `work.requeued`. */
export interface WorkRequeuedPayload extends WorkItemNamed {
  readonly trigger?: RequeueTrigger;
  readonly key?: string;
  /** The parked state the row left. */
  readonly previousState?: Doc<'workItems'>['state'];
  readonly surfaceId?: SurfaceId;
  readonly slug?: string;
  readonly previousMissingSurface?: string;
}

/** The payload of `work.reevaluation`. */
export interface WorkReevaluationPayload {
  readonly trigger: ReevaluationTrigger;
  readonly key: string;
  readonly readmitted: number;
  readonly examined: number;
}

/** The payload of `work.claim-refused`. */
export interface WorkClaimRefusedPayload extends WorkItemNamed {
  readonly key: string;
  readonly holder: ClaimHolder;
}

/** The payload of `work.evaluated`. */
export interface WorkEvaluatedPayload extends WorkItemNamed {
  readonly decision: string;
  readonly verdict: EvaluatedVerdict;
  readonly charterId?: CharterId;
  readonly charterVersion?: string;
}

/** The payload of `work.skipped`. */
export interface WorkSkippedPayload extends WorkItemNamed {
  readonly reason?: string;
}

/** The payload of `work.scope-judgement-unavailable`. */
export interface WorkScopeJudgementUnavailablePayload extends WorkItemNamed {
  readonly cause: string;
}

/** The payload of `work.evaluation-parked`: a row whose evaluation kept dying, and why the last one did. */
export interface WorkEvaluationParkedPayload extends WorkItemNamed {
  readonly attempts: number;
  readonly reason: 'evaluation-attempts-spent' | 'scope-judgement-unavailable';
}

/** The payload of `work.waiting-for-charter`. */
export type WorkWaitingForCharterPayload = WorkItemNamed;

/** The payload of `work.check-requested`. */
export interface WorkCheckRequestedPayload {
  readonly surfaceIds: SurfaceId[];
}

// Work items: planning.

/** The payload of `work.plan-grounding-read`. */
export interface WorkPlanGroundingReadPayload extends WorkItemNamed {
  readonly action: unknown;
  readonly applied?: unknown;
}

/** The payload of `work.plan-drafted`. */
export interface WorkPlanDraftedPayload extends WorkItemNamed {
  readonly plan: ExecutionPlan;
}

/**
 * The payload of `work.plan-redrafting`: a plan drafted while its system was
 * not connected, sent back to drafting now that it is (P7-18).
 */
export interface WorkPlanRedraftingPayload extends WorkItemNamed {
  readonly surfaceId: Id<'surfaces'>;
  readonly slug: string;
}

/** The payload of `work.corrections-applied`. */
export interface WorkCorrectionsAppliedPayload extends WorkItemNamed {
  readonly correctionIds: Id<'corrections'>[];
  readonly redaction?: 'structural-only';
}

/** The payload of `work.corrections-redaction-limited`. */
export interface WorkCorrectionsRedactionLimitedPayload extends WorkItemRun {
  readonly correctionIds: Id<'corrections'>[];
}

/** The payload of `work.correction-retired`. */
export interface WorkCorrectionRetiredPayload extends WorkItemNamed {
  readonly correctionId: Id<'corrections'>;
}

/** The payload of `work.draft-resumed`. */
export interface WorkDraftResumedPayload extends WorkItemNamed {
  readonly attempt: number;
}

/**
 * The payload of `work.execution-resumed`: a run whose execution failed on
 * the model, sent back to execute again (`attempt` counts from the last Retry).
 */
export interface WorkExecutionResumedPayload extends WorkItemRun {
  readonly attempt: number;
  readonly reason: string;
}

/** `work.plan-held` for a plan whose row the manager waived a skip on. */
export interface PlanHeldSkipOverruled extends WorkItemNamed {
  readonly reason: 'skip-overruled';
  readonly waived: 'scope' | 'quality-fit';
}

/** `work.plan-held` for a plan another employee's plan was rejected for (N3). */
export interface PlanHeldForRejection extends WorkItemNamed {
  readonly reason: 'plan-rejected-for-this-item';
  readonly rejectedWorkItemId: WorkItemId;
  readonly rejectedAgentId: Id<'agents'>;
  readonly rejectedAt: number;
  readonly rejection?: string;
}

/**
 * `work.plan-held` for a plan whose obligations judgement could not be
 * reached, so its declared reads and writes stand unchecked (E-70 D4).
 */
export interface PlanHeldObligationsFailedOpen extends WorkItemNamed {
  readonly reason: 'obligations-failed-open';
  /** Why the judgement was not reached, as the settlement recorded it. */
  readonly failure: string;
}

/**
 * `work.plan-held` for a plan drafted without its ticket or thread (P7-18):
 * nobody read what it acts on, so the switch does not run it.
 */
export interface PlanHeldDraftedWithout extends WorkItemNamed {
  readonly reason: 'drafted-without-record';
  /** The source system's surface slug. */
  readonly surfaceSlug: string;
  /** The system was not connected, or it was and the read did not land. */
  readonly cause: 'not-connected' | 'read-failed';
}

/** The payload of `work.plan-held`, by why the plan waits for the manager. */
export type WorkPlanHeldPayload =
  | PlanHeldSkipOverruled
  | PlanHeldForRejection
  | PlanHeldObligationsFailedOpen
  | PlanHeldDraftedWithout;

/** The payload of `work.plan-approved`. */
export interface WorkPlanApprovedPayload extends WorkItemNamed {
  readonly by?: 'autonomous';
  readonly decidedVia?: DecidedVia;
  readonly answered?: AnsweredQuestion[];
}

// Work items: the manager's decisions.

/** The payload of `work.decision-requesting`. */
export interface WorkDecisionRequestingPayload extends DecisionNamed {
  readonly kind: DecisionKind;
  readonly supersedes?: string;
}

/** The payload of `work.decision-request-resent`. */
export interface WorkDecisionRequestResentPayload extends DecisionNamed {
  readonly kind: DecisionKind;
  readonly reason: string;
}

/** The payload of `work.decision-request-failed`. */
export interface WorkDecisionRequestFailedPayload extends DecisionNamed {
  readonly kind: DecisionKind;
  readonly reason: string;
}

/** The payload of `work.decision-request-asked`. */
export interface WorkDecisionRequestAskedPayload extends WorkItemNamed {
  readonly kind: DecisionKind;
}

/** The payload of `work.decision-request-closing`: the edit that marks a decided request so in the DM. */
export type WorkDecisionRequestClosingPayload = DecisionNamed;

/** The payload of `work.decision-notifying`. */
export type WorkDecisionNotifyingPayload = DecisionNamed;

/** The payload of `work.decision-acknowledging`. */
export interface WorkDecisionAcknowledgingPayload extends DecisionNamed {
  readonly messageTs: string;
  readonly kind: 'received' | 'unknown';
}

/** The payload of `work.decision-ignored`. */
export interface WorkDecisionIgnoredPayload {
  readonly surfaceId: SurfaceId;
  readonly messageTs: string;
  readonly userId: string;
  readonly reason: string;
}

/** The payload of `work.decision-duplicate`. */
export interface WorkDecisionDuplicatePayload extends DecisionNamed {
  readonly messageTs: string;
}

/** The payload of `work.decision-batch-issued`. */
export interface WorkDecisionBatchIssuedPayload {
  readonly batchId: string;
  readonly members: DecisionBatchMember[];
}

/** The payload of `work.decision-batch-decided`. */
export interface WorkDecisionBatchDecidedPayload {
  readonly batchId: string;
  readonly outcome: 'approved' | 'rejected';
  readonly decided: string[];
  readonly skipped: SkippedBatchMember[];
  readonly messageTs: string;
}

// Work items: execution.

/** The payload of `work.retry`. */
export interface WorkRetryPayload extends WorkItemNamed {
  readonly resumeState: Doc<'workItems'>['state'];
  readonly fromState: Doc<'workItems'>['state'];
  readonly waived?: 'quality-fit' | 'scope';
  readonly feedback?: string;
}

/** The payload of `work.provider-reconciled`. */
export interface WorkProviderReconciledPayload extends WorkItemNamed {
  readonly actor: string;
  readonly confirmedAt: number;
  readonly entries: ReconciliationEntry[];
}

/** The payload of `work.dismissed`: a failed item (stopped or rejected) the manager set aside (N7). */
export type WorkDismissedPayload = WorkItemNamed;

/** The payload of `work.cancelled`. */
export interface WorkCancelledPayload extends WorkItemNamed {
  readonly reason: string;
  readonly skillId?: SkillId;
  readonly decidedVia?: DecidedVia;
}

/** The payload of `work.execution-claimed`. */
export interface WorkExecutionClaimedPayload extends WorkItemNamed {
  readonly skillId?: SkillId;
  readonly skillRegisteredAt?: number;
  readonly skillBodyHash?: string;
  readonly proposedFor?: WorkItemId;
  readonly arm?: 'baseline';
  readonly trialId?: string;
  readonly dependentPhase?: true;
}

/** The payload of `work.dependent-authoring`. */
export interface WorkDependentAuthoringPayload extends WorkItemRun {
  readonly prerequisiteActionCount: number;
  readonly output: unknown;
}

/** The payload of `work.dependent-authoring-claimed`. */
export type WorkDependentAuthoringClaimedPayload = WorkItemRun;

/** The payload of `work.completed`. */
export interface WorkCompletedPayload extends WorkItemNamed {
  readonly output: unknown;
  readonly runId?: RunId;
  readonly source?: 'revocation-evaluation-live-registry';
}

/** The payload of `work.failed`. */
export interface WorkFailedPayload extends WorkItemNamed {
  readonly reason?: string;
  readonly stopped?: true;
  readonly output?: unknown;
  readonly runId?: RunId;
  readonly source?: 'evaluation-harness' | 'revocation-evaluation-live-registry';
}

/** The payload of `work.actions-auto-applying`. */
export interface WorkActionsAutoApplyingPayload extends ActionSetSplit {
  readonly autonomousActions: boolean;
}

/** The payload of `work.actions-pending`. */
export interface WorkActionsPendingPayload extends ActionSetSplit {
  readonly autonomousActions?: boolean;
  readonly autoApplied?: true;
}

/** The payload of `work.actions-approved`. */
export interface WorkActionsApprovedPayload extends WorkItemRun {
  readonly approvedIndexes: number[];
  readonly rejectedIndexes: number[];
  readonly refusedIndexes: number[];
  readonly autoIndexes: number[];
  readonly decidedVia: DecidedVia;
}

/** The payload of `work.actions-rejected`. */
export interface WorkActionsRejectedPayload extends WorkItemNamed {
  readonly reason: string;
  readonly decidedVia: DecidedVia;
}

/** The payload of `work.actions-applying`. */
export interface WorkActionsApplyingPayload extends WorkItemRun {
  readonly phase: 'auto' | 'approved';
}

/** The payload of `work.actions-interrupted`. */
export interface WorkActionsInterruptedPayload extends WorkItemRun {
  readonly applyAttemptId: RunId;
}

/** The payload of `work.conditional-writes-withheld`. */
export interface WorkConditionalWritesWithheldPayload extends WorkItemRun {
  readonly phase: 'single' | 'prerequisite' | 'closing';
  readonly steps: number[];
  readonly withheld: string[];
}

/** The payload of `work.carried-reads-applied`. */
export interface WorkCarriedReadsAppliedPayload extends WorkItemRun {
  readonly indexes: number[];
  readonly surfaces: string[];
  readonly landed: boolean;
}

/** `work.closing-reauthored` because the holder of an item the set writes changed. */
export interface ClosingReauthoredForHolder extends WorkItemRun {
  readonly reason: 'holder-changed';
  readonly heldNow: string[];
}

/** `work.closing-reauthored` because a reply was owed or a claim withheld a write. */
export interface ClosingReauthoredForRound extends WorkItemRun {
  readonly reason: 'reply-owed' | 'claim-withheld';
  readonly withheldIndexes: number[];
}

/** The payload of `work.closing-reauthored`, by why the set was authored again. */
export type WorkClosingReauthoredPayload = ClosingReauthoredForHolder | ClosingReauthoredForRound;

/** The payload of `work.model-call`. */
export interface WorkModelCallPayload extends ModelCallReport {
  readonly workItemId?: WorkItemId;
  readonly skillId?: SkillId;
  readonly stage: ModelCallStage;
  readonly closingAuthoring?: ClosingAuthoring;
}

// Work items: what the manager is told.

/** The payload of `work.manager-note-sending`. */
export interface WorkManagerNoteSendingPayload extends WorkItemNamed {
  readonly noteId: Id<'managerNotes'>;
  readonly kind: Doc<'managerNotes'>['kind'];
}

/** The payload of `work.manager-note-failed`. */
export interface WorkManagerNoteFailedPayload extends WorkItemNamed {
  readonly noteId: Id<'managerNotes'>;
  readonly kind: Doc<'managerNotes'>['kind'];
  readonly reason: string;
}

/** The payload of `work.manager-digest-sending`. */
export interface WorkManagerDigestSendingPayload {
  readonly noteIds: Id<'managerNotes'>[];
  readonly count: number;
}

/** The payload of `work.manager-digest-failed`. */
export interface WorkManagerDigestFailedPayload {
  readonly noteIds: Id<'managerNotes'>[];
  readonly reason: string;
}

/**
 * Every event type and its payload. The keys are the contract's types; the
 * tuple below lists the same keys at run time.
 */
export interface EventPayloads {
  'agent.deployed': AgentDeployedPayload;
  'agent.notifications-changed': AgentNotificationsChangedPayload;
  'agent.zone-changed': AgentZoneChangedPayload;
  'agent.autonomy-changed': AgentAutonomyChangedPayload;
  'agent.retired': AgentRetiredPayload;
  'permission.granted': PermissionGrantedPayload;
  'permission.revoked': PermissionRevokedPayload;
  'manager.changed': ManagerChangedPayload;
  'manager.transfer-asked': ManagerTransferAskedPayload;
  'manager.transfer-cancelled': ManagerTransferCancelledPayload;
  'manager.transfer-declined': ManagerTransferDeclinedPayload;
  'manager.transfer-expired': ManagerTransferExpiredPayload;
  'charter.drafted': CharterDraftedPayload;
  'charter.approved': CharterApprovedPayload;
  'charter.amended': CharterAmendedPayload;
  'charter.request_changes': CharterRequestChangesPayload;
  'charter.question-asked': CharterQuestionAskedPayload;
  'charter.question-answered': CharterQuestionAnsweredPayload;
  'charter.evidence-rejected': CharterEvidenceRejectedPayload;
  'charter.seeding-failed': CharterSeedingFailedPayload;
  'work.charter-derived': WorkCharterDerivedPayload;
  'coworker.replied': CoworkerRepliedPayload;
  'documentation.systems-discovered': DocumentationSystemsDiscoveredPayload;
  'evaluation.transport-ready': EvaluationTransportReadyPayload;
  'voice.started': VoiceStartedPayload;
  'voice.answer-recorded': VoiceAnswerRecordedPayload;
  'voice.finalisation-reclaimed': VoiceFinalisationReclaimedPayload;
  'voice.completed': VoiceCompletedPayload;
  'voice.finalisation-failed': VoiceFinalisationFailedPayload;
  'voice.finalisation-abandoned': VoiceFinalisationAbandonedPayload;
  'skill.authoring-refused': SkillAuthoringRefusedPayload;
  'skill.builtin-installed': SkillBuiltinInstalledPayload;
  'skill.proposed': SkillProposedPayload;
  'skill.approved': SkillApprovedPayload;
  'skill.rejected': SkillRejectedPayload;
  'skill.revision-requested': SkillRevisionRequestedPayload;
  'skill.retired': SkillRetiredPayload;
  'skill.authoring-superseded': SkillAuthoringSupersededPayload;
  'skill.authoring-claimed': SkillAuthoringClaimedPayload;
  'skill.authoring': SkillAuthoringPayload;
  'skill.registered': SkillRegisteredPayload;
  'skill.failed': SkillFailedPayload;
  'skill.author-failed': SkillAuthorFailedPayload;
  'skill.verification-failed': SkillVerificationFailedPayload;
  'skill.sandbox-skipped': SkillSandboxSkippedPayload;
  'skill.sandbox-waiting': SkillSandboxWaitingPayload;
  'skill.authoring-deferred': SkillAuthoringDeferredPayload;
  'surface.charter-match-ambiguous': SurfaceCharterMatchAmbiguousPayload;
  'surface.proposed': SurfaceProposedPayload;
  'surface.oriented': SurfaceOrientedPayload;
  'surface.proposal-requested': SurfaceProposalRequestedPayload;
  'surface.orientation-failed': SurfaceOrientationFailedPayload;
  'surface.app-provisioned': SurfaceAppProvisionedPayload;
  'surface.install-failed': SurfaceInstallFailedPayload;
  'surface.shared-credential-retired': SurfaceSharedCredentialRetiredPayload;
  'credential.superseded': CredentialSupersededPayload;
  'surface.reoriented': SurfaceReorientedPayload;
  'surface.app-installed': SurfaceAppInstalledPayload;
  'surface.probe-failed': SurfaceProbeFailedPayload;
  'surface.probe-retried': SurfaceProbeRetriedPayload;
  'surface.probe-demoted': SurfaceProbeDemotedPayload;
  'surface.connected': SurfaceConnectedPayload;
  'surface.expired': SurfaceExpiredPayload;
  'surface.access-set': SurfaceAccessSetPayload;
  'surface.expiring': SurfaceExpiringPayload;
  'surface.approved': SurfaceApprovedPayload;
  'surface.rejected': SurfaceRejectedPayload;
  'surface.tools-approved': SurfaceToolsApprovedPayload;
  'surface.reopened': SurfaceReopenedPayload;
  'surface.scope-reapproval-required': SurfaceScopeReapprovalRequiredPayload;
  'surface.configuration-token-revoked': SurfaceConfigurationTokenRevokedPayload;
  'surface.app-unrecorded': SurfaceAppUnrecordedPayload;
  'plan.obligations-judged': PlanObligationsJudgedPayload;
  'plan.obligations-failed-open': PlanObligationsFailedOpenPayload;
  'plan.obligations-disagreed': PlanObligationsDisagreedPayload;
  'audit.corrected': AuditCorrectedPayload;
  'work.listed': WorkListedPayload;
  'work.withdrawn': WorkWithdrawnPayload;
  'work.returned': WorkReturnedPayload;
  'work.discovered': WorkDiscoveredPayload;
  'work.scope-skip-overruled': WorkScopeSkipOverruledPayload;
  'work.requeued': WorkRequeuedPayload;
  'work.reevaluation': WorkReevaluationPayload;
  'work.claim-refused': WorkClaimRefusedPayload;
  'work.evaluated': WorkEvaluatedPayload;
  'work.skipped': WorkSkippedPayload;
  'work.scope-judgement-unavailable': WorkScopeJudgementUnavailablePayload;
  'work.evaluation-parked': WorkEvaluationParkedPayload;
  'work.waiting-for-charter': WorkWaitingForCharterPayload;
  'work.check-requested': WorkCheckRequestedPayload;
  'work.plan-grounding-read': WorkPlanGroundingReadPayload;
  'work.plan-drafted': WorkPlanDraftedPayload;
  'work.plan-redrafting': WorkPlanRedraftingPayload;
  'work.corrections-applied': WorkCorrectionsAppliedPayload;
  'work.corrections-redaction-limited': WorkCorrectionsRedactionLimitedPayload;
  'work.correction-retired': WorkCorrectionRetiredPayload;
  'work.draft-resumed': WorkDraftResumedPayload;
  'work.execution-resumed': WorkExecutionResumedPayload;
  'work.plan-held': WorkPlanHeldPayload;
  'work.plan-approved': WorkPlanApprovedPayload;
  'work.decision-requesting': WorkDecisionRequestingPayload;
  'work.decision-request-resent': WorkDecisionRequestResentPayload;
  'work.decision-request-failed': WorkDecisionRequestFailedPayload;
  'work.decision-request-asked': WorkDecisionRequestAskedPayload;
  'work.decision-notifying': WorkDecisionNotifyingPayload;
  'work.decision-request-closing': WorkDecisionRequestClosingPayload;
  'work.decision-acknowledging': WorkDecisionAcknowledgingPayload;
  'work.decision-ignored': WorkDecisionIgnoredPayload;
  'work.decision-duplicate': WorkDecisionDuplicatePayload;
  'work.decision-batch-issued': WorkDecisionBatchIssuedPayload;
  'work.decision-batch-decided': WorkDecisionBatchDecidedPayload;
  'work.retry': WorkRetryPayload;
  'work.provider-reconciled': WorkProviderReconciledPayload;
  'work.cancelled': WorkCancelledPayload;
  'work.dismissed': WorkDismissedPayload;
  'work.execution-claimed': WorkExecutionClaimedPayload;
  'work.dependent-authoring': WorkDependentAuthoringPayload;
  'work.dependent-authoring-claimed': WorkDependentAuthoringClaimedPayload;
  'work.completed': WorkCompletedPayload;
  'work.failed': WorkFailedPayload;
  'work.actions-auto-applying': WorkActionsAutoApplyingPayload;
  'work.actions-pending': WorkActionsPendingPayload;
  'work.actions-approved': WorkActionsApprovedPayload;
  'work.actions-rejected': WorkActionsRejectedPayload;
  'work.actions-applying': WorkActionsApplyingPayload;
  'work.actions-interrupted': WorkActionsInterruptedPayload;
  'work.conditional-writes-withheld': WorkConditionalWritesWithheldPayload;
  'work.carried-reads-applied': WorkCarriedReadsAppliedPayload;
  'work.closing-reauthored': WorkClosingReauthoredPayload;
  'work.model-call': WorkModelCallPayload;
  'work.manager-note-sending': WorkManagerNoteSendingPayload;
  'work.manager-note-failed': WorkManagerNoteFailedPayload;
  'work.manager-digest-sending': WorkManagerDigestSendingPayload;
  'work.manager-digest-failed': WorkManagerDigestFailedPayload;
}

/** One event type of the contract. */
export type EventType = keyof EventPayloads;

/**
 * A tuple checked to name every key of `Of`: a key it leaves out makes the
 * argument `never`, so the typecheck fails at the call.
 */
function everyKey<Of extends string>() {
  return <const Tuple extends readonly Of[]>(
    tuple: Tuple & ([Of] extends [Tuple[number]] ? unknown : never),
  ): Tuple => tuple;
}

/** Every event type Day0 writes, at run time. */
export const EVENT_TYPES = everyKey<EventType>()([
  'agent.deployed',
  'agent.notifications-changed',
  'agent.zone-changed',
  'agent.autonomy-changed',
  'agent.retired',
  'permission.granted',
  'permission.revoked',
  'manager.changed',
  'manager.transfer-asked',
  'manager.transfer-cancelled',
  'manager.transfer-declined',
  'manager.transfer-expired',
  'charter.drafted',
  'charter.approved',
  'charter.amended',
  'charter.request_changes',
  'charter.question-asked',
  'charter.question-answered',
  'charter.evidence-rejected',
  'charter.seeding-failed',
  'work.charter-derived',
  'coworker.replied',
  'documentation.systems-discovered',
  'evaluation.transport-ready',
  'voice.started',
  'voice.answer-recorded',
  'voice.finalisation-reclaimed',
  'voice.completed',
  'voice.finalisation-failed',
  'voice.finalisation-abandoned',
  'skill.authoring-refused',
  'skill.builtin-installed',
  'skill.proposed',
  'skill.approved',
  'skill.rejected',
  'skill.revision-requested',
  'skill.retired',
  'skill.authoring-superseded',
  'skill.authoring-claimed',
  'skill.authoring',
  'skill.registered',
  'skill.failed',
  'skill.author-failed',
  'skill.verification-failed',
  'skill.sandbox-skipped',
  'skill.sandbox-waiting',
  'skill.authoring-deferred',
  'surface.charter-match-ambiguous',
  'surface.proposed',
  'surface.oriented',
  'surface.proposal-requested',
  'surface.orientation-failed',
  'surface.app-provisioned',
  'surface.install-failed',
  'surface.shared-credential-retired',
  'credential.superseded',
  'surface.reoriented',
  'surface.app-installed',
  'surface.probe-failed',
  'surface.probe-retried',
  'surface.probe-demoted',
  'surface.connected',
  'surface.expired',
  'surface.access-set',
  'surface.expiring',
  'surface.approved',
  'surface.rejected',
  'surface.tools-approved',
  'surface.reopened',
  'surface.scope-reapproval-required',
  'surface.configuration-token-revoked',
  'surface.app-unrecorded',
  'plan.obligations-judged',
  'plan.obligations-failed-open',
  'plan.obligations-disagreed',
  'audit.corrected',
  'work.listed',
  'work.withdrawn',
  'work.returned',
  'work.discovered',
  'work.scope-skip-overruled',
  'work.requeued',
  'work.reevaluation',
  'work.claim-refused',
  'work.evaluated',
  'work.skipped',
  'work.scope-judgement-unavailable',
  'work.evaluation-parked',
  'work.waiting-for-charter',
  'work.check-requested',
  'work.plan-grounding-read',
  'work.plan-drafted',
  'work.plan-redrafting',
  'work.corrections-applied',
  'work.corrections-redaction-limited',
  'work.correction-retired',
  'work.draft-resumed',
  'work.execution-resumed',
  'work.plan-held',
  'work.plan-approved',
  'work.decision-requesting',
  'work.decision-request-resent',
  'work.decision-request-failed',
  'work.decision-request-asked',
  'work.decision-notifying',
  'work.decision-request-closing',
  'work.decision-acknowledging',
  'work.decision-ignored',
  'work.decision-duplicate',
  'work.decision-batch-issued',
  'work.decision-batch-decided',
  'work.retry',
  'work.provider-reconciled',
  'work.cancelled',
  'work.dismissed',
  'work.execution-claimed',
  'work.dependent-authoring',
  'work.dependent-authoring-claimed',
  'work.completed',
  'work.failed',
  'work.actions-auto-applying',
  'work.actions-pending',
  'work.actions-approved',
  'work.actions-rejected',
  'work.actions-applying',
  'work.actions-interrupted',
  'work.conditional-writes-withheld',
  'work.carried-reads-applied',
  'work.closing-reauthored',
  'work.model-call',
  'work.manager-note-sending',
  'work.manager-note-failed',
  'work.manager-digest-sending',
  'work.manager-digest-failed',
]);

const LISTED: ReadonlySet<string> = new Set(EVENT_TYPES);

/**
 * Whether a value is one of the contract's event types.
 *
 * @returns True for a listed type; false for anything else, a type an older
 *   release wrote and this one no longer does included.
 */
export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && LISTED.has(value);
}

/** An event of one type as a writer hands it over, before the ledger stamps it. */
export interface EventOf<Type extends EventType> {
  readonly type: Type;
  readonly payload: EventPayloads[Type];
}

/** Any one event of the contract: the discriminated union over every type. */
export type DayZeroEvent = { [Type in EventType]: EventOf<Type> }[EventType];

/** An event a mutation appends in its own transaction (`appendEvent`). */
export type NewEvent = {
  [Type in EventType]: EventOf<Type> & {
    readonly agentId: Id<'agents'>;
    readonly createdAt: number;
  };
}[EventType];

/** An event an action logs through `eventLog.log` (`logEvent`), stamped when it lands. */
export type LoggedEvent = {
  [Type in EventType]: EventOf<Type> & { readonly agentId: Id<'agents'> };
}[EventType];

/** A stored event row, typed by the contract when its type is one the contract lists. */
export type StoredEvent<Type extends EventType = EventType> = Omit<
  Doc<'events'>,
  'type' | 'payload'
> &
  EventOf<Type>;

/**
 * Whether a stored row is an event of one type, narrowing its payload to that
 * type's. A row an older release wrote may still lack a field a newer writer
 * adds, so a reader that turns a field into a figure checks it.
 *
 * @param row - A row of `events`, or one of an export's `events` section.
 * @param type - The type to test for.
 */
export function isEventOf<Type extends EventType>(
  row: Pick<Doc<'events'>, 'type' | 'payload'>,
  type: Type,
): row is Pick<Doc<'events'>, 'type' | 'payload'> & EventOf<Type> {
  return row.type === type;
}
