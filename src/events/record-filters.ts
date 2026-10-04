import type { Doc } from '../../convex/_generated/dataModel';
import { EVENT_TYPES, type EventType } from './contract';

/**
 * The ways the Record tab narrows the employee's record (round two section 3.9): what it wrote
 * or meant to write, what the manager decided, what it read, what was refused or set aside, and
 * the charter's own history. Every event is in the whole record; a filter shows a part of it.
 */
export const RECORD_FILTERS = ['writes', 'decisions', 'reads', 'refused', 'charter'] as const;

/** One of the Record tab's filters. */
export type RecordFilter = (typeof RECORD_FILTERS)[number];

const WRITES = ['writes'] as const;
const DECISIONS = ['decisions'] as const;
const READS = ['reads'] as const;
const REFUSED = ['refused'] as const;
const CHARTER = ['charter'] as const;
const NONE = [] as const;

/**
 * The filters each event type is shown under, beside the whole record.
 *
 * Keyed by the contract's union, so a type the contract gains without a place here fails the
 * typecheck. A type can sit under several (a held set the manager rejected is a decision and a
 * refusal) or none (the run's own bookkeeping, shown only in the whole record). The grouping is by
 * type: a plan approved under autonomous actions is still listed under the manager's decisions,
 * as turning the switch on was the manager's.
 */
