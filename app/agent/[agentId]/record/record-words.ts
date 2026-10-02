import type { Doc } from '@convex/_generated/dataModel';
import {
  isEventType,
  type EventPayloads,
  type EventType,
  type GrantSource,
  type WorkPlanHeldPayload,
} from '@/events/contract';
import { MANAGER_REJECTION_PREFIX } from '@/work/needs-manager';
import { HANDOVER_SETTINGS_REASON } from '@/agent/manager-transfer';
import { sameManagerAddress } from '@/agent/manager-address';
import { HANDED_OVER_AUTHOR_NAME } from '@/work/skill-library';
import { systemDisplayName } from '@/surfaces/revokers/outcome';
import { judgedAs, REEVALUATION } from '../verdict-words';
import type { ManagerAt } from '../earlier-manager';

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
  /**
   * Who managed the employee when the event happened: the reader, the record's "you", or the
   * earlier manager a later handover took it from, whom the line names instead (decision 5; the
   * wave 10 review, M8). Absent: the reader.
   */
  readonly manager?: ManagerAt;
  /** The reader's own address, for a line addressed to one manager by address. */
  readonly reader?: string;
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

/**
 * `version 2 of the skill X, written by Priya` for an adoption event, with what of it the row
 * carries. Under an earlier manager the author was that manager's colleague, and reads as one
 * (decision 4), as a handed-over copy in the library does.
 */
