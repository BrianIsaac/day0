import type { Doc } from '@convex/_generated/dataModel';
import {
  isEventType,
  type EventPayloads,
  type EventType,
  type WorkDecisionAcknowledgingPayload,
  type WorkPlanHeldPayload,
} from '@/events/contract';
import type { RecordKind } from '../../components/RecordLine';
import { systemDisplayName } from '@/surfaces/revokers/outcome';
import type { MessagesTabOpenHow } from '@/surfaces/slack-messages-tab';
import { relationshipNoun } from '@/people/words';
import { judgedAs, REEVALUATION } from './verdict-words';
import { finishedAs } from './work/work-item';
import { EMPLOYEES_CHECKED } from '@/work/agreement-vocabulary';

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

/** How a decision reply was answered, by its notice's kind; a row with none was an acknowledgement. */
const ACKNOWLEDGEMENT_LABELS: Readonly<Record<WorkDecisionAcknowledgingPayload['kind'], string>> = {
  received: 'a decision reply acknowledged',
  unknown: 'a reply with no open request answered',
  replaced: 'a reply to a replaced request answered with the request that replaced it',
};

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

/** The model call site a documentation selection was made for, in words. */
const DOCUMENTATION_SITE_WORDS: Readonly<Record<string, string>> = {
  plan: 'plan draft',
  execute: 'run',
  closing: 'closing',
};

/** A documentation selection: the site, and how much of the documentation it carried. */
function documentationSelectedLabel(payload: Read<'work.documentation-selected'>): string {
  const site = text(payload.site);
  const siteWords = site ? ` · ${DOCUMENTATION_SITE_WORDS[site] ?? site}` : '';
  const sections = Array.isArray(payload.blockIds) ? payload.blockIds.length : 0;
  const amount =
    typeof payload.chars === 'number'
      ? ` · ${payload.chars.toLocaleString('en-GB')} characters from ${sections} ${sections === 1 ? 'section' : 'sections'}`
      : '';
  return `documentation${siteWords}${amount}`;
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
  'documentation-conflict': 'two pages disagree; decide on the Documentation tab',
};

/** Why a held plan waits, or a plain line for a reason this build does not know. */
function planHeldWords(reason: unknown): string {
  return typeof reason === 'string' && Object.hasOwn(PLAN_HELD_WORDS, reason)
    ? PLAN_HELD_WORDS[reason as WorkPlanHeldPayload['reason']]
    : 'it waits for your decision';
}

/** A relation between two documentation pages, as the feed names it. */
function relationLabel(kind: unknown): string {
  if (kind === 'possible_successor') return 'a newer version of a page';
  if (kind === 'possible_conflict') return 'two pages that disagree';
  return 'two versions of one page';
}

/** A documentation page's new status as the feed says it: "is now superseded", "is current again". */
function pageStatusLabel(status: unknown): string {
  if (status === 'active') return 'is current again';
  if (status === 'draft') return 'is now a draft';
  return status === 'superseded' || status === 'archived'
    ? `is now ${status}`
    : 'changed its status';
}

/**
 * What a correction of an organisation connection changed: its redirect, its scopes, an MCP
 * connection's missing issuer (the round review's m13), or more than one.
 */
function correctedWhat(payload: Read<'organisation.connection-corrected'>): string {
  const parts = [
    ...(payload.redirectCorrected === true ? ['redirect'] : []),
    ...(Array.isArray(payload.scopes) ? ['scopes'] : []),
  ];
  // An issuer recorded where none was is recorded, never corrected (the round review's m13).
  const issuer = payload.issuerRecorded === true;
  if (parts.length === 0 && issuer) return 'issuer recorded';
  const corrected = `recorded ${parts.length === 0 ? 'scopes' : parts.join(' and ')} corrected`;
  return issuer ? `${corrected} and its issuer recorded` : corrected;
}

/** How an employee's own Slack app came to take messages, as the feed says it (W12V-7). */
function messagesOpenLabel(how: MessagesTabOpenHow | undefined): string {
  switch (how) {
    case 'created':
      return 'app takes messages';
    case 'opened':
      return 'app messages tab opened';
    case 'found-open':
      return 'app messages tab found open';
    case 'confirmed':
      return 'app messages tab confirmed by the manager';
    case undefined:
      return 'app takes messages';
    default: {
      const unknown: never = how;
      return `app takes messages (${String(unknown)})`;
    }
  }
}