export const RECORD_FILTER_OF: { readonly [Type in EventType]: readonly RecordFilter[] } = {
  'agent.deployed': DECISIONS,
  'agent.notifications-changed': DECISIONS,
  'agent.zone-changed': DECISIONS,
  'agent.autonomy-changed': DECISIONS,
  'agent.retired': DECISIONS,
  'permission.granted': DECISIONS,
  'permission.revoked': DECISIONS,
  'manager.changed': DECISIONS,
  'manager.transfer-asked': DECISIONS,
  'manager.transfer-cancelled': DECISIONS,
  'manager.transfer-declined': ['decisions', 'refused'],
  'manager.transfer-expired': REFUSED,
  'manager.transfer-notice': WRITES,
  'manager.transfer-note-withheld': REFUSED,
  'manager.transfer-settle-failed': NONE,
  'manager.transfer-ended': REFUSED,
  'manager.transferred': DECISIONS,
  'charter.drafted': CHARTER,
  'charter.approved': ['charter', 'decisions'],
  'charter.amended': ['charter', 'decisions'],
  'charter.request_changes': ['charter', 'decisions'],
  'charter.question-asked': CHARTER,
  'charter.question-answered': ['charter', 'decisions'],
  'charter.evidence-rejected': ['charter', 'refused'],
  'charter.seeding-failed': CHARTER,
  'work.charter-derived': CHARTER,
  'coworker.replied': READS,
  'documentation.systems-discovered': READS,
  'evaluation.transport-ready': NONE,
  'voice.started': CHARTER,
  'voice.answer-recorded': CHARTER,
  'voice.finalisation-reclaimed': CHARTER,
  'voice.completed': CHARTER,
  'voice.finalisation-failed': CHARTER,
  'voice.finalisation-abandoned': CHARTER,
  'voice.restarted': CHARTER,
  'skill.authoring-refused': REFUSED,
  'skill.builtin-installed': NONE,
  'skill.proposed': NONE,
  'skill.approved': DECISIONS,
  'skill.rejected': ['decisions', 'refused'],
  'skill.revision-requested': DECISIONS,
  'skill.retired': DECISIONS,
  'skill.revoked': ['decisions', 'refused'],
  'skill.given-up': ['decisions', 'refused'],
  'skill.rechecked': NONE,
  'skill.superseded': NONE,
  'skill.authoring-superseded': NONE,
  'skill.authoring-claimed': NONE,
  'skill.authoring': NONE,
  'skill.registered': NONE,
  'skill.recheck-due': NONE,
  'skill.adoption-offered': NONE,
  'skill.adopted': DECISIONS,
  'skill.failed': REFUSED,
  'skill.author-failed': REFUSED,
  'skill.verification-failed': REFUSED,
  'skill.sandbox-skipped': NONE,
  'skill.sandbox-waiting': NONE,
  'skill.authoring-deferred': NONE,
  'surface.charter-match-ambiguous': NONE,
  'surface.proposed': NONE,
  'surface.oriented': READS,
  'surface.proposal-requested': DECISIONS,
  'surface.orientation-failed': NONE,
  'surface.app-provisioned': NONE,
  'surface.socket-token-landed': NONE,
  'surface.install-failed': NONE,
  'surface.shared-credential-retired': NONE,
  'credential.superseded': READS,
  'surface.reoriented': DECISIONS,
  'surface.app-installed': NONE,
  'surface.probe-failed': READS,
  'surface.probe-retried': READS,
  'surface.probe-demoted': READS,
  'surface.connected': READS,
  'surface.expired': NONE,
  'surface.access-set': DECISIONS,
  'surface.expiring': NONE,
  'surface.approved': DECISIONS,
  'surface.rejected': ['decisions', 'refused'],
  'surface.tools-approved': DECISIONS,
  'surface.reopened': NONE,
  'surface.scope-reapproval-required': READS,
  'surface.configuration-token-revoked': NONE,
  'surface.app-unrecorded': NONE,
  'surface.access-requested': DECISIONS,
  'organisation.connection-landed': NONE,
  'organisation.connection-rotated': NONE,
  'organisation.connection-corrected': NONE,
  'organisation.connection-revoked': NONE,
  'surface.authorised': NONE,
  'surface.authorisation-failed': NONE,
  'surface.disconnected': DECISIONS,
  'credential.revoked-at-source': NONE,
  'organisation.revoked-at-source': NONE,
  'organisation.configuration-used': NONE,
  'surface.channels-rejoined': NONE,
  'plan.obligations-judged': NONE,
  'plan.obligations-failed-open': NONE,
  'plan.obligations-disagreed': NONE,
  'audit.corrected': ['writes', 'refused'],
  'work.listed': READS,
  'work.withdrawn': REFUSED,
  'work.returned': NONE,
  'work.discovered': READS,
  'work.scope-skip-overruled': NONE,
  'work.requeued': NONE,
  'work.waiting-for-skill': NONE,
  'work.reevaluation': NONE,
  'work.claim-refused': REFUSED,
  'work.evaluated': NONE,
  'work.skipped': REFUSED,
  'work.scope-judgement-unavailable': NONE,
  'work.evaluation-parked': NONE,
  'work.waiting-for-charter': NONE,
  'work.check-requested': ['reads', 'decisions'],
  'work.plan-grounding-read': READS,
  'work.plan-drafted': NONE,
  'work.plan-redrafting': NONE,
  'work.corrections-applied': READS,
  'work.corrections-redaction-limited': NONE,
  'work.correction-retired': DECISIONS,
  'work.draft-resumed': NONE,
  'work.execution-resumed': NONE,
  'work.plan-held': NONE,
  'work.plan-approved': DECISIONS,
  'work.decision-requesting': WRITES,
  'work.decision-request-resent': WRITES,
  'work.decision-request-failed': WRITES,
  'work.decision-request-asked': WRITES,
  'work.decision-notifying': WRITES,
  'work.decision-request-closing': WRITES,
  'work.decision-request-replacing': WRITES,
  'work.decision-acknowledging': WRITES,
  'work.decision-ignored': REFUSED,
  'work.decision-duplicate': NONE,
  'work.decision-batch-issued': WRITES,
  'work.decision-batch-decided': DECISIONS,
  'work.retry': DECISIONS,
  'work.provider-reconciled': ['writes', 'decisions'],
  'work.cancelled': ['decisions', 'refused'],
  'work.dismissed': DECISIONS,
  'work.stopped': DECISIONS,
  'work.closed-without-retry': DECISIONS,
  'work.actions-withheld': ['writes', 'refused'],
  'work.execution-claimed': NONE,
  'work.dependent-authoring': NONE,
  'work.dependent-authoring-claimed': NONE,
  'work.completed': WRITES,
  'work.failed': NONE,
  'work.actions-auto-applying': WRITES,
  'work.actions-pending': WRITES,
  'work.actions-approved': ['writes', 'decisions'],
  'work.actions-rejected': ['writes', 'decisions', 'refused'],
  'work.actions-applying': WRITES,
  'work.actions-interrupted': WRITES,
  'work.conditional-writes-withheld': ['writes', 'refused'],
  'work.carried-reads-applied': READS,
  'work.closing-reauthored': NONE,
  'work.model-call': NONE,
  'work.manager-note-sending': WRITES,
  'work.manager-note-failed': WRITES,
  'work.manager-digest-sending': WRITES,
  'work.manager-digest-failed': WRITES,
};

/**
 * The event types one filter shows, in the contract's order.
 *
 * @param filter - The filter the manager chose.
 */
export function eventTypesIn(filter: RecordFilter): readonly EventType[] {
  return EVENT_TYPES.filter((type) => RECORD_FILTER_OF[type].includes(filter));
}

/**
 * One line of the record as the Record tab reads it: the stored event, the title of the work item
 * it is about and the name of the connection it is about, each when it names one that still
 * exists.
 */
export interface RecordEntry {
  readonly event: Doc<'events'>;
  readonly itemTitle?: string;
  readonly connection?: string;
}