function versionOfSkill(
  payload: {
    readonly name?: unknown;
    readonly version?: unknown;
    readonly authorName?: unknown;
  },
  subject: RecordSubject,
): string {
  const version = typeof payload.version === 'number' ? `version ${payload.version} of ` : '';
  const author =
    earlierAddress(subject) !== undefined && text(payload.authorName) !== undefined
      ? HANDED_OVER_AUTHOR_NAME
      : text(payload.authorName);
  return `${version}the skill ${text(payload.name) ?? 'unnamed'}${author ? `, written by ${author},` : ''}`;
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

/**
 * The earlier manager's address when one managed the employee at the event, or undefined when
 * the reader did.
 */
function earlierAddress(subject: RecordSubject): string | undefined {
  return subject.manager?.kind === 'earlier' ? subject.manager.address : undefined;
}

/**
 * Who decided, at the head of a sentence: "You", or the employee's manager then by address. The
 * record capitalises a sentence's first letter, so no sentence opens on an address.
 */
function decider(subject: RecordSubject): string {
  const earlier = earlierAddress(subject);
  return earlier === undefined ? 'You' : `${subject.name}'s manager then, ${earlier},`;
}

/** Who was addressed, inside a sentence: "you", or the manager then by address. */
function addressee(subject: RecordSubject): string {
  return earlierAddress(subject) ?? 'you';
}

/** Whose, inside a sentence: "your", or the manager then's. */
function whose(subject: RecordSubject): string {
  const earlier = earlierAddress(subject);
  return earlier === undefined ? 'your' : `${earlier}'s`;
}

/**
 * "you" or "they", inside a sentence that has already named who decided ({@link decider}): the
 * manager then is named once a sentence.
 */
function they(subject: RecordSubject): string {
  return earlierAddress(subject) === undefined ? 'you' : 'they';
}

/** "your" or "their", inside a sentence that has already named who decided. */
function their(subject: RecordSubject): string {
  return earlierAddress(subject) === undefined ? 'your' : 'their';
}

/**
 * Where the manager decided, as the end of a sentence about the decision.
 *
 * @param via - The decision's channel.
 * @param dms - Whose DMs, as the sentence can say them: {@link their} after {@link decider}.
 */
function decidedFrom(via: unknown, dms: string): string {
  if (via === 'channel') return ` from ${dms} DMs`;
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

/** The system an organisation connection is for, by name, or a plain stand-in for a row without one. */
function organisationSystem(displayName: unknown): string {
  return text(displayName) ?? 'a system';
}

/** Who changed an organisation connection, at the end of a sentence: an administrator, or the setup verb. */
function registeredVia(via: unknown): string {
  if (via === 'organisation-page') return ' by an administrator';
  if (via === 'setup-cli') return ' by the setup verb';
  return '';
}

/** The connection an event is about, by name, or a plain stand-in when it names none. */
function connectionOf(subject: RecordSubject): string {
  return subject.connection ? `the ${subject.connection} connection` : 'a connection';
}

/** A phrase with its first letter in capitals, to open a sentence. */
function capitalised(phrase: string): string {
  return phrase.charAt(0).toUpperCase() + phrase.slice(1);
}

/**
 * What one end of access did at the vendor (11-AR): the connection by the card's name while the
 * card stands, else by the name the line kept, and the system as it names itself.
 */
function revokedAtSourceWords(
  p: Read<'credential.revoked-at-source'>,
  subject: RecordSubject,
): string {
  const connection = connectionOf(
    subject.connection === undefined && text(p.surfaceName) !== undefined
      ? { ...subject, connection: text(p.surfaceName) }
      : subject,
  );
  const system = systemDisplayName(text(p.system) ?? 'the vendor');
  switch (p.outcome) {
    case 'token-revoked':
      return `Access to ${connection} was revoked at ${system}${
        p.channelMembershipsRemoved === true ? '; its channel memberships were removed' : ''
      }`;
    case 'app-deleted':
      return `${subject.name}'s ${system} app was deleted in ${system}`;
    case 'app-uninstalled':
      return `${subject.name}'s ${system} app was uninstalled from ${system}`;
    case 'already-gone':
      return `Access to ${connection} was already revoked at ${system}`;
    case 'retrying':
      return `Revoking access to ${connection} at ${system} failed and will be tried again${because(p.reason)}`;
    case 'failed':
      return `Revoking access to ${connection} at ${system} failed${because(p.reason)}; Day0's copy was deleted`;
    case 'not-supported':
      return `Access to ${connection} could not be revoked at ${system}${because(p.reason)}`;
    case 'shared':
      return `Access to ${connection} ended; its shared app token was not revoked at ${system}, since the app's other employees use it`;
    case 'not-at-vendor':
      return `Access to ${connection} ended with nothing changed at ${system}${because(p.reason)}`;
    case 'pasted-key':
      return `Day0 stopped using the key pasted for ${connection}; it was not revoked at ${system}, so revoke it there if it should end`;
    case undefined:
      return `Access to ${connection} ended`;
    default: {
      const unknown: never = p.outcome;
      return `Access to ${connection} ended (${String(unknown)})`;
    }
  }
}

/** What a decision request asks about. */
function decisionNoun(kind: unknown): string {
  return kind === 'actions' ? 'held actions' : 'plan';
}

/** How a grant came about, as the end of a sentence, given who approved it. */
const GRANTED_BY: { readonly [Source in GrantSource]: (who: string) => string } = {
  deploy: () => ' at deploy',
  manager: (who) => ` by ${who}`,
  skill: (who) => ` with a skill ${who} approved`,
  surface: (who) => ` with a connection ${who} approved`,
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

/** Why a held plan waits, by the hold's reason, given whom it was held for. */
const PLAN_HELD_BECAUSE: {
  readonly [Reason in WorkPlanHeldPayload['reason']]: (subject: RecordSubject) => string;
} = {
  'skip-overruled': (subject) => `${they(subject)} waived the skip`,
  'plan-rejected-for-this-item': (subject) =>
    `${they(subject)} rejected a colleague's plan for this ticket`,
  'obligations-failed-open': () => 'its reads and writes could not be checked',
  'drafted-without-record': () => 'it was drafted without reading its ticket or thread',
  'approved-by-predecessor': (subject) =>
    earlierAddress(subject) === undefined
      ? 'your predecessor approved it, so approve it again'
      : 'their predecessor approved it, so it was to be approved again',
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

/**
 * Whose handover note was withheld, as the head of its sentence, read by who reads it: the
 * manager who wrote it reads "Your note", the manager it was addressed to reads it as theirs, and
 * anyone else reads both addresses (the wave 10 review, M8).
 */
function noteWithheldWho(
  payload: { readonly fromAddress?: unknown; readonly toAddress?: unknown },
  subject: RecordSubject,
): string {
  const from = text(payload.fromAddress);
  const to = text(payload.toAddress) ?? 'the named manager';
  const reader = subject.reader;
  if (reader !== undefined && to !== 'the named manager' && sameManagerAddress(to, reader)) {
    return `The note${from ? ` from ${from}` : ''} to you`;
  }
  const wroteIt =
    reader === undefined || from === undefined
      ? earlierAddress(subject) === undefined
      : sameManagerAddress(from, reader);
  return wroteIt ? `Your note to ${to}` : `The note${from ? ` from ${from}` : ''} to ${to}`;
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
 * employee by name, the manager as "you", the work item by its title. An event from before a
 * handover that brought the employee to the reader names the manager then instead of "you"
 * (decision 5), and an adoption's author then as a colleague under the previous manager
 * (decision 4).
 *
 * Keyed by the contract's union, so a type the contract gains without words here fails the
 * typecheck, as the feed's labels do: the record never falls back to a raw type for an event
 * Day0 writes today.
 */
const WORDS: { readonly [Type in EventType]: Words<Type> } = {
  'agent.deployed': (p, subject) =>
    `${subject.name} deployed, reporting to ${text(p.bossEmail) ?? addressee(subject)}${
      text(p.zone) ? `, on ${p.zone} time` : ''
    }`,
  'agent.notifications-changed': (p, subject) => {
    const mode = p.to === 'digest' ? 'as an hourly digest' : 'one per run';
    // The move set it, not a manager (the wave 10 review, M8).
    if (p.reason === HANDOVER_SETTINGS_REASON) {
      return `Run notes went back to ${mode} when ${subject.name} was handed over`;
    }
    return earlierAddress(subject) === undefined
      ? `Run notes to you now come ${mode}`
      : `From then, run notes to ${addressee(subject)} came ${mode}`;
  },
  'agent.zone-changed': (p, { name }) =>
    `${name}'s working day moved${text(p.from) ? ` from ${p.from}` : ''}${
      text(p.to) ? ` to ${p.to}` : ''
    }`,
  'agent.autonomy-changed': (p, subject) =>
    // The move turns the switch off itself, whoever reads it (the wave 10 review, M8).
    p.reason === HANDOVER_SETTINGS_REASON
      ? `Autonomous actions were turned off when ${subject.name} was handed over`
      : `${decider(subject)} turned autonomous actions ${p.to === true ? 'on' : 'off'}`,
  'agent.retired': (_, { name }) => `${name} was retired`,
  'permission.granted': (p, subject) =>
    `${subject.name} was granted ${text(p.scope) ?? 'a permission'}${
      p.source !== undefined && Object.hasOwn(GRANTED_BY, p.source)
        ? GRANTED_BY[p.source](addressee(subject))
        : ''
    }`,
  'permission.revoked': (p, subject) =>
    `${decider(subject)} revoked ${text(p.scope) ?? 'a permission'}${because(p.reason)}`,
  'manager.changed': (p, subject) => {
    const { name } = subject;
    if (p.via === 'probe') {
      return `The chat surface showed ${name} a different manager, so its DMs go to them now`;
    }
    const to = 'bossEmail' in p ? text(p.bossEmail) : undefined;
    if (p.via === 'adopted') {
      return earlierAddress(subject) === undefined
        ? `You made yourself ${name}'s manager${to ? ` at ${to}` : ''}, so its DMs come to you now`
        : `${decider(subject)} made themselves its manager${to ? ` at ${to}` : ''}, so its DMs went to them`;
    }
    return `${decider(subject)} changed ${name}'s manager${to ? ` to ${to}` : ''}`;
  },
  'manager.transfer-asked': (p, subject) =>
    `${subject.name}'s manager, ${text(p.fromAddress) ?? addressee(subject)}, asked ${
      text(p.toAddress) ?? 'another manager'
    } to take ${subject.name} on`,
  'manager.transfer-cancelled': (p, subject) =>
    `${subject.name}'s manager, ${text(p.fromAddress) ?? addressee(subject)}, cancelled the handover to ${
      text(p.toAddress) ?? 'another manager'
    }${handoverCancelledBecause(p.reason, subject.name)}`,
  'manager.transfer-declined': (p, { name }) =>
    `Asked to take ${name} on, ${text(p.toAddress) ?? 'the named manager'} declined`,
  'manager.transfer-expired': (p) =>
    `The handover to ${text(p.toAddress) ?? 'another manager'} expired unanswered`,
  'manager.transfer-settle-failed': (p, { name }) =>
    `${name} could not be moved to ${text(p.toAddress) ?? 'its new manager'} yet${
      typeof p.attempt === 'number' ? ` (attempt ${p.attempt})` : ''
    }; Day0 tries again each minute`,
  'manager.transfer-ended': (p, { name }) =>
    `The handover to ${text(p.toAddress) ?? 'another manager'} ${
      p.reason === 'operator' ? 'was ended by the operator' : 'could not finish and was ended'
    }${because(p.detail)}; ${name} stays with ${text(p.fromAddress) ?? 'its manager'}`,
  'manager.transfer-note-withheld': (p, subject) =>
    `${noteWithheldWho(p, subject)} was withheld: Day0 could not check it for stored credentials`,
  'manager.transfer-notice': (p, { name }) =>
    p.delivered === true
      ? `${name} told ${text(p.toAddress) ?? 'the named manager'} in Slack that they were asked to take ${name} on`
      : `${name} did not tell ${text(p.toAddress) ?? 'the named manager'} in Slack about the handover${because(p.reason)}`,
  'manager.transferred': (p, { name }) => {
    const from = text(p.fromAddress);
    const to = text(p.toAddress);
    const cut = Array.isArray(p.surfacesCut) ? p.surfacesCut.length : 0;
    const moved = `${name} moved${from ? ` from ${from}` : ''} to ${to ?? 'a new manager'}`;
    if (cut === 0) return moved;
    return `${moved}; ${counted(cut, 'connection')} ${cut === 1 ? 'was' : 'were'} cut and ${
      cut === 1 ? 'waits' : 'wait'
    } to be approved and connected again`;
  },
  'charter.drafted': (p, subject) =>
    `Charter version ${text(p.version) ?? '?'} drafted for ${whose(subject)} review`,
  'charter.approved': (p, subject) => {
    const struck = counted(p.struckConstraints?.length, 'rule');
    return `${decider(subject)} approved charter version ${text(p.version) ?? '?'}${
      struck && p.struckConstraints?.length ? `, ${struck} struck` : ''
    }`;
  },
  'charter.amended': (p, subject) =>
    `Charter amended to version ${text(p.version) ?? '?'}${
      text(p.previousVersion) ? ` from ${p.previousVersion}` : ''
    }${
      p.via === 'plan-approval'
        ? ` as ${addressee(subject)} approved a plan`
        : ` by ${addressee(subject)}`
    }${because(p.reason)}`,
  'charter.request_changes': (p, subject) =>
    `${decider(subject)} sent the charter back for changes${because(p.notes)}`,
  'charter.question-asked': (p, subject) =>
    `${subject.name} asked the charter's question${
      text(p.question) ? ` “${text(p.question)}”` : ''
    }${forItem(subject)}`,
  'charter.question-answered': (p, subject) =>
    `${decider(subject)} answered a charter question${
      p.via === 'plan-approval' ? ` as ${they(subject)} approved a plan` : ' on the charter'
    }${p.amended === true ? ', and the charter was amended' : ''}`,
  'charter.evidence-rejected': (p, subject) =>
    `${counted(p.count, 'charter line') ?? 'Charter lines'} dropped: ${whose(subject)} one-to-one did not back ${
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
  'skill.approved': (p, subject) => {
    const scopes = listed(p.scopes);
    return `${decider(subject)} approved the skill ${text(p.name) ?? 'unnamed'}${
      scopes ? `, granting ${scopes}` : ''
    }`;
  },
  'skill.rejected': (p, subject) => {
    const name = text(p.name) ?? 'unnamed';
    if (p.offerWithdrawn === undefined) return `${decider(subject)} rejected the skill ${name}`;
    const version =
      typeof p.offerWithdrawn.version === 'number' ? `version ${p.offerWithdrawn.version}` : 'it';
    return `The adoption of the skill ${name} ended: ${version} was withdrawn from every employee`;
  },
  'skill.revision-requested': (p, subject) =>
    // A row an older release wrote names no revision: its revision overwrote the body in place.
    typeof p.revisionId === 'string'
      ? `${decider(subject)} asked for a revision of the skill ${text(p.name) ?? 'unnamed'}; it keeps running until the revision registers`
      : `${decider(subject)} sent the skill ${text(p.name) ?? 'unnamed'} back to be written again`,
  'skill.retired': (p, subject) =>
    `The skill ${text(p.name) ?? 'unnamed'} was retired${
      p.withdrawn === true ? ` when ${addressee(subject)} withdrew it from every employee` : ''
    }${because(p.reason)}`,
  'skill.revoked': (p, subject) => {
    const holders = listed(
      Array.isArray(p.holders)
        ? p.holders.map((holder: { agentName?: unknown }) => holder.agentName)
        : undefined,
    );
    return `${decider(subject)} withdrew ${
      typeof p.version === 'number' ? `version ${p.version} of ` : ''
    }the skill ${text(p.name) ?? 'unnamed'} from every employee who held it${
      holders ? ` (${holders})` : ''
    }${because(p.reason)}`;
  },
  'skill.rechecked': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} passed its re-check${
      typeof p.version === 'number' ? ` as version ${p.version}` : ''
    } and keeps running${p.stillDue === true ? '; a change during the check keeps it due' : ''}`,
  'skill.superseded': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} was replaced by its revision${
      typeof p.version === 'number' ? `, version ${p.version}` : ''
    }`,
  'skill.given-up': (p, subject) => {
    const attempts = counted(p.attempts, 'attempt');
    return `${decider(subject)} gave up on the skill ${text(p.name) ?? 'unnamed'}${attempts ? ` after ${attempts}` : ''}`;
  },
  'skill.authoring-superseded': (p) =>
    `Writing the skill ${text(p.name) ?? 'unnamed'} was taken over${
      duration(p.heldForMs) ? `; the last run held it ${duration(p.heldForMs)}` : ''
    }`,
  'skill.authoring-claimed': (p, { name }) =>
    p.purpose === 'verify-stored'
      ? `${name} started checking the skill ${text(p.name) ?? 'unnamed'} in the sandbox`
      : `${name} started writing the skill ${text(p.name) ?? 'unnamed'}`,
  'skill.authoring': () => 'A skill is being checked in the sandbox',
  'skill.registered': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} passed its check and can be called${
      typeof p.version === 'number' ? ` as version ${p.version}` : ''
    }`,
  'skill.recheck-due': (p) =>
    `The skill ${text(p.name) ?? 'unnamed'} is due a re-check${because(p.reason)}`,
  'skill.adoption-offered': (p, subject) =>
    `${subject.name} was offered ${versionOfSkill(p, subject)} to adopt`,
  'skill.adopted': (p, subject) =>
    `${decider(subject)} adopted ${versionOfSkill(p, subject)} for ${subject.name}; the sandbox checks it again for ${subject.name} before it runs`,
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
  'surface.proposed': (_, subject) =>
    `${connectionOf(subject)} was proposed for ${whose(subject)} approval`,
  'surface.oriented': (p, subject) =>
    p.verdict === 'absent'
      ? `${subject.name} found no way to reach ${subject.connection ?? 'a system'}${
          listed(p.searched) ? ` after searching ${listed(p.searched)}` : ''
        }`
      : `${subject.name} proposed ${connectionOf(subject)}`,
  'surface.proposal-requested': (p, subject) =>
    `${decider(subject)} asked for a connection card${text(p.slug) ? ` for ${p.slug}` : ''}`,
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
  'surface.reoriented': (_, subject) =>
    `${decider(subject)} asked ${subject.name} to look again for a way to reach ${
      subject.connection ?? 'the system'
    }`,
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
      withheld ? `; tools outside ${whose(subject)} approval were withheld: ${withheld}` : ''
    }`;
  },
  'surface.expired': (_, subject) =>
    `Access to ${connectionOf(subject)} ended; renew it on its card`,
  'surface.access-set': (p, subject) => {
    const days = counted(p.days, 'day');
    const to = `to ${connectionOf(subject)}`;
    if (p.by === 'upgrade') return `Access ${to} set by the upgrade${days ? `, ${days}` : ''}`;
    if (p.by === 'approval') {
      return `Access ${to} started at ${whose(subject)} approval${days ? `, for ${days}` : ''}`;
    }
    return `${decider(subject)} ${p.renewed === true ? 'renewed access' : 'set how long access lasts'} ${to}${
      days ? `, ${days}` : ''
    }`;
  },
  'surface.expiring': (_, subject) =>
    `Access to ${connectionOf(subject)} ends within a week; renew it on its card`,
  'surface.approved': (_, subject) => `${decider(subject)} approved ${connectionOf(subject)}`,
  'surface.rejected': (p, subject) =>
    `${decider(subject)} rejected ${connectionOf(subject)}${because(p.reason)}`,
  'surface.tools-approved': (p, subject) => {
    const changes = [
      listed(p.added) ? `added ${listed(p.added)}` : '',
      listed(p.removed) ? `removed ${listed(p.removed)}` : '',
    ].filter(Boolean);
    return `${decider(subject)} changed the approved tools of ${connectionOf(subject)}${
      changes.length > 0 ? `: ${changes.join('; ')}` : ''
    }`;
  },
  'surface.reopened': (p, subject) => `${connectionOf(subject)} was reopened${because(p.reason)}`,
  'surface.scope-reapproval-required': (_, subject) =>
    `A queue page changed, so ${connectionOf(subject)} needs ${whose(subject)} approval again`,
  'surface.configuration-token-revoked': (p, subject) =>
    p.atProvider === true
      ? `The app configuration token of ${connectionOf(subject)} was revoked at the provider`
      : `The app configuration token of ${connectionOf(subject)} was dropped${because(p.reason)}`,
  'surface.app-unrecorded': (_, subject) =>
    `An app registered for ${connectionOf(subject)} was not recorded; remove it at the provider`,
  'surface.access-requested': (p, subject) => {
    const scopes = listed(p.scopes);
    return `${decider(subject)} asked IT for access to ${connectionOf(subject)}${scopes ? ` (${scopes})` : ''}`;
  },
  'organisation.connection-landed': (p) =>
    `${organisationSystem(p.displayName)} was connected for the organisation${registeredVia(p.via)}`,
  'organisation.connection-rotated': (p) =>
    `The organisation's ${organisationSystem(p.displayName)} connection was given a new secret${registeredVia(p.via)}`,
  'organisation.connection-revoked': (p) =>
    `The organisation's ${organisationSystem(p.displayName)} connection was revoked${registeredVia(p.via)}${because(p.reason)}`,
  'surface.disconnected': (p, subject) =>
    p.by === 'organisation'
      ? `${capitalised(connectionOf(subject))} was disconnected when the organisation's connection was revoked${because(p.reason)}`
      : `${decider(subject)} disconnected ${connectionOf(subject)}`,
  'credential.revoked-at-source': (p, subject) => revokedAtSourceWords(p, subject),
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
    `The scope skip on ${itemOf(subject)} was overruled by what ${addressee(subject)} named`,
  'work.requeued': (p, subject) => {
    const trigger = text(p.trigger);
    return `${itemOf(subject)} was sent back to be evaluated again${
      trigger ? `: ${REQUEUED_BECAUSE[trigger] ?? trigger}` : ''
    }`;
  },
  'work.waiting-for-skill': (p, subject) =>
    `${itemOf(subject)} went back to waiting for the skill ${text(p.name) ?? 'it needs'}${because(
      p.reason,
    )}`,
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
        }; it waits for ${whose(subject)} Retry`,
  'work.waiting-for-charter': (_, subject) =>
    `${itemOf(subject)} waits for ${addressee(subject)} to approve the charter`,
  'work.check-requested': (p, subject) => {
    const surfaces = counted(p.surfaceIds?.length, 'connection');
    return `${decider(subject)} checked for new work${surfaces ? ` on ${surfaces}` : ''}`;
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
    `The plan${forItem(subject)} is held for ${addressee(subject)}: ${
      typeof p.reason === 'string' && Object.hasOwn(PLAN_HELD_BECAUSE, p.reason)
        ? PLAN_HELD_BECAUSE[p.reason](subject)
        : `it waits for ${their(subject)} decision`
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
    return `${decider(subject)} approved the plan${forItem(subject)}${decidedFrom(p.decidedVia, their(subject))}${
      answered.length > 0 ? `, answering ${answered.join(' and ')}` : ''
    }`;
  },
  'work.decision-requesting': (p, subject) =>
    `${subject.name} is asking ${addressee(subject)} about the ${decisionNoun(p.kind)}${forItem(subject)}`,
  'work.decision-request-resent': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was sent again${because(p.reason)}`,
  'work.decision-request-failed': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was not delivered${because(p.reason)}`,
  'work.decision-request-asked': (p, subject) =>
    `The ${decisionNoun(p.kind)} request${forItem(subject)} was asked in ${whose(subject)} DMs`,
  'work.decision-notifying': (_, subject) =>
    `${subject.name} is telling ${addressee(subject)} what was decided${forItem(subject)}`,
  'work.decision-request-closing': (_, subject) =>
    `${subject.name} is marking the decided request${forItem(subject)} in ${whose(subject)} DMs`,
  'work.decision-acknowledging': (p, subject) =>
    p.kind === 'unknown'
      ? 'A reply with no open request was answered'
      : `${subject.name} acknowledged ${whose(subject)} reply${forItem(subject)}`,
  'work.decision-ignored': (p) => `A chat reply was ignored${because(p.reason)}`,
  'work.decision-duplicate': () => 'A repeated decision reply was ignored',
  'work.decision-batch-issued': (p) =>
    `One request was sent for ${counted(p.members?.length, 'decision') ?? 'several decisions'}`,
  'work.decision-batch-decided': (p, subject) =>
    `${decider(subject)} ${p.outcome === 'rejected' ? 'rejected' : 'approved'} ${
      counted(p.decided?.length, 'decision') ?? 'several decisions'
    } in one reply`,
  'work.retry': (p, subject) =>
    `${decider(subject)} ${
      p.waived === 'scope' || p.waived === 'quality-fit' ? 'took' : 'retried'
    } ${itemOf(subject)}${p.waived === 'scope' || p.waived === 'quality-fit' ? ' anyway' : ''}${
      text(p.feedback) ? ', with a note' : ''
    }`,
  'work.provider-reconciled': (p, subject) =>
    `The provider's state${forItem(subject)} was confirmed${text(p.actor) ? ` by ${p.actor}` : ''}`,
  'work.cancelled': (p, subject) =>
    `${itemOf(subject)} was cancelled${decidedFrom(p.decidedVia, whose(subject))}${because(p.reason)}`,
  'work.dismissed': (_, subject) =>
    `${decider(subject)} dismissed ${itemOf(subject)} from ${their(subject)} inbox. It stays on the Work tab, where Retry runs it again`,
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
    )} for ${addressee(subject)}. Nothing has reached a surface`,
  'work.actions-approved': (p, subject) =>
    `${decider(subject)} approved ${counted(p.approvedIndexes?.length, 'held action') ?? 'held actions'}${onItem(
      subject,
    )}${decidedFrom(p.decidedVia, their(subject))}`,
  'work.actions-rejected': (p, subject) =>
    `${decider(subject)} rejected the held actions${onItem(subject)}${decidedFrom(p.decidedVia, their(subject))}${yourReason(
      p.reason,
    )}`,
  'work.actions-applying': (p, subject) =>
    p.phase === 'auto'
      ? `${subject.name} is applying the actions it may take on its own${onItem(subject)}`
      : `${subject.name} is applying the actions ${addressee(subject)} approved${onItem(subject)}`,
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
    `${subject.name} is sending ${addressee(subject)} a ${p.kind === 'stopped' ? 'stop' : 'landed-work'} note${forItem(
      subject,
    )}`,
  'work.manager-note-failed': (p, subject) =>
    `A note to ${addressee(subject)}${forItem(subject)} was not delivered${because(p.reason)}`,
  'work.manager-digest-sending': (p, subject) =>
    `${subject.name} is sending ${addressee(subject)} a digest of ${counted(p.count, 'note') ?? 'notes'}`,
  'work.manager-digest-failed': (p, subject) =>
    `A digest to ${addressee(subject)} was not delivered${because(p.reason)}`,
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
 * @param subject - The employee's name, the title of the work item the event names, and who
 *   managed the employee when it happened.
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
