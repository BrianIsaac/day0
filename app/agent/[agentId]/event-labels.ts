import type { Doc } from '@convex/_generated/dataModel';
import {
  isEventType,
  type EventPayloads,
  type EventType,
  type WorkPlanHeldPayload,
} from '@/events/contract';
import type { RecordKind } from '../../components/RecordLine';
import { judgedAs, REEVALUATION } from './verdict-words';

/**
 * A payload as the feed reads it: a row an older release wrote may lack any
 * field a newer writer adds, so every field is optional here and each label
 * checks what it prints.
 */
type Read<Type extends EventType> = Readonly<Partial<EventPayloads[Type]>>;

/** One label per event type: fixed words, or words built from the payload. */
type Label<Type extends EventType> = string | ((payload: Read<Type>) => string);

/** A string field, or nothing when an older row lacks it or holds something else. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** ` (reason)` when the row carries one. */
function because(value: unknown): string {
  const reason = text(value);
  return reason ? ` (${reason.replace(/\.$/, '')})` : '';
}

/** An evaluation's words, or the verdict's own name when an older row holds one no longer made. */
function evaluatedWords(decision: unknown): string {
  const name = text(decision);
  if (name === undefined) return 'evaluated';
  if (name === REEVALUATION) return 'to be judged again: its skill is ready';
  const judged = judgedAs(name);
  return judged === undefined ? `evaluated: ${name}` : `judged ${judged}`;
}

/** `3 tools`, `1 tool`. */
function counted(value: unknown, noun: string, plural = `${noun}s`): string | undefined {
  return typeof value === 'number' ? `${value} ${value === 1 ? noun : plural}` : undefined;
}

/** A list of names, or nothing when the row carries none. */
function listed(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((name): name is string => typeof name === 'string');
  return names.length > 0 ? names.join(', ') : undefined;
}

/** ` v2 by Priya` for a library version an adoption event names, or what of it the row carries. */
function byVersion(payload: { readonly version?: unknown; readonly authorName?: unknown }): string {
  const version = typeof payload.version === 'number' ? ` v${payload.version}` : '';
  const author = text(payload.authorName);
  return `${version}${author ? ` by ${author}` : ''}`;
}