/** One call Day0 made with the organisation's Slack configuration token or its refresh token (11-AS). */
function configurationUsedLabel(payload: Read<'organisation.configuration-used'>): string {
  const name = text(payload.displayName) ?? 'Slack';
  if (payload.method === 'apps.manifest.create') {
    return payload.outcome === 'done'
      ? `an employee's ${name} app${text(payload.appId) ? ` ${text(payload.appId)}` : ''} created with the configuration token`
      : `an employee's ${name} app not created${because(payload.reason)}`;
  }
  if (payload.method === 'apps.manifest.export' || payload.method === 'apps.manifest.update') {
    const app = `an employee's ${name} app${text(payload.appId) ? ` ${text(payload.appId)}` : ''}`;
    if (payload.method === 'apps.manifest.export') {
      return payload.outcome === 'done'
        ? `${app} read with the configuration token`
        : `${app} not read${because(payload.reason)}`;
    }
    return payload.outcome === 'done'
      ? `${app}: messages tab opened with the configuration token`
      : `${app}: messages tab not opened${because(payload.reason)}`;
  }
  if (payload.method === 'auth.revoke') {
    const notChecked = payload.unchecked === true ? ', not confirmed afterwards' : '';
    switch (payload.outcome) {
      case 'done':
        return `${name} configuration token revoked at ${name}${notChecked}`;
      case 'already-revoked':
        return `${name} configuration token had already ended at ${name}${notChecked}`;
      case 'unrecognised':
        return `${name} configuration token not recognised by ${name}${notChecked}`;
      case 'failed':
      case 'superseded':
      case undefined:
        return `${name} configuration token not revoked at ${name}${because(payload.reason)}`;
      default: {
        const unknown: never = payload.outcome;
        return `${name} configuration token revocation: ${String(unknown)}`;
      }
    }
  }
  switch (payload.outcome) {
    case 'done':
      return `${name} configuration token renewed`;
    case 'superseded':
      return `${name} configuration token renewed twice at once: the other renewal kept`;
    case 'failed':
    case 'already-revoked':
    case 'unrecognised':
    case undefined:
      return `${name} configuration token not renewed${because(payload.reason)}`;
    default: {
      const unknown: never = payload.outcome;
      return `${name} configuration token used: ${String(unknown)}`;
    }
  }
}

/**
 * The label of a revoked shared connection's own app-actor token at the vendor (R41V-1): the
 * organisation's token, not an employee's access.
 */
function sharedTokenRevokedLabel(payload: Read<'organisation.revoked-at-source'>): string {
  const system = systemDisplayName(text(payload.system) ?? 'the vendor');
  const token = `${system} shared app token`;
  switch (payload.outcome) {
    case 'token-revoked':
      return `${token} revoked at ${system}`;
    case 'already-gone':
      return `${token} already revoked at ${system}`;
    case 'retrying':
      return `${token}: revocation at ${system} failed, trying again${because(payload.reason)}`;
    case 'failed':
      return `${token}: revocation at ${system} failed${because(payload.reason)}; Day0's copy deleted`;
    case 'app-deleted':
    case 'app-uninstalled':
    case 'not-supported':
    case 'shared':
    case 'not-at-vendor':
    case 'pasted-key':
    case undefined:
      return `${token} ended with its connection`;
    default: {
      const unknown: never = payload.outcome;
      return `${token} ended with its connection (${String(unknown)})`;
    }
  }
}

