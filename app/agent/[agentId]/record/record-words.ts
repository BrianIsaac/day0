import type { Doc } from '@convex/_generated/dataModel';
import {
  isEventType,
  type EventPayloads,
  type EventType,
  type GrantSource,
  type WorkPlanHeldPayload,
} from '@/events/contract';
import { MANAGER_REJECTION_PREFIX } from '@/work/needs-manager';
import { judgedAs, REEVALUATION } from '../verdict-words';

/**
 * A payload as the record reads it: a row an older release wrote may lack any field a newer
 * writer adds, so every field is optional here and each sentence checks what it prints.
 */
type Read<Type extends EventType> = Readonly<Partial<EventPayloads[Type]>>;

/** Who and what a line of the record is about: the employee, and the work item when it names one. */
export interface RecordSubject {
  /** The employee's name. */
  readonly name: string;
  /** The title of the work item the event names, when it names one that still exists. */
  readonly item?: string;
  /** The name of the connection the event names, when it names one that still exists. */
  readonly connection?: string;
}

/** One sentence per event type, built from the payload and its subject. */
type Words<Type extends EventType> = (payload: Read<Type>, subject: RecordSubject) => string;

/** A string field, or nothing when an older row lacks it or holds something else. */
function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** `: reason` when the row carries one, without its own full stop. */
function because(value: unknown): string {
  const reason = text(value);
  return reason ? `: ${reason.replace(/[.!?]+$/, '')}` : '';
}

/**
 * The manager's own reason for a rejection, out of the stored one: the row keeps it after
 * `rejected by the manager`, which the sentence already says as "You rejected".
 */
function yourReason(value: unknown): string {
  const reason = text(value);
  if (reason === undefined || !reason.startsWith(MANAGER_REJECTION_PREFIX)) return because(reason);
  return because(reason.slice(MANAGER_REJECTION_PREFIX.length).replace(/^\s*:\s*/, ''));
}

/** `3 actions`, `1 action`, or nothing for a row that carries no count. */
function counted(value: unknown, noun: string, plural = `${noun}s`): string | undefined {
  return typeof value === 'number' ? `${value} ${value === 1 ? noun : plural}` : undefined;
}

/** A list of names, or nothing when the row carries none. */
function listed(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const names = value.filter((name): name is string => typeof name === 'string' && name !== '');
  return names.length > 0 ? names.join(', ') : undefined;
}

/** How long a duration reads: `90 s`, `4 min`, `2 h`. */
function duration(ms: unknown): string | undefined {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return undefined;
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return `${minutes} min`;
  return `${Math.round(minutes / 60)} h`;
}

/** Where the manager decided, as the end of a sentence about the decision. */
function decidedFrom(via: unknown): string {
  if (via === 'channel') return ' from your DMs';
  if (via === 'dashboard') return ' from the dashboard';
  return '';
}

/** The work item an event is about, quoted, or a plain stand-in when it names none. */
function itemOf(subject: RecordSubject): string {
  return subject.item ? `“${subject.item}”` : 'a work item';
}

/** ` for "item"` when the event names an item, and nothing otherwise. */
function forItem(subject: RecordSubject): string {
  return subject.item ? ` for “${subject.item}”` : '';
}

/** ` on "item"` for the actions of a run, when the event names its item. */
function onItem(subject: RecordSubject): string {
  return subject.item ? ` on \u201c${subject.item}\u201d` : '';
}

/** The connection an event is about, by name, or a plain stand-in when it names none. */
function connectionOf(subject: RecordSubject): string {
  return subject.connection ? `the ${subject.connection} connection` : 'a connection';
}

/** What a decision request asks about. */
function decisionNoun(kind: unknown): string {
  return kind === 'actions' ? 'held actions' : 'plan';
}

/** How a grant came about, as the end of a sentence. */
const GRANTED_BY: { readonly [Source in GrantSource]: string } = {
  deploy: ' at deploy',
  manager: ' by you',
  skill: ' with a skill you approved',
  surface: ' with a connection you approved',
};