/** How long a duration reads in the feed: `90 s`, `4 min`, `2 h`. */
function duration(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** Where the manager decided: the dashboard or the chat surface. */
function decidedFrom(via: unknown): string {
  if (via === 'channel') return ' from the chat surface';
  if (via === 'dashboard') return ' from the dashboard';
  return '';
}

/** What a decision request asks for. */
function decisionNoun(kind: unknown): string {
  return kind === 'actions' ? 'held actions' : 'plan';
}

/** Why a row was sent back to be evaluated again, in words. */
const REQUEUE_TRIGGER_WORDS: Readonly<Record<string, string>> = {
  charter: 'the charter changed',
  documentation: 'the documentation changed',
  surface: 'a connection changed',
  'claim-released': 'a colleague let the ticket go',
  'verdict-write': 'what it waited on landed as it was judged',
  check: 'Check for new work found what it waited on',
  'skill-registered': 'the skill it waited on registered',
};

/** The stage a model call belongs to, in words. */
const MODEL_CALL_STAGE_WORDS: Readonly<Record<string, string>> = {
  evaluation: 'evaluation',
  draft: 'plan draft',
  execution: 'run',
  closing: 'closing',
  authoring: 'skill authoring',
};

/** A model call's report: the stage, and how it ended. */
function modelCallLabel(payload: Read<'work.model-call'>): string {
  const stage = text(payload.stage);
  const stageWords = stage ? ` · ${MODEL_CALL_STAGE_WORDS[stage] ?? stage}` : '';
  const outcome = text(payload.outcome) ?? 'unknown';
  const attempts =
    outcome !== 'ok' && typeof payload.attempts === 'number' && payload.attempts > 1
      ? ` after ${payload.attempts} attempts`
      : '';
  const status = typeof payload.statusCode === 'number' ? ` (HTTP ${payload.statusCode})` : '';
  return `model call${stageWords} · ${outcome}${attempts}${status}`;
}

/**
 * The feed's words for every event type the contract lists.
 *
 * Keyed by the contract's union, so a type the contract gains without a label
 * here fails the typecheck (review m37): the feed never falls back to a raw
 * type string for an event Day0 writes today.
 */
/** Why a held plan waits, in the manager's words, by the hold's reason. */
const PLAN_HELD_WORDS: { readonly [Reason in WorkPlanHeldPayload['reason']]: string } = {
  'skip-overruled': 'you waived the skip',
  'plan-rejected-for-this-item': "a colleague's plan for this ticket was rejected",
  'obligations-failed-open': 'its reads and writes could not be checked',
  'drafted-without-record': 'it was drafted without reading its ticket or thread',
  'approved-by-predecessor': 'approved by your predecessor; approve it again',
};

/** Why a held plan waits, or a plain line for a reason this build does not know. */
function planHeldWords(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(PLAN_HELD_WORDS, reason)
    ? PLAN_HELD_WORDS[reason as WorkPlanHeldPayload['reason']]
    : 'it waits for your decision';
}

const LABELS: { readonly [Type in EventType]: Label<Type> } = {
  'agent.deployed': (payload) =>
    `deployed, reporting to ${text(payload.bossEmail) ?? 'the manager'}${
      text(payload.zone) ? `, on ${payload.zone} time` : ''
    }`,
  'agent.notifications-changed': (payload) =>
    `run notes to the manager changed to ${payload.to === 'digest' ? 'an hourly digest' : 'each run'}`,
  'agent.zone-changed': (payload) =>
    `the employee's day moved${text(payload.from) ? ` from ${payload.from}` : ''}${
      text(payload.to) ? ` to ${payload.to}` : ''
    }`,
  'agent.autonomy-changed': (payload) =>
    payload.to === true ? 'autonomous actions turned on' : 'autonomous actions turned off',
  'agent.retired': 'employee retired',
  'permission.granted': (payload) =>
    `${text(payload.scope) ?? 'a permission'} granted${text(payload.source) ? ` (${payload.source})` : ''}`,
  'permission.revoked': (payload) =>
    `${text(payload.scope) ?? 'a permission'} revoked by the manager`,
  'manager.changed': (payload) => {
    if (payload.via === 'probe')
      return 'the chat surface found a different manager and moved the DM to them';
    const to = 'bossEmail' in payload ? text(payload.bossEmail) : undefined;
    if (payload.via === 'adopted') {
      return `the owner made themselves the manager${to ? ` (${to})` : ''}`;
    }
    return `manager changed${to ? ` to ${to}` : ''} on the dashboard`;
  },
  'manager.transfer-asked': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} asked`,
  'manager.transfer-cancelled': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} cancelled${
      payload.reason === 'retired'
        ? ' at the retire'
        : payload.reason === 'address-changed'
          ? ' for another address'
          : ''
    }`,
  'manager.transfer-declined': (payload) =>
    `${text(payload.toAddress) ?? 'the named manager'} declined the handover`,
  'manager.transfer-expired': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} expired`,
  'manager.transferred': (payload) => {
    const from = text(payload.fromAddress);
    const to = text(payload.toAddress);
    const cut = counted(
      Array.isArray(payload.surfacesCut) ? payload.surfacesCut.length : undefined,
      'connection',
    );
    return `handed over${from ? ` from ${from}` : ''}${to ? ` to ${to}` : ''}${cut ? `, ${cut} cut` : ''}`;
  },
  'charter.drafted': (payload) => `charter v${text(payload.version) ?? '?'} drafted`,
  'charter.approved': (payload) => {
    const struck = counted(payload.struckConstraints?.length, 'rule');
    return `charter v${text(payload.version) ?? '?'} approved${struck ? `, ${struck} struck` : ''}`;
  },
  'charter.amended': (payload) =>
    `charter amended to v${text(payload.version) ?? '?'}${
      payload.via === 'plan-approval' ? ' with a plan approval' : ''
    }`,
  'charter.request_changes': 'charter sent back for changes',
  'charter.question-asked': (payload) =>
    `charter question asked${text(payload.question) ? `: ${payload.question}` : ''}`,
  'charter.question-answered': (payload) =>
    `charter question answered${decidedFrom(payload.via === 'plan-approval' ? undefined : payload.via)}${
      payload.via === 'plan-approval' ? ' with a plan approval' : ''
    }${payload.amended === true ? ', charter amended' : ''}`,
  'charter.evidence-rejected': (payload) =>
    `${counted(payload.count, 'charter line') ?? 'charter lines'} dropped: not backed by the 1:1`,
  'charter.seeding-failed': (payload) =>
    `seeding the approved charter failed${text(payload.reason) ? `: ${payload.reason}` : ''}${
      payload.retrying === true ? ' · trying again' : ' · gave up'
    }`,
  'work.charter-derived': (payload) =>
    `${counted(payload.count, 'work item') ?? 'work items'} seeded from the charter`,
  'coworker.replied': (payload) =>
    `${text(payload.responder) ?? 'a colleague'} replied${text(payload.channelSlug) ? ` in #${payload.channelSlug}` : ''}`,
  'documentation.systems-discovered': (payload) =>
    `documentation read: ${counted(payload.systems, 'system') ?? 'systems'} found${
      typeof payload.created === 'number' && payload.created > 0 ? `, ${payload.created} new` : ''
    }${typeof payload.retired === 'number' && payload.retired > 0 ? `, ${payload.retired} gone` : ''}`,
  'evaluation.transport-ready': 'evaluation transport ready',
  'voice.started': (payload) =>
    payload.mode === 'chat' ? 'Day-1 1:1 started (chat)' : 'Day-1 1:1 started (voice)',
  'voice.answer-recorded': (payload) =>
    `1:1 answer recorded${text(payload.topic) ? `: ${payload.topic}` : ''}`,
  'voice.finalisation-reclaimed': (payload) =>
    `1:1 wrap-up taken over${duration(payload.heldForMs) ? ` after ${duration(payload.heldForMs)}` : ''}`,
  'voice.completed': 'Day-1 1:1 finished, charter drafted',
  'voice.finalisation-failed': (payload) =>
    `1:1 wrap-up failed${because(payload.reason)}${payload.retryScheduled === true ? ' · trying again' : ''}`,
  'voice.finalisation-abandoned': (payload) => `1:1 wrap-up given up${because(payload.reason)}`,
  'skill.authoring-refused': (payload) =>
    `skill ${text(payload.name) ?? 'unnamed'} not moved on: it is ${text(payload.state) ?? 'elsewhere'} now`,
  'skill.builtin-installed': (payload) =>
    `built-in skill installed: ${text(payload.name) ?? 'unnamed'}`,
  'skill.proposed': (payload) => `skill proposed: ${text(payload.name) ?? 'unnamed'}`,
  'skill.approved': (payload) => `skill approved: ${text(payload.name) ?? 'unnamed'}`,
  'skill.rejected': (payload) => `skill rejected: ${text(payload.name) ?? 'unnamed'}`,
  'skill.revision-requested': (payload) =>
    `skill sent back to be written again: ${text(payload.name) ?? 'unnamed'}`,
  'skill.retired': (payload) =>
    `skill retired: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.authoring-superseded': (payload) =>
    `skill authoring taken over: ${text(payload.name) ?? 'unnamed'}${
      duration(payload.heldForMs) ? `, the last run held it ${duration(payload.heldForMs)}` : ''
    }`,
  'skill.authoring-claimed': (payload) =>
    `skill authoring started: ${text(payload.name) ?? 'unnamed'}`,
  'skill.authoring': 'skill being checked in the sandbox',
  'skill.registered': (payload) =>
    `skill registered: ${text(payload.name) ?? 'unnamed'}${
      typeof payload.version === 'number' ? ` v${payload.version}` : ''
    }`,
  'skill.recheck-due': (payload) =>
    `skill re-check due: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.adoption-offered': (payload) =>
    `skill adoption offered: ${text(payload.name) ?? 'unnamed'}${byVersion(payload)}`,
  'skill.adopted': (payload) =>
    `skill adopted: ${text(payload.name) ?? 'unnamed'}${byVersion(payload)}`,
  'skill.failed': (payload) =>
    `skill failed: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.author-failed': (payload) =>
    `skill authoring failed: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.verification-failed': (payload) =>
    `skill check failed: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.sandbox-skipped': (payload) =>
    `skill check skipped, no sandbox: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.authoring-deferred': (payload) =>
    `skill authoring waiting for the model provider: ${text(payload.name) ?? 'unnamed'}${
      duration(payload.retryInMs) ? `, again in ${duration(payload.retryInMs)}` : ''
    }${because(payload.reason)}`,
  'skill.sandbox-waiting': (payload) =>
    `skill check waiting for the sandbox: ${text(payload.name) ?? 'unnamed'}${
      duration(payload.retryInMs) ? `, again in ${duration(payload.retryInMs)}` : ''
    }`,
  'surface.charter-match-ambiguous': (payload) => {
    const slugs = listed(payload.candidateSlugs);
    return `the charter's ${text(payload.namedSystem) ?? 'system'} matches more than one surface${slugs ? `: ${slugs}` : ''}`;
  },
  'surface.proposed': 'connection proposed',
  'surface.oriented': (payload) =>
    payload.verdict === 'absent'
      ? 'orientation found no way to reach a system'
      : 'orientation proposed a connection',
  'surface.proposal-requested': (payload) =>
    `connection card requested${text(payload.slug) ? ` for ${payload.slug}` : ''}`,
  'surface.orientation-failed': (payload) => `orientation failed${because(payload.reason)}`,
  'surface.app-provisioned': (payload) =>
    `app registered${text(payload.appName) ? `: ${payload.appName}` : ''}`,
  'surface.install-failed': (payload) => `app install failed${because(payload.reason)}`,
  'surface.shared-credential-retired': (payload) =>
    `shared credential retired${because(payload.reason)}`,
  'credential.superseded': (payload) => {
    const label = text(payload.label);
    const page = text(payload.page);
    const cards = counted(payload.surfaceIds?.length, 'card');
    return `credential${label ? ` "${label}"` : ''} no longer in the documentation${page ? ` (${page})` : ''}${cards ? `; land one again on ${cards}` : ''}`;
  },
  'surface.reoriented': 'orientation run again at the manager’s request',
  'surface.app-installed': 'app installed by the administrator',
  'surface.probe-failed': (payload) =>
    `connection check failed${payload.verdict === 'listed-dead' ? ', no route left' : ''}${because(payload.reason)}`,
  'surface.probe-retried': (payload) =>
    `connection check retried${duration(payload.retryAfterMs) ? ` after ${duration(payload.retryAfterMs)}` : ''}${because(payload.reason)}`,
  'surface.probe-demoted': (payload) =>
    `connection fell back${text(payload.from) ? ` from ${payload.from}` : ''}${text(payload.to) ? ` to ${payload.to}` : ''}${because(payload.reason)}`,
  'surface.connected': (payload) => {
    const withheld = listed(payload.withheldTools);
    return `connected${withheld ? `; tools outside your approval withheld: ${withheld}` : ''}`;
  },
  'surface.expired': 'access ended: the card needs renewing',
  'surface.access-set': (payload) => {
    const days = counted(payload.days, 'day');
    if (payload.by === 'upgrade') return `access set by the upgrade${days ? `: ${days}` : ''}`;
    if (payload.by === 'approval') return `access started at approval${days ? `: ${days}` : ''}`;
    return `${payload.renewed === true ? 'access renewed' : 'access length set'} by the manager${days ? `: ${days}` : ''}`;
  },
  'surface.expiring': 'access ends within a week: renew it on the card',
  'surface.approved': 'connection approved',
  'surface.rejected': (payload) => `connection rejected${because(payload.reason)}`,
  'surface.tools-approved': (payload) => {
    const added = listed(payload.added);
    const removed = listed(payload.removed);
    const changes = [added ? `added ${added}` : '', removed ? `removed ${removed}` : ''].filter(
      Boolean,
    );
    return `approved tools changed${changes.length > 0 ? `: ${changes.join('; ')}` : ''}`;
  },
  'surface.reopened': (payload) => `connection reopened${because(payload.reason)}`,
  'surface.scope-reapproval-required': 'a queue page changed: the card needs approving again',
  'surface.configuration-token-revoked': (payload) =>
    payload.atProvider === true
      ? 'app configuration token revoked at the provider'
      : `app configuration token dropped${because(payload.reason)}`,
  'surface.app-unrecorded': 'a registered app was not recorded: remove it at the provider',
  'plan.obligations-judged': 'plan obligations judged',
  'plan.obligations-failed-open': (payload) =>
    `plan obligations not judged${because(payload.reason)}; the planner's stand unchecked`,
  'plan.obligations-disagreed': 'the planner and the judgement disagree on the plan obligations',
  'audit.corrected': (payload) =>
    `${counted(payload.removedIndices?.length, 'action') ?? 'actions'} removed by the audit${because(payload.reason)}`,
  'work.listed': 'ticket listed again',
  'work.withdrawn': (payload) => `work withdrawn${because(payload.reason)}`,
  'work.returned': 'work handed back',
  'work.discovered': (payload) => `new work: ${text(payload.title) ?? 'untitled'}`,
  'work.scope-skip-overruled': 'the scope skip overruled by what the manager named',
  'work.requeued': (payload) => {
    const trigger = text(payload.trigger);
    return `sent back to be evaluated again${trigger ? `: ${REQUEUE_TRIGGER_WORDS[trigger] ?? trigger}` : ''}`;
  },
  'work.reevaluation': (payload) =>
    `${counted(payload.readmitted, 'parked item') ?? 'parked items'} sent back to be evaluated: ${
      REQUEUE_TRIGGER_WORDS[text(payload.trigger) ?? ''] ?? 'a policy changed'
    }`,
  'work.claim-refused': 'not taken: another employee holds this ticket',
  'work.evaluated': (payload) => evaluatedWords(payload.decision),
  'work.skipped': (payload) => `skipped${because(payload.reason)}`,
  'work.scope-judgement-unavailable': (payload) =>
    `scope judgement unavailable${because(payload.cause)} · the item waits and is judged again`,
  'work.evaluation-parked': (payload) =>
    payload.reason === 'scope-judgement-unavailable'
      ? `parked: the scope check could not reach the model${
          typeof payload.attempts === 'number' ? ` in ${payload.attempts} attempts` : ''
        } · Check for new work asks again`
      : `parked: its evaluation stopped${
          typeof payload.attempts === 'number' ? ` ${payload.attempts} times` : ''
        } · waits for your Retry`,
  'work.waiting-for-charter': 'waiting for you to approve the charter',
  'work.check-requested': (payload) =>
    `checked for new work${counted(payload.surfaceIds?.length, 'surface') ? ` on ${counted(payload.surfaceIds?.length, 'surface')}` : ''}`,
  'work.plan-grounding-read': 'plan read what it rests on',
  'work.plan-drafted': 'plan drafted',
  'work.plan-redrafting': (payload) =>
    `plan drafted again: ${text(payload.slug) ?? 'its system'} is connected, so the ticket can be read`,
  'work.corrections-applied': (payload) =>
    `plan applies ${counted(payload.correctionIds?.length, 'kept correction') ?? 'kept corrections'}`,
  'work.corrections-redaction-limited': 'kept corrections read with limited redaction',
  'work.correction-retired': 'kept correction retired',
  'work.draft-resumed': (payload) =>
    `plan draft restarted after it died${typeof payload.attempt === 'number' ? ` (restart ${payload.attempt})` : ''}`,
  'work.execution-resumed': (payload) =>
    `execution restarted after it failed outside the item${typeof payload.attempt === 'number' ? ` (restart ${payload.attempt})` : ''}${typeof payload.reason === 'string' && payload.reason !== '' ? `: ${payload.reason}` : ''}`,
  'work.plan-held': (payload) => `plan held for you: ${planHeldWords(payload.reason)}`,
  'work.plan-approved': (payload) =>
    payload.by === 'autonomous'
      ? 'plan approved under autonomous actions'
      : `plan approved${decidedFrom(payload.decidedVia)}`,
  'work.decision-requesting': (payload) =>
    `asking the manager about the ${decisionNoun(payload.kind)}`,
  'work.decision-request-resent': (payload) =>
    `${decisionNoun(payload.kind)} request sent again${because(payload.reason)}`,
  'work.decision-request-failed': (payload) =>
    `${decisionNoun(payload.kind)} request not delivered${because(payload.reason)}`,
  'work.decision-request-asked': (payload) =>
    `${decisionNoun(payload.kind)} request asked on the chat surface`,
  'work.decision-notifying': 'telling the manager what was decided',
  'work.decision-request-closing': 'marking the decided request in the manager DM',
  'work.decision-acknowledging': (payload) =>
    payload.kind === 'unknown'
      ? 'a reply with no open request answered'
      : 'a decision reply acknowledged',
  'work.decision-ignored': (payload) => `a chat reply ignored${because(payload.reason)}`,
  'work.decision-duplicate': 'a repeated decision reply ignored',
  'work.decision-batch-issued': (payload) =>
    `one request sent for ${counted(payload.members?.length, 'decision') ?? 'several decisions'}`,
  'work.decision-batch-decided': (payload) =>
    `${counted(payload.decided?.length, 'decision') ?? 'decisions'} ${payload.outcome === 'rejected' ? 'rejected' : 'approved'} in one reply`,
  'work.retry': (payload) =>
    `${payload.waived === 'scope' || payload.waived === 'quality-fit' ? 'taken anyway' : 'retried'} by the manager${
      text(payload.feedback) ? ', with a note' : ''
    }`,
  'work.provider-reconciled': (payload) =>
    `provider state confirmed${text(payload.actor) ? ` by ${payload.actor}` : ''}`,
  'work.cancelled': (payload) =>
    `cancelled${decidedFrom(payload.decidedVia)}${because(payload.reason)}`,
  'work.dismissed': 'dismissed by the manager',
  'work.execution-claimed': 'run started',
  'work.dependent-authoring': 'closing actions written from what the first phase landed',
  'work.dependent-authoring-claimed': 'closing phase started',
  'work.completed': 'done',
  'work.failed': (payload) =>
    payload.stopped === true ? 'run stopped' : `run failed${because(payload.reason)}`,
  'work.actions-auto-applying': (payload) =>
    `applying ${counted(payload.autoIndexes?.length, 'action') ?? 'actions'} ${
      payload.autonomousActions === true ? 'autonomously' : 'automatically'
    }`,
  'work.actions-pending': (payload) =>
    `${counted(payload.heldIndexes?.length, 'action') ?? 'actions'} held for your approval`,
  'work.actions-approved': (payload) =>
    `${counted(payload.approvedIndexes?.length, 'action') ?? 'actions'} approved${decidedFrom(payload.decidedVia)}`,
  'work.actions-rejected': (payload) =>
    `held actions rejected${decidedFrom(payload.decidedVia)}${because(payload.reason)}`,
  'work.actions-applying': (payload) =>
    payload.phase === 'auto' ? 'applying the automatic actions' : 'applying the approved actions',
  'work.actions-interrupted': 'applying stopped part way: check the provider before Retry',
  'work.conditional-writes-withheld': (payload) =>
    `${counted(payload.withheld?.length, 'write') ?? 'writes'} withheld until the condition is shown`,
  'work.carried-reads-applied': (payload) =>
    `reads carried into the closing phase${payload.landed === false ? ' did not land' : ''}`,
  'work.closing-reauthored': (payload) =>
    `closing actions written again: ${
      payload.reason === 'holder-changed'
        ? 'the ticket holder changed'
        : payload.reason === 'reply-owed'
          ? 'a reply was owed'
          : 'a claim withheld a write'
    }`,
  'work.model-call': modelCallLabel,
  'work.manager-note-sending': (payload) =>
    `sending the manager a ${payload.kind === 'stopped' ? 'stop' : 'landed-work'} note`,
  'work.manager-note-failed': (payload) => `manager note not delivered${because(payload.reason)}`,
  'work.manager-digest-sending': (payload) =>
    `sending the manager a digest of ${counted(payload.count, 'note') ?? 'notes'}`,
  'work.manager-digest-failed': (payload) =>
    `manager digest not delivered${because(payload.reason)}`,
};