/** The label of one end of access at the vendor (11-AR), by its outcome and system. */
function revokedAtSourceLabel(payload: Read<'credential.revoked-at-source'>): string {
  const system = systemDisplayName(text(payload.system) ?? 'the vendor');
  switch (payload.outcome) {
    case 'token-revoked':
      return `revoked at ${system}${
        payload.channelMembershipsRemoved === true ? '; its channel memberships were removed' : ''
      }`;
    case 'app-deleted':
      return `${system} app deleted in ${system}`;
    case 'app-uninstalled':
      return `${system} app uninstalled from ${system}`;
    case 'already-gone':
      return `already revoked at ${system}`;
    case 'retrying':
      return `revocation at ${system} failed, trying again${because(payload.reason)}`;
    case 'failed':
      return `revocation at ${system} failed${because(payload.reason)}; Day0's copy deleted`;
    case 'not-supported':
      return `not revoked at ${system}: no revocation call; Day0's copy deleted`;
    case 'shared':
      // The connection's own revoke revokes the shared token (R41V-1); any other end keeps it.
      return payload.end === 'organisation-revoked'
        ? `shared app token: revoked at ${system} with the organisation's connection`
        : `shared app token: not revoked at ${system}`;
    case 'not-at-vendor':
      return `nothing changed at ${system}`;
    case 'pasted-key':
      return `pasted key: never sent to ${system}; revoke it there`;
    case undefined:
      return 'access ended';
    default: {
      const unknown: never = payload.outcome;
      return `access ended (${String(unknown)})`;
    }
  }
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
  'agent.paused': (payload) => {
    const reason = text(payload.reason);
    return `paused by the manager${reason ? `: ${reason.replace(/[.!?]+$/, '')}` : ''}`;
  },
  'agent.resumed': 'resumed by the manager',
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
    `handover declined by ${text(payload.toAddress) ?? 'the named manager'}`,
  'manager.transfer-expired': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} expired`,
  'manager.transfer-settle-failed': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} not finished yet`,
  'manager.transfer-ended': (payload) =>
    `handover to ${text(payload.toAddress) ?? 'another manager'} ended${
      payload.reason === 'operator' ? ' by the operator' : ', it could not finish'
    }`,
  'manager.transfer-note-withheld': (payload) =>
    `handover note to ${text(payload.toAddress) ?? 'the named manager'} withheld`,
  'manager.transfer-notice': (payload) =>
    `handover notice to ${text(payload.toAddress) ?? 'the named manager'} ${
      payload.delivered === true ? 'sent' : 'not sent'
    }`,
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
  'charter.seeding-requested': () => 'finding work again from the approved charter',
  'charter.seeded': () => 'approved charter set up: its systems are being oriented',
  'person.proposed': (payload) =>
    `person proposed: ${text(payload.person) ?? 'from the charter'}${
      payload.via === 'handover' ? ' · from the charter the handover brought' : ''
    }`,
  'person.confirmed': (payload) =>
    `person confirmed: ${text(payload.person) ?? 'a proposal'}${
      payload.how === 'same-person' ? ' · the same as one already known' : ''
    }`,
  'person.dismissed': (payload) => `person dismissed: ${text(payload.person) ?? 'a proposal'}`,
  'relationship.changed': (payload) =>
    `${relationshipNoun(payload.type)} ${
      payload.change === 'retired' ? 'ended' : payload.change === 'edited' ? 'changed' : 'added'
    }: ${text(payload.person) ?? 'a person'}`,
  'work.charter-derived': (payload) =>
    `${counted(payload.count, 'work item') ?? 'work items'} seeded from the charter`,
  'coworker.replied': (payload) =>
    `${text(payload.responder) ?? 'a colleague'} replied${text(payload.channelSlug) ? ` in #${payload.channelSlug}` : ''}`,
  'documentation.systems-discovered': (payload) =>
    `documentation read: ${counted(payload.systems, 'system') ?? 'systems'} found${
      typeof payload.created === 'number' && payload.created > 0 ? `, ${payload.created} new` : ''
    }${typeof payload.retired === 'number' && payload.retired > 0 ? `, ${payload.retired} gone` : ''}`,
  'documentation.page-status-changed': (payload) =>
    `documentation page ${text(payload.title) ? `"${payload.title}" ` : ''}${pageStatusLabel(payload.to)}`,
  'documentation.relation-proposed': (payload) =>
    `documentation: ${relationLabel(payload.kind)} to decide${
      text(payload.from?.title) ? `, "${payload.from?.title}"` : ''
    }`,
  'documentation.relation-decided': (payload) =>
    payload.decision === 'undo'
      ? `documentation: the answer on ${relationLabel(payload.kind)} taken back`
      : `documentation: ${relationLabel(payload.kind)} decided`,
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
  'voice.restarted': '1:1 held again',
  'skill.authoring-refused': (payload) =>
    `skill ${text(payload.name) ?? 'unnamed'} not moved on: it is ${text(payload.state) ?? 'elsewhere'} now`,
  'skill.builtin-installed': (payload) =>
    `built-in skill installed: ${text(payload.name) ?? 'unnamed'}`,
  'skill.proposed': (payload) => `skill proposed: ${text(payload.name) ?? 'unnamed'}`,
  'skill.approved': (payload) => `skill approved: ${text(payload.name) ?? 'unnamed'}`,
  'skill.rejected': (payload) =>
    payload.offerWithdrawn === undefined
      ? `skill rejected: ${text(payload.name) ?? 'unnamed'}`
      : `skill adoption ended, version withdrawn: ${text(payload.name) ?? 'unnamed'}`,
  'skill.revision-requested': (payload) =>
    typeof payload.revisionId === 'string'
      ? `skill revision asked for: ${text(payload.name) ?? 'unnamed'}`
      : `skill sent back to be written again: ${text(payload.name) ?? 'unnamed'}`,
  'skill.retired': (payload) =>
    `skill retired${payload.withdrawn === true ? ', withdrawn from every employee' : ''}: ${
      text(payload.name) ?? 'unnamed'
    }${because(payload.reason)}`,
  'skill.revoked': (payload) => {
    const holders = Array.isArray(payload.holders)
      ? payload.holders.flatMap((holder: { agentName?: unknown }) => text(holder.agentName) ?? [])
      : [];
    return `skill withdrawn from every employee: ${text(payload.name) ?? 'unnamed'}${
      typeof payload.version === 'number' ? ` v${payload.version}` : ''
    }${holders.length > 0 ? `, ${holders.join(', ')}` : ''}${because(payload.reason)}`;
  },
  'skill.rechecked': (payload) =>
    `skill re-checked: ${text(payload.name) ?? 'unnamed'}${
      typeof payload.version === 'number' ? ` v${payload.version}` : ''
    }`,
  'skill.superseded': (payload) =>
    `skill superseded by its revision: ${text(payload.name) ?? 'unnamed'}${
      typeof payload.version === 'number' ? ` v${payload.version}` : ''
    }`,
  'skill.given-up': (payload) =>
    `skill given up: ${text(payload.name) ?? 'unnamed'}${
      typeof payload.attempts === 'number'
        ? ` after ${payload.attempts} ${payload.attempts === 1 ? 'attempt' : 'attempts'}`
        : ''
    }`,
  'skill.authoring-superseded': (payload) =>
    `skill authoring taken over: ${text(payload.name) ?? 'unnamed'}${
      duration(payload.heldForMs) ? `, the last run held it ${duration(payload.heldForMs)}` : ''
    }`,
  'skill.authoring-held': (payload) =>
    `skill authoring held: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
  'skill.authoring-resumed': (payload) =>
    `skill authoring resumed after the pause: ${text(payload.name) ?? 'unnamed'}`,
  'skill.authoring-hold-spent': (payload) =>
    `skill authoring not resumed after the pause: ${text(payload.name) ?? 'unnamed'}`,
  'skill.authoring-claimed': (payload) =>
    payload.purpose === 'verify-stored'
      ? `skill check started: ${text(payload.name) ?? 'unnamed'}`
      : `skill authoring started: ${text(payload.name) ?? 'unnamed'}`,
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
  'surface.orientation-held': (payload) => `orientation held${because(payload.reason)}`,
  'surface.orientation-resumed': 'orientation resumed after the pause',
  'surface.orientation-hold-spent': 'orientation not resumed after the pause',
  'surface.app-provisioned': (payload) =>
    `app registered${text(payload.appName) ? `: ${payload.appName}` : ''}`,
  'surface.app-forgotten': (payload) =>
    `app forgotten${text(payload.appName) ? `: ${payload.appName}` : ''}; IT deletes it in Slack's app settings`,
  'surface.socket-token-landed': (payload) =>
    `app-level token ${payload.replaced === true ? 'replaced' : 'landed'}: decision buttons on`,
  'surface.app-messages-open': (payload) => `${messagesOpenLabel(payload.how)}: typed code on`,
  'surface.install-failed': (payload) => `app install failed${because(payload.reason)}`,
  'surface.shared-credential-retired': (payload) =>
    `shared credential retired${because(payload.reason)}`,
  'credential.superseded': (payload) => {
    const label = text(payload.label);
    const page = text(payload.page);
    const rebound = payload.reboundSurfaceIds?.length
      ? counted(payload.reboundSurfaceIds.length, 'card')
      : undefined;
    const unbound = payload.surfaceIds?.length
      ? counted(payload.surfaceIds.length, 'card')
      : undefined;
    const what = rebound ? 'replaced in the documentation' : 'no longer in the documentation';
    return `credential${label ? ` "${label}"` : ''} ${what}${page ? ` (${page})` : ''}${rebound ? `; the new value bound on ${rebound}` : ''}${unbound ? `; land one again on ${unbound}` : ''}`;
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
  'surface.access-requested': (payload) => {
    const scopes = listed(payload.scopes);
    return `access requested from IT${scopes ? `: ${scopes}` : ''}`;
  },
  'organisation.connection-landed': (payload) =>
    `${text(payload.displayName) ?? 'a system'} connected for the organisation`,
  'organisation.connection-rotated': (payload) =>
    `${text(payload.displayName) ?? 'a system'}: the organisation connection's secret rotated`,
  'organisation.connection-corrected': (payload) =>
    `${text(payload.displayName) ?? 'a system'}: the organisation connection's ${correctedWhat(payload)}`,
  'organisation.connection-revoked': (payload) =>
    `${text(payload.displayName) ?? 'a system'}: the organisation connection revoked${because(payload.reason)}`,
  'surface.authorised': 'authorised at its authorisation server',
  'surface.authorisation-failed': (payload) => `authorisation failed${because(payload.reason)}`,
  'surface.disconnected': (payload) =>
    payload.by === 'organisation'
      ? `disconnected: the organisation's connection was revoked${because(payload.reason)}`
      : 'disconnected by the manager',
  'credential.revoked-at-source': (payload) => revokedAtSourceLabel(payload),
  'organisation.revoked-at-source': (payload) =>
    payload.shared === true
      ? sharedTokenRevokedLabel(payload)
      : `${systemDisplayName(text(payload.system) ?? 'the vendor')} organisation connection: ${revokedAtSourceLabel(payload)}`,
  'organisation.configuration-used': (payload) => configurationUsedLabel(payload),
  'surface.channels-rejoined': (payload) => {
    const joined = listed(payload.joined);
    const needing = listed(payload.needsPerson);
    if (joined === undefined && needing === undefined) return 'no channel to re-join';
    const many = Array.isArray(payload.needsPerson) && payload.needsPerson.length > 1;
    const needs =
      needing === undefined ? '' : `${needing} ${many ? 'need' : 'needs'} a person to add it`;
    return joined === undefined ? needs : `re-joined ${joined}${needs ? `; ${needs}` : ''}`;
  },
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
  'work.waiting-for-skill': (payload) =>
    `waiting for a skill again: ${text(payload.name) ?? 'unnamed'}${because(payload.reason)}`,
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
  'work.plan-redraft': 'plan drafted again: documentation it followed has changed',
  'work.corrections-applied': (payload) =>
    `plan applies ${counted(payload.correctionIds?.length, 'kept correction') ?? 'kept corrections'}`,
  'work.corrections-redaction-limited': 'kept corrections read with limited redaction',
  'work.correction-retired': 'kept correction retired',
  'agreement.proposed': 'working agreement proposed',
  'agreement.activated': (payload) =>
    payload.afterHold === true
      ? 'working agreement for every employee now in effect for this employee: checked against its charter'
      : payload.everyEmployee === true
        ? 'working agreement kept for every employee'
        : 'working agreement kept',
  'agreement.refused': (payload) =>
    payload.reason === 'every-employee-too-many'
      ? `working agreement not in effect for every employee: you have more than ${EMPLOYEES_CHECKED} employees`
      : payload.reason === 'unchecked-for-employee'
        ? 'working agreement for every employee not in effect for this employee: not checked against its charter'
        : text(payload.clause)
          ? `working agreement refused: it contradicts “${text(payload.clause)}”`
          : 'working agreement refused: it would go beyond the charter',
  'agreement.retired': (payload) =>
    payload.how === 'dismissed'
      ? 'proposed working agreement set aside'
      : 'working agreement retired',
  'work.draft-resumed': (payload) =>
    `plan draft restarted after it died${typeof payload.attempt === 'number' ? ` (restart ${payload.attempt})` : ''}`,
  'work.execution-resumed': (payload) =>
    `execution restarted after it failed outside the item${typeof payload.attempt === 'number' ? ` (restart ${payload.attempt})` : ''}${typeof payload.reason === 'string' && payload.reason !== '' ? `: ${payload.reason}` : ''}`,
  'work.plan-held': (payload) =>
    payload.reason === 'documentation-conflict' && text(payload.heading)
      ? `plan held for you: two pages disagree about "${payload.heading}"; decide on the Documentation tab`
      : `plan held for you: ${planHeldWords(payload.reason)}`,
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
  'work.decision-request-replacing': 'marking the replaced request in the manager DM',
  'work.decision-acknowledging': (payload) =>
    ACKNOWLEDGEMENT_LABELS[payload.kind ?? 'received'] ?? ACKNOWLEDGEMENT_LABELS.received,
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
  'work.closed-without-retry': 'closed by the manager without a retry',
  'work.actions-withheld': (payload) =>
    `${counted(payload.withheld?.length, 'action') ?? 'actions'} held and never sent`,
  'work.stopped': (payload) => `stopped by the manager${because(payload.reason)}`,
  'work.execution-claimed': 'run started',
  'work.dependent-authoring': 'closing actions written from what the first phase landed',
  'work.dependent-authoring-claimed': 'closing phase started',
  'work.completed': (payload) => finishedAs(payload.output),
  'work.failed': (payload) =>
    payload.stopped === true ? 'run stopped' : `run failed${because(payload.reason)}`,
  'work.actions-auto-applying': (payload) =>
    `applying ${counted(payload.autoIndexes?.length, 'action') ?? 'actions'} ${
      payload.autonomousActions === true ? 'autonomously' : 'automatically'
    }`,
  'work.actions-pending': (payload) =>
    payload.leftForCard === true
      ? 'ticket close held, waiting on its card'
      : `${counted(payload.heldIndexes?.length, 'action') ?? 'actions'} held for your approval`,
  'work.actions-approved': (payload) =>
    `${counted(payload.approvedIndexes?.length, 'action') ?? 'actions'} approved${decidedFrom(payload.decidedVia)}${
      (payload.leftForCard?.length ?? 0) > 0 ? '; the ticket close left for its card' : ''
    }`,
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
  'work.documentation-selected': documentationSelectedLabel,
  'work.documentation-selection-failed': (payload) =>
    `documentation not selected${
      text(payload.site)
        ? ` · ${DOCUMENTATION_SITE_WORDS[payload.site as string] ?? payload.site}`
        : ''
    } · every page was read instead`,
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
const RECORD_KINDS: Readonly<
  Partial<Record<EventType, Exclude<RecordKind, 'noted' | 'partly-done' | 'not-done'>>>
> = {
  'work.completed': 'landed',
  'work.provider-reconciled': 'landed',
  'charter.approved': 'landed',
  'skill.registered': 'landed',
  'skill.rechecked': 'landed',
  'skill.builtin-installed': 'landed',
  'surface.connected': 'landed',
  'work.actions-rejected': 'refused',
  'work.claim-refused': 'refused',
  'skill.rejected': 'refused',
  'skill.retired': 'withheld',
  'skill.revoked': 'withheld',
  'skill.given-up': 'withheld',
  'skill.authoring-refused': 'refused',
  'skill.verification-failed': 'refused',
  'surface.rejected': 'refused',
  'charter.evidence-rejected': 'refused',
  'skill.failed': 'refused',
  'skill.author-failed': 'refused',
  'audit.corrected': 'refused',
  'agreement.activated': 'landed',
  'agreement.refused': 'refused',
  'agreement.retired': 'withheld',
  'work.decision-ignored': 'refused',
  'manager.transfer-declined': 'refused',
  'work.conditional-writes-withheld': 'withheld',
  'work.actions-withheld': 'withheld',
  'work.skipped': 'withheld',
  'work.withdrawn': 'withheld',
  'work.cancelled': 'withheld',
  'manager.transfer-cancelled': 'withheld',
  'manager.transfer-expired': 'withheld',
  'manager.transfer-ended': 'withheld',
  'manager.transfer-note-withheld': 'withheld',
  'work.actions-pending': 'held',
  'work.plan-held': 'held',
  'skill.proposed': 'held',
  'work.waiting-for-skill': 'held',
  'surface.proposed': 'held',
};

/**
 * What a record line's dot says an event did: landed, refused, withheld, held for the manager,
 * or, for every other event, noted. A finished run is drawn by its own answer when that says it
 * was partly done or not done, as the line's words and its card say it (13-FD's R3, a product
 * call built as the walk recommends): its writes landed, but the work did not. A type the
 * contract no longer lists (a row an older release wrote) is noted too.
 *
 * @param event - The stored event.
 */
export function recordKindOf(
  event: Pick<Doc<'events'>, 'type'> & { payload?: unknown },
): RecordKind {
  if (event.type === 'work.completed') {
    const output = (event.payload as { output?: unknown } | null | undefined)?.output;
    const end = finishedAs(output);
    if (end !== 'done') return end === 'partly done' ? 'partly-done' : 'not-done';
  }
  return (isEventType(event.type) ? RECORD_KINDS[event.type] : undefined) ?? 'noted';
}