/** Why a row was sent back to be evaluated again. */
const REQUEUED_BECAUSE: Readonly<Record<string, string>> = {
  charter: 'the charter changed',
  documentation: 'the documentation changed',
  surface: 'a connection changed',
  'claim-released': 'a colleague let the ticket go',
  'verdict-write': 'what it waited on landed as it was judged',
  check: 'Check for new work found what it waited on',
  'skill-registered': 'the skill it waited on registered',
};

/** Why a held plan waits, by the hold's reason. */
const PLAN_HELD_BECAUSE: { readonly [Reason in WorkPlanHeldPayload['reason']]: string } = {
  'skip-overruled': 'you waived the skip',
  'plan-rejected-for-this-item': "you rejected a colleague's plan for this ticket",
  'obligations-failed-open': 'its reads and writes could not be checked',
  'drafted-without-record': 'it was drafted without reading its ticket or thread',
};

/**
 * Why an asked handover was cancelled, as the end of a sentence: nothing for the manager's own
 * cancel, which the sentence already says.
 */
function handoverCancelledBecause(reason: unknown, name: string): string {
  if (reason === 'retired') return ` when ${name} was retired`;
  if (reason === 'address-changed') return ' to ask another address';
  return '';
}

/** The stage a model call belongs to. */
const MODEL_CALL_STAGE: Readonly<Record<string, string>> = {
  evaluation: 'evaluation',
  draft: 'plan draft',
  execution: 'run',
  closing: 'closing phase',
  authoring: 'skill writing',
};

/**
 * The record's words for every event type the contract lists, in the manager's terms: the
 * employee by name, the manager as "you", the work item by its title.
 *
 * Keyed by the contract's union, so a type the contract gains without words here fails the
 * typecheck, as the feed's labels do: the record never falls back to a raw type for an event
 * Day0 writes today.
 */