/**
 * What the live feed prints for an event.
 *
 * Every type the contract lists has words of its own; a type only an older
 * release wrote is printed as it was stored, because there is nothing else to
 * say about it.
 *
 * Args:
 *   event: The stored event's type and payload.
 *
 * Returns:
 *   One line for the feed.
 */
export function eventLabel(event: Pick<Doc<'events'>, 'type' | 'payload'>): string {
  if (!isEventType(event.type)) return event.type;
  const label = LABELS[event.type] as Label<EventType>;
  if (typeof label === 'string') return label;
  const payload: unknown = event.payload;
  return (label as (payload: unknown) => string)(
    typeof payload === 'object' && payload !== null ? payload : {},
  );
}

/**
 * The work item an event is about, by its title, when the page lists it.
 *
 * Args:
 *   event: The stored event.
 *   titles: The employee's work item titles by id.
 *
 * Returns:
 *   The title, or undefined for an event about no listed item.
 */
export function eventItemTitle(
  event: Pick<Doc<'events'>, 'payload'>,
  titles: ReadonlyMap<string, string>,
): string | undefined {
  const workItemId = (event.payload as { workItemId?: unknown } | null | undefined)?.workItemId;
  return typeof workItemId === 'string' ? titles.get(workItemId) : undefined;
}

/**
 * What a record line's dot says each event did, for the events that did more than note
 * something: landed, refused, set aside, or held for the manager. Typed over the contract, so a
 * name that is not an event fails the typecheck. A run that failed is noted rather than refused:
 * most failures are the run stopping, not anyone refusing it; a draft is noted too, since the
 * line outlives the decision it waited for.
 */
const RECORD_KINDS: Readonly<Partial<Record<EventType, Exclude<RecordKind, 'noted'>>>> = {
  'work.completed': 'landed',
  'work.provider-reconciled': 'landed',
  'charter.approved': 'landed',
  'skill.registered': 'landed',
  'skill.builtin-installed': 'landed',
  'surface.connected': 'landed',
  'work.actions-rejected': 'refused',
  'work.claim-refused': 'refused',
  'skill.rejected': 'refused',
  'skill.authoring-refused': 'refused',
  'skill.verification-failed': 'refused',
  'surface.rejected': 'refused',
  'charter.evidence-rejected': 'refused',
  'skill.failed': 'refused',
  'skill.author-failed': 'refused',
  'audit.corrected': 'refused',
  'work.decision-ignored': 'refused',
  'manager.transfer-declined': 'refused',
  'work.conditional-writes-withheld': 'withheld',
  'work.skipped': 'withheld',
  'work.withdrawn': 'withheld',
  'work.cancelled': 'withheld',
  'manager.transfer-cancelled': 'withheld',
  'manager.transfer-expired': 'withheld',
  'work.actions-pending': 'held',
  'work.plan-held': 'held',
  'skill.proposed': 'held',
  'surface.proposed': 'held',
};

/**
 * What a record line's dot says an event did: landed, refused, withheld, held for the manager,
 * or, for every other event, noted. A type the contract no longer lists (a row an older release
 * wrote) is noted too.
 *
 * @param event - The stored event.
 */
export function recordKindOf(event: Pick<Doc<'events'>, 'type'>): RecordKind {
  return (isEventType(event.type) ? RECORD_KINDS[event.type] : undefined) ?? 'noted';
}