const WORDS: { readonly [Type in EventType]: Words<Type> } = {
  'agent.deployed': (p, { name }) =>
    `${name} deployed, reporting to ${text(p.bossEmail) ?? 'you'}${
      text(p.zone) ? `, on ${p.zone} time` : ''
    }`,
  'agent.notifications-changed': (p) =>
    `Run notes to you now come ${p.to === 'digest' ? 'as an hourly digest' : 'one per run'}`,
  'agent.zone-changed': (p, { name }) =>
    `${name}'s working day moved${text(p.from) ? ` from ${p.from}` : ''}${
      text(p.to) ? ` to ${p.to}` : ''
    }`,
  'agent.autonomy-changed': (p) =>
    p.to === true ? 'You turned autonomous actions on' : 'You turned autonomous actions off',
  'agent.retired': (_, { name }) => `${name} was retired`,
  'permission.granted': (p, { name }) =>
    `${name} was granted ${text(p.scope) ?? 'a permission'}${
      p.source !== undefined && Object.hasOwn(GRANTED_BY, p.source) ? GRANTED_BY[p.source] : ''
    }`,
  'permission.revoked': (p) => `You revoked ${text(p.scope) ?? 'a permission'}${because(p.reason)}`,
  'manager.changed': (p, { name }) => {
    if (p.via === 'probe') {
      return `The chat surface showed ${name} a different manager, so its DMs go to them now`;
    }
    const to = 'bossEmail' in p ? text(p.bossEmail) : undefined;
    if (p.via === 'adopted') {
      return `You made yourself ${name}'s manager${to ? ` at ${to}` : ''}, so its DMs come to you now`;
    }
    return `You changed ${name}'s manager${to ? ` to ${to}` : ''}`;
  },
  'manager.transfer-asked': (p, { name }) =>
    `${name}'s manager, ${text(p.fromAddress) ?? 'you'}, asked ${
      text(p.toAddress) ?? 'another manager'
    } to take ${name} on`,
  'manager.transfer-cancelled': (p, { name }) =>
    `${name}'s manager, ${text(p.fromAddress) ?? 'you'}, cancelled the handover to ${
      text(p.toAddress) ?? 'another manager'
    }${handoverCancelledBecause(p.reason, name)}`,
  'manager.transfer-declined': (p, { name }) =>
    `Asked to take ${name} on, ${text(p.toAddress) ?? 'the named manager'} declined`,
  'manager.transfer-expired': (p) =>
    `The handover to ${text(p.toAddress) ?? 'another manager'} expired unanswered`,
  'charter.drafted': (p) => `Charter version ${text(p.version) ?? '?'} drafted for your review`,
  'charter.approved': (p) => {
    const struck = counted(p.struckConstraints?.length, 'rule');
    return `You approved charter version ${text(p.version) ?? '?'}${
      struck && p.struckConstraints?.length ? `, ${struck} struck` : ''
    }`;
  },
  'charter.amended': (p) =>
    `Charter amended to version ${text(p.version) ?? '?'}${
      text(p.previousVersion) ? ` from ${p.previousVersion}` : ''
    }${p.via === 'plan-approval' ? ' as you approved a plan' : ' by you'}${because(p.reason)}`,
  'charter.request_changes': (p) => `You sent the charter back for changes${because(p.notes)}`,
  'charter.question-asked': (p, subject) =>
    `${subject.name} asked the charter's question${
      text(p.question) ? ` “${text(p.question)}”` : ''
    }${forItem(subject)}`,
  'charter.question-answered': (p) =>
    `You answered a charter question${
      p.via === 'plan-approval' ? ' as you approved a plan' : ' on the charter'
    }${p.amended === true ? ', and the charter was amended' : ''}`,
  'charter.evidence-rejected': (p) =>
    `${counted(p.count, 'charter line') ?? 'Charter lines'} dropped: your one-to-one did not back ${
      p.count === 1 ? 'it' : 'them'
    }`,
  'charter.seeding-failed': (p) =>
    `Seeding work from the approved charter failed${because(p.reason)}; ${
      p.retrying === true ? 'trying again' : 'given up'
    }`,
  'work.charter-derived': (p) =>
    `${counted(p.count, 'work item') ?? 'Work items'} seeded from the charter`,
  'coworker.replied': (p) =>
    `${text(p.responder) ?? 'A colleague'} replied${
      text(p.channelSlug) ? ` in #${p.channelSlug}` : ''
    }`,
  'documentation.systems-discovered': (p, { name }) =>
    `${name} read the documentation and found ${counted(p.systems, 'system') ?? 'its systems'}${
      typeof p.created === 'number' && p.created > 0 ? `, ${p.created} new` : ''
    }${typeof p.retired === 'number' && p.retired > 0 ? `, ${p.retired} gone` : ''}`,
  'evaluation.transport-ready': (_, subject) =>
    `The evaluation harness is ready to run${forItem(subject)}`,
  'voice.started': (p) => `Day-1 one-to-one opened in ${p.mode === 'chat' ? 'chat' : 'voice'}`,
  'voice.answer-recorded': (p) =>
    `One-to-one answer recorded${text(p.topic) ? ` on ${p.topic}` : ''}`,
  'voice.finalisation-reclaimed': (p) =>
    `The one-to-one's wrap-up was taken over${
      duration(p.heldForMs) ? ` after ${duration(p.heldForMs)}` : ''
    }`,
  'voice.completed': () => 'Day-1 one-to-one finished and the charter drafted',
  'voice.finalisation-failed': (p) =>
    `The one-to-one's wrap-up failed${because(p.reason)}${
      p.retryScheduled === true ? '; trying again' : ''
    }`,
  'voice.finalisation-abandoned': (p) =>
    `The one-to-one's wrap-up was given up${because(p.reason)}`,
  'skill.authoring-refused': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} was not moved on: it is ${
      text(p.state) ?? 'elsewhere'
    } now`,
  'skill.builtin-installed': (p) => `Built-in skill ${text(p.name) ?? 'unnamed'} installed`,
  'skill.proposed': (p, subject) =>
    `${subject.name} proposed the skill ${text(p.name) ?? 'unnamed'}${forItem(subject)}`,
  'skill.approved': (p) => {
    const scopes = listed(p.scopes);
    return `You approved the skill ${text(p.name) ?? 'unnamed'}${scopes ? `, granting ${scopes}` : ''}`;
  },
  'skill.rejected': (p) => `You rejected the skill ${text(p.name) ?? 'unnamed'}`,
  'skill.revision-requested': (p) =>
    `You sent the skill ${text(p.name) ?? 'unnamed'} back to be written again`,
  'skill.retired': (p) => `The skill ${text(p.name) ?? 'unnamed'} was retired${because(p.reason)}`,
  'skill.authoring-superseded': (p) =>
    `Writing the skill ${text(p.name) ?? 'unnamed'} was taken over${
      duration(p.heldForMs) ? `; the last run held it ${duration(p.heldForMs)}` : ''
    }`,
  'skill.authoring-claimed': (p, { name }) =>
    `${name} started writing the skill ${text(p.name) ?? 'unnamed'}`,
  'skill.authoring': () => 'A skill is being checked in the sandbox',
  'skill.registered': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} passed its check and can be called`,
  'skill.failed': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} did not register${because(p.reason)}`,
  'skill.author-failed': (p) =>
    `Writing the skill ${text(p.name) ?? 'unnamed'} failed${because(p.reason)}`,
  'skill.verification-failed': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} failed its check${because(p.reason)}`,
  'skill.sandbox-skipped': (p) =>
    `The check of the skill ${text(p.name) ?? 'unnamed'} was skipped, with no sandbox${because(
      p.reason,
    )}`,
  'skill.authoring-deferred': (p) =>
    `Writing the skill ${text(p.name) ?? 'unnamed'} waits for the model provider${
      duration(p.retryInMs) ? `, again in ${duration(p.retryInMs)}` : ''
    }${because(p.reason)}`,
  'skill.sandbox-waiting': (p) =>
    `The check of the skill ${text(p.name) ?? 'unnamed'} waits for the sandbox${
      duration(p.retryInMs) ? `, again in ${duration(p.retryInMs)}` : ''
    }`,
  'surface.charter-match-ambiguous': (p) => {
    const slugs = listed(p.candidateSlugs);
    return `The charter's ${text(p.namedSystem) ?? 'system'} matches more than one connection${
      slugs ? `: ${slugs}` : ''
    }`;
  },
  'surface.proposed': (_, subject) => `${connectionOf(subject)} was proposed for your approval`,
  'surface.oriented': (p, subject) =>
    p.verdict === 'absent'
      ? `${subject.name} found no way to reach ${subject.connection ?? 'a system'}${
          listed(p.searched) ? ` after searching ${listed(p.searched)}` : ''
        }`
      : `${subject.name} proposed ${connectionOf(subject)}`,
  'surface.proposal-requested': (p) =>
    `You asked for a connection card${text(p.slug) ? ` for ${p.slug}` : ''}`,
  'surface.orientation-failed': (p, subject) =>
    `Finding a way to reach ${subject.connection ?? 'a system'} failed${because(p.reason)}`,
  'surface.app-provisioned': (p, subject) =>
    `An app was registered for ${connectionOf(subject)}${text(p.appName) ? `: ${p.appName}` : ''}`,
  'surface.install-failed': (p, subject) =>
    `Installing the app for ${connectionOf(subject)} failed${because(p.reason)}`,
  'surface.shared-credential-retired': (p, subject) =>
    `A shared credential of ${connectionOf(subject)} was retired${because(p.reason)}`,
  'credential.superseded': (p) => {
    const label = text(p.label);
    const page = text(p.page);
    const cards = counted(p.surfaceIds?.length, 'card');
    return `The credential${label ? ` \u201c${label}\u201d` : ''} is no longer in the documentation${
      page ? ` (${page})` : ''
    }${cards ? `; land one again on ${cards}` : ''}`;
  },
  'surface.reoriented': (_, { name, connection }) =>
    `You asked ${name} to look again for a way to reach ${connection ?? 'the system'}`,
  'surface.app-installed': (_, subject) =>
    `The administrator installed the app for ${connectionOf(subject)}`,
  'surface.probe-failed': (p, subject) =>
    `The check of ${connectionOf(subject)} failed${
      p.verdict === 'listed-dead' ? ', with no route left' : ''
    }${because(p.reason)}`,
  'surface.probe-retried': (p, subject) =>
    `The check of ${connectionOf(subject)} was tried again${
      duration(p.retryAfterMs) ? ` after ${duration(p.retryAfterMs)}` : ''
    }${because(p.reason)}`,
  'surface.probe-demoted': (p, subject) =>
    `${connectionOf(subject)} fell back${text(p.from) ? ` from ${p.from}` : ''}${
      text(p.to) ? ` to ${p.to}` : ''
    }${because(p.reason)}`,
  'surface.connected': (p, subject) => {
    const withheld = listed(p.withheldTools);
    return `${connectionOf(subject)} connected${
      withheld ? `; tools outside your approval were withheld: ${withheld}` : ''
    }`;
  },
  'surface.expired': (_, subject) =>
    `Access to ${connectionOf(subject)} ended; renew it on its card`,
  'surface.access-set': (p, subject) => {
    const days = counted(p.days, 'day');
    const to = `to ${connectionOf(subject)}`;
    if (p.by === 'upgrade') return `Access ${to} set by the upgrade${days ? `, ${days}` : ''}`;
    if (p.by === 'approval') {
      return `Access ${to} started at your approval${days ? `, for ${days}` : ''}`;
    }
    return `You ${p.renewed === true ? 'renewed access' : 'set how long access lasts'} ${to}${
      days ? `, ${days}` : ''
    }`;
  },
  'surface.expiring': (_, subject) =>
    `Access to ${connectionOf(subject)} ends within a week; renew it on its card`,
  'surface.approved': (_, subject) => `You approved ${connectionOf(subject)}`,
  'surface.rejected': (p, subject) => `You rejected ${connectionOf(subject)}${because(p.reason)}`,
  'surface.tools-approved': (p, subject) => {
    const changes = [
      listed(p.added) ? `added ${listed(p.added)}` : '',
      listed(p.removed) ? `removed ${listed(p.removed)}` : '',
    ].filter(Boolean);
    return `You changed the approved tools of ${connectionOf(subject)}${
      changes.length > 0 ? `: ${changes.join('; ')}` : ''
    }`;
  },
  'surface.reopened': (p, subject) => `${connectionOf(subject)} was reopened${because(p.reason)}`,
  'surface.scope-reapproval-required': (_, subject) =>
    `A queue page changed, so ${connectionOf(subject)} needs your approval again`,
  'surface.configuration-token-revoked': (p, subject) =>
    p.atProvider === true
      ? `The app configuration token of ${connectionOf(subject)} was revoked at the provider`
      : `The app configuration token of ${connectionOf(subject)} was dropped${because(p.reason)}`,
  'surface.app-unrecorded': (_, subject) =>
    `An app registered for ${connectionOf(subject)} was not recorded; remove it at the provider`,
  'plan.obligations-judged': (_, subject) =>
    `What the plan${forItem(subject)} must read and write was judged`,
  'plan.obligations-failed-open': (p, subject) =>
    `What the plan${forItem(subject)} must read and write could not be judged${because(
      p.reason,
    )}; the planner's own list stands unchecked`,
  'plan.obligations-disagreed': (_, subject) =>
    `The planner and the judgement disagree on what the plan${forItem(subject)} must read and write`,
  'audit.corrected': (p, subject) =>
    `The audit removed ${counted(p.removedIndices?.length, 'action') ?? 'actions'} from the run${forItem(
      subject,
    )}${because(p.reason)}`,
  'work.listed': (p, subject) =>
    `The tracker shows ${itemOf(subject)} changed${
      text(p.refused) ? `; intake did not take it${because(p.refused)}` : ''
    }`,
  'work.withdrawn': (p, subject) => `${itemOf(subject)} was withdrawn${because(p.reason)}`,
  'work.returned': (p, subject) =>
    `${text(p.title) ? `“${text(p.title)}”` : itemOf(subject)} was handed back`,
  'work.discovered': (p, subject) =>
    `${subject.name} found new work: ${text(p.title) ? `“${text(p.title)}”` : itemOf(subject)}`,
  'work.scope-skip-overruled': (_, subject) =>
    `The scope skip on ${itemOf(subject)} was overruled by what you named`,
  'work.requeued': (p, subject) => {
    const trigger = text(p.trigger);
    return `${itemOf(subject)} was sent back to be evaluated again${
      trigger ? `: ${REQUEUED_BECAUSE[trigger] ?? trigger}` : ''
    }`;
  },
  'work.reevaluation': (p) =>
    `${counted(p.readmitted, 'parked item') ?? 'Parked items'} sent back to be evaluated: ${
      REQUEUED_BECAUSE[text(p.trigger) ?? ''] ?? 'a policy changed'
    }`,
  'work.claim-refused': (_, subject) =>
    `${subject.name} did not take ${itemOf(subject)}: another employee holds the ticket`,
  'work.evaluated': (p, subject) => {
    const decision = text(p.decision);
    if (decision === REEVALUATION) {
      return `${subject.name} will judge ${itemOf(subject)} again: the skill it waited on is ready`;
    }
    const judged = decision === undefined ? undefined : judgedAs(decision);
    return judged === undefined
      ? `${subject.name} evaluated ${itemOf(subject)}: ${decision?.replace(/-/g, ' ') ?? 'no verdict'}`
      : `${subject.name} judged ${itemOf(subject)} ${judged}`;
  },
  'work.skipped': (p, subject) => `${subject.name} skipped ${itemOf(subject)}${because(p.reason)}`,
  'work.scope-judgement-unavailable': (p, subject) =>
    `The scope check on ${itemOf(subject)} could not be made${because(
      p.cause,
    )}; it waits and is judged again`,
  'work.evaluation-parked': (p, subject) =>
    p.reason === 'scope-judgement-unavailable'
      ? `${itemOf(subject)} is parked: the scope check could not reach the model${
          typeof p.attempts === 'number' ? ` in ${p.attempts} attempts` : ''
        }; Check for new work asks again`
      : `${itemOf(subject)} is parked: its evaluation stopped${
          typeof p.attempts === 'number' ? ` ${p.attempts} times` : ''
        }; it waits for your Retry`,
  'work.waiting-for-charter': (_, subject) =>
    `${itemOf(subject)} waits for you to approve the charter`,
  'work.check-requested': (p) => {
    const surfaces = counted(p.surfaceIds?.length, 'connection');
    return `You checked for new work${surfaces ? ` on ${surfaces}` : ''}`;
  },
  'work.plan-grounding-read': (_, subject) =>
    `${subject.name} read what the plan${forItem(subject)} rests on`,
  'work.plan-drafted': (_, subject) => `${subject.name} drafted a plan${forItem(subject)}`,
  'work.plan-redrafting': (p, subject) =>
    `The plan${forItem(subject)} is drafted again: ${
      text(p.slug) ?? 'its system'
    } is connected, so the ticket can be read`,
  'work.corrections-applied': (p, subject) =>
    `The plan${forItem(subject)} applies ${
      counted(p.correctionIds?.length, 'kept correction') ?? 'kept corrections'
    }`,
  'work.corrections-redaction-limited': (_, subject) =>
    `Kept corrections were read with limited redaction${forItem(subject)}`,
  'work.correction-retired': () => 'A kept correction was retired',
  'work.draft-resumed': (p, subject) =>
    `The plan draft${forItem(subject)} restarted after it died${
      typeof p.attempt === 'number' ? ` (restart ${p.attempt})` : ''
    }`,
  'work.execution-resumed': (p, subject) =>
    `The run${forItem(subject)} restarted after it failed outside the item${
      typeof p.attempt === 'number' ? ` (restart ${p.attempt})` : ''
    }${because(p.reason)}`,
  'work.plan-held': (p, subject) =>
    `The plan${forItem(subject)} is held for you: ${
      typeof p.reason === 'string' && Object.hasOwn(PLAN_HELD_BECAUSE, p.reason)
        ? PLAN_HELD_BECAUSE[p.reason]
        : 'it waits for your decision'
    }`,
  'work.plan-approved': (p, subject) => {
    if (p.by === 'autonomous') {
      return `The plan${forItem(subject)} was approved under autonomous actions`;
    }
    // A charter question's answer names its question row; any other answered the planner's note.
    const charter = (p.answered ?? []).filter((entry) => entry.questionId !== undefined).length;
    const note = (p.answered ?? []).length - charter;
    const answered = [
      ...(charter > 0 ? [counted(charter, 'charter question')] : []),
      ...(note > 0
        ? [note === 1 ? "the planner's note" : `${note} of the planner's questions`]
        : []),
    ];
    return `You approved the plan${forItem(subject)}${decidedFrom(p.decidedVia)}${
      answered.length > 0 ? `, answering ${answered.join(' and ')}` : ''
    }`;
  },
  'work.decision-requesting': (p, subject) =>
    `${subject.name} is asking you about the ${decisionNoun(p.kind)}${forItem(subject)}`,
  'work.decision-request-resent': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was sent again${because(p.reason)}`,
  'work.decision-request-failed': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was not delivered${because(p.reason)}`,
  'work.decision-request-asked': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was asked in your DMs`,
  'work.decision-notifying': (_, subject) =>
    `${subject.name} is telling you what was decided${forItem(subject)}`,
  'work.decision-request-closing': (_, subject) =>
    `${subject.name} is marking the decided request${forItem(subject)} in your DMs`,
  'work.decision-acknowledging': (p, subject) =>
    p.kind === 'unknown'
      ? 'A reply with no open request was answered'
      : `${subject.name} acknowledged your reply${forItem(subject)}`,
  'work.decision-ignored': (p) => `A chat reply was ignored${because(p.reason)}`,
  'work.decision-duplicate': () => 'A repeated decision reply was ignored',
  'work.decision-batch-issued': (p) =>
    `One request was sent for ${counted(p.members?.length, 'decision') ?? 'several decisions'}`,
  'work.decision-batch-decided': (p) =>
    `You ${p.outcome === 'rejected' ? 'rejected' : 'approved'} ${
      counted(p.decided?.length, 'decision') ?? 'several decisions'
    } in one reply`,
  'work.retry': (p, subject) =>
    `You ${
      p.waived === 'scope' || p.waived === 'quality-fit' ? 'took' : 'retried'
    } ${itemOf(subject)}${p.waived === 'scope' || p.waived === 'quality-fit' ? ' anyway' : ''}${
      text(p.feedback) ? ', with a note' : ''
    }`,
  'work.provider-reconciled': (p, subject) =>
    `The provider's state${forItem(subject)} was confirmed${text(p.actor) ? ` by ${p.actor}` : ''}`,
  'work.cancelled': (p, subject) =>
    `${itemOf(subject)} was cancelled${decidedFrom(p.decidedVia)}${because(p.reason)}`,
  'work.dismissed': (_, subject) =>
    `You dismissed ${itemOf(subject)} from your inbox. It stays on the Work tab, where Retry runs it again`,
  'work.execution-claimed': (_, subject) => `${subject.name} started the run${forItem(subject)}`,
  'work.dependent-authoring': (_, subject) =>
    `${subject.name} wrote the closing actions${forItem(subject)} from what the first phase landed`,
  'work.dependent-authoring-claimed': (_, subject) =>
    `The closing phase${forItem(subject)} started`,
  'work.completed': (_, subject) => `${subject.name} finished ${itemOf(subject)}`,
  'work.failed': (p, subject) =>
    p.stopped === true
      ? `The run${forItem(subject)} stopped`
      : `The run${forItem(subject)} failed${because(p.reason)}`,
  'work.actions-auto-applying': (p, subject) =>
    `${subject.name} is applying ${counted(p.autoIndexes?.length, 'action') ?? 'actions'}${onItem(
      subject,
    )} ${p.autonomousActions === true ? 'under autonomous actions' : 'on its own, as allowed'}`,
  'work.actions-pending': (p, subject) =>
    `${subject.name} held ${counted(p.heldIndexes?.length, 'action') ?? 'actions'}${onItem(
      subject,
    )} for you. Nothing has reached a surface`,
  'work.actions-approved': (p, subject) =>
    `You approved ${counted(p.approvedIndexes?.length, 'held action') ?? 'held actions'}${onItem(
      subject,
    )}${decidedFrom(p.decidedVia)}`,
  'work.actions-rejected': (p, subject) =>
    `You rejected the held actions${onItem(subject)}${decidedFrom(p.decidedVia)}${yourReason(
      p.reason,
    )}`,
  'work.actions-applying': (p, subject) =>
    p.phase === 'auto'
      ? `${subject.name} is applying the actions it may take on its own${onItem(subject)}`
      : `${subject.name} is applying the actions you approved${onItem(subject)}`,
  'work.actions-interrupted': (_, subject) =>
    `Applying the actions${onItem(subject)} stopped part way; check the provider before Retry`,
  'work.conditional-writes-withheld': (p, subject) =>
    `${counted(p.withheld?.length, 'write') ?? 'Writes'}${onItem(
      subject,
    )} withheld until their condition is shown`,
  'work.carried-reads-applied': (p, subject) =>
    `The reads carried into the closing phase${forItem(subject)} ${
      p.landed === false ? 'did not land' : 'landed'
    }`,
  'work.closing-reauthored': (p, subject) =>
    `The closing actions${forItem(subject)} were written again: ${
      p.reason === 'holder-changed'
        ? 'the ticket holder changed'
        : p.reason === 'reply-owed'
          ? 'a reply was owed'
          : 'a claim withheld a write'
    }`,
  'work.model-call': (p) => {
    const stage = text(p.stage);
    const outcome = text(p.outcome) ?? 'unknown';
    const attempts =
      outcome !== 'ok' && typeof p.attempts === 'number' && p.attempts > 1
        ? ` after ${p.attempts} attempts`
        : '';
    const status = typeof p.statusCode === 'number' ? ` (HTTP ${p.statusCode})` : '';
    return `A model call for the ${stage ? (MODEL_CALL_STAGE[stage] ?? stage) : 'work'} ${
      outcome === 'ok' ? 'answered' : `ended ${outcome}`
    }${attempts}${status}`;
  },
  'work.manager-note-sending': (p, subject) =>
    `${subject.name} is sending you a ${p.kind === 'stopped' ? 'stop' : 'landed-work'} note${forItem(
      subject,
    )}`,
  'work.manager-note-failed': (p, subject) =>
    `A note to you${forItem(subject)} was not delivered${because(p.reason)}`,
  'work.manager-digest-sending': (p, subject) =>
    `${subject.name} is sending you a digest of ${counted(p.count, 'note') ?? 'notes'}`,
  'work.manager-digest-failed': (p) => `A digest to you was not delivered${because(p.reason)}`,
};

/** A sentence as the record prints it: capitalised, closed with one full stop. */
function asSentence(words: string): string {
  const trimmed = words.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  // A quoted title that ends with its own stop closes the sentence: "Why is ARR down?".
  return /[.!?][\u201d)]?$/.test(capital) ? capital : `${capital}.`;
}

/**
 * What the record says an event did, as one plain sentence in the manager's terms.
 *
 * Every type the contract lists has a sentence of its own; a type only an older release wrote is
 * said as such, with the name it was stored under, since there is nothing else to say about it.
 *
 * @param event - The stored event's type and payload.
 * @param subject - The employee's name and the title of the work item the event names.
 */
export function recordWords(
  event: Pick<Doc<'events'>, 'type' | 'payload'>,
  subject: RecordSubject,
): string {
  if (!isEventType(event.type)) {
    return asSentence(`An event this release does not describe: ${event.type}`);
  }
  const words = WORDS[event.type] as Words<EventType>;
  const payload: unknown = event.payload;
  return asSentence(
    (words as (payload: unknown, subject: RecordSubject) => string)(
      typeof payload === 'object' && payload !== null ? payload : {},
      subject,
    ),
  );
}
