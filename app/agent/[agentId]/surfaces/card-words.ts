import type { Doc } from '@convex/_generated/dataModel';
import type { SurfacePath } from '@/surfaces/types';
import type {
  OrganisationConnectionKind,
  OrganisationConnectionMode,
} from '@/surfaces/access-identity';
import type { CardIdentity, KeyOrigin } from '@/surfaces/card-identity';
import { isSlackApiEndpoint } from '@/surfaces/slack-endpoint';
import type { DecisionButtons } from '@/surfaces/slack-socket';
import { MESSAGES_TAB_TOGGLE, type TypedCodeReach } from '@/surfaces/slack-messages-tab';
import { addDays, dayKey, deploymentZone, expiryNoticeDue } from '@/lib/zone';
import type { Tone } from '../../../components/tone';

/** The verdicts of an approved card, whose access runs on a clock. */
const ACCESS_VERDICTS: ReadonlySet<Doc<'surfaces'>['verdict']> = new Set([
  'approved',
  'connected',
  'ungranted',
  'listed-dead',
]);

/** Each rung of the ladder as the card names it, and how a system on it is reached. */
const RUNGS: Readonly<Record<SurfacePath, { readonly name: string; readonly via: string }>> = {
  mcp: { name: 'MCP', via: 'over MCP' },
  'documented-api': { name: 'API', via: 'over its API' },
  'browser-driven': { name: 'browser', via: 'in a browser' },
  escalate: { name: 'escalation', via: 'by escalation' },
};

/** A surface as the card's words read it. */
export type WordedSurface = Pick<
  Doc<'surfaces'>,
  'verdict' | 'path' | 'credentialLanded' | 'expiresAt' | 'reason' | 'endpoint' | 'displayName'
>;

/** Where a card's access stands against its end date. */
export type AccessStanding =
  | { readonly kind: 'none' }
  | { readonly kind: 'running'; readonly expiresAt: number }
  | { readonly kind: 'ending'; readonly expiresAt: number; readonly daysLeft: number }
  | { readonly kind: 'ended'; readonly expiresAt: number };

/**
 * Where a card's access stands: not started (the card is not approved), running, ending (from
 * the day the server's week notice is due, in the employee's zone, so the card and the notice
 * never disagree by a day), or ended. A passed date is ended whatever the hourly sweep has
 * marked, and so is a card the sweep marked `expired` (K finding 5).
 *
 * @param surface - The card's row.
 * @param now - The instant to judge against.
 * @param zone - The employee's zone; the deployment's when the page has none.
 */
export function accessStanding(
  surface: Pick<WordedSurface, 'verdict' | 'expiresAt' | 'reason'>,
  now: number,
  zone: string | undefined,
): AccessStanding {
  if (!ACCESS_VERDICTS.has(surface.verdict) || surface.expiresAt === undefined) {
    return { kind: 'none' };
  }
  const { expiresAt } = surface;
  if (surface.reason === 'expired' || expiresAt <= now) return { kind: 'ended', expiresAt };
  const day = zone ?? deploymentZone();
  if (expiryNoticeDue(now, expiresAt, day)) {
    return { kind: 'ending', expiresAt, daysLeft: calendarDaysBetween(now, expiresAt, day) };
  }
  return { kind: 'running', expiresAt };
}

/**
 * The calendar days from one instant's day to a later one's, in a zone: 0 on the same day, 7 on
 * the notice day of a week's notice. Counted, not divided, so a daylight-saving day counts once.
 */
function calendarDaysBetween(from: number, to: number, zone: string): number {
  const end = dayKey(to, zone);
  let days = 0;
  for (let key = dayKey(from, zone); key < end; key = addDays(key, 1)) days += 1;
  return days;
}

/** The rung a path names, or nothing for a card with no path yet. */
function rungOf(path: string | undefined): (typeof RUNGS)[SurfacePath] | undefined {
  return path !== undefined && Object.hasOwn(RUNGS, path) ? RUNGS[path as SurfacePath] : undefined;
}

/**
 * How a system on this path is reached, in the card's words: "over MCP", "in a browser".
 *
 * @param path - The card's approved or proposed path.
 */
export function reachedWords(path: string | undefined): string | undefined {
  return rungOf(path)?.via;
}

/** A card's state chip: its words and its tone. */
export interface StateChipWords {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * The state chip a card carries, in the manager's words: what the card is waiting for or what it
 * can do, never the stored verdict. Access that has ended or ends within the week outranks the
 * connection, since it is what the manager has to act on.
 *
 * An approved card with nothing landed says what it waits on where that is not a paste: IT, for a
 * card whose access request is out, or the manager's Connect, for a card IT's connection covers;
 * so does one its approval's probe left `ungranted` with no credential, when the caller says so.
 *
 * @param surface - The card's row.
 * @param now - The instant to judge the access against.
 * A Slack card whose own app is never installed again (W12X-4) waits on nothing and says it ended.
 *
 * @param options - What an approved card with nothing landed waits on, when not a paste, and
 *   whether its own app is not installed again.
 */
export function stateChip(
  surface: WordedSurface,
  now: number,
  zone: string | undefined,
  options: { readonly waitsOn?: 'it' | 'connect'; readonly notReinstalled?: boolean } = {},
): StateChipWords {
  const access = accessStanding(surface, now, zone);
  if (access.kind === 'ended') return { text: 'Access ended', tone: 'warn' };
  // The card's own app is never installed again, so nothing it waits on brings it back (W12X-4).
  if (options.notReinstalled === true) return { text: 'Ended', tone: 'warn' };
  if (access.kind === 'ending') {
    return {
      text:
        access.daysLeft === 0
          ? 'Expires today'
          : `Expires in ${access.daysLeft} ${access.daysLeft === 1 ? 'day' : 'days'}`,
      tone: 'warn',
    };
  }
  const rung = rungOf(surface.path);
  switch (surface.verdict) {
    case 'declared':
      return { text: 'No proposal yet', tone: 'muted' };
    case 'proposed':
      return { text: rung ? `Proposed · ${rung.name}` : 'Proposed', tone: 'muted' };
    case 'approved':
      if (surface.credentialLanded) return { text: 'Checking the connection', tone: 'accent' };
      if (options.waitsOn === 'it') return { text: 'Waiting on IT', tone: 'muted' };
      if (options.waitsOn === 'connect') return { text: 'Ready to connect', tone: 'accent' };
      return { text: 'Needs its credential', tone: 'warn' };
    case 'connected':
      return { text: rung ? `Connected ${rung.via}` : 'Connected', tone: 'ok' };
    case 'ungranted':
      // The approval's own probe finds no credential before IT's install or the manager's
      // Connect lands one, and the card is waiting on that, not refused (the wave 11 review's m23).
      if (options.waitsOn === 'it') return { text: 'Waiting on IT', tone: 'muted' };
      if (options.waitsOn === 'connect') return { text: 'Ready to connect', tone: 'accent' };
      return { text: 'Not granted', tone: 'warn' };
    case 'listed-dead':
      return { text: 'Not answering', tone: 'warn' };
    case 'absent':
      return { text: 'Not found', tone: 'muted' };
  }
}

/** What a card's credential field asks for: its label and the line under it. */
export interface ExpectedCredential {
  /** Whose credential the field takes, as its label says it. */
  readonly label: string;
  /** What happens to it, or what is refused. */
  readonly hint: string;
}

/**
 * Whose credential a card's field expects (Q10): the Slack app's bot token, the sign-in a browser
 * session types, or the credential the documentation names. The Slack line is the rule the
 * server's landing refusal enforces (`credentialLandingRefusal`).
 *
 * @param surface - The card's row.
 * @param documented - The credential's name as the documentation gives it, when it gives one.
 */
export function expectedCredential(
  surface: Pick<WordedSurface, 'path' | 'endpoint' | 'displayName'>,
  documented: string | undefined,
): ExpectedCredential {
  if (isSlackApiEndpoint(surface.endpoint)) {
    return {
      label: "The Slack app's bot token, the one that begins xoxb-",
      hint: 'A user token would post as that person, so Slack takes only the bot token here. It is stored encrypted and never shown again.',
    };
  }
  if (surface.path === 'browser-driven') {
    return {
      label: documented
        ? `The ${documented} the browser session signs in with`
        : `The ${surface.displayName} sign-in for the browser session`,
      hint: "The browser session types it only into the sign-in form's credential field. It is stored encrypted and never shown again.",
    };
  }
  return {
    label: documented
      ? `The ${documented} the documentation names`
      : `A ${surface.displayName} credential with the documented permissions`,
    hint: 'It is stored encrypted and never shown again.',
  };
}

/**
 * A system IT connected for the organisation, as `organisationConnections.summaryForManager` lists
 * it for any manager: never a secret, a client id or a revoked connection.
 */
export interface OrganisationSystem {
  /** The system's key, as `organisationSystemOf` reads it off a card. */
  readonly system: string;
  readonly displayName: string;
  /** What IT registered: only a kind an issuer of Day0's acts through covers a card (D6). */
  readonly kind: OrganisationConnectionKind;
  readonly mode: OrganisationConnectionMode;
  readonly status: 'active' | 'needs-attention';
  readonly connectedAt: number;
}

/** Who and where an identity's words name: the employee, and the system as the card names it. */
export interface IdentityNames {
  readonly employee: string;
  readonly system: string;
}

/**
 * The "Acts as" row's words for an identity, one sentence per kind (the wave file's drafts,
 * section 4 "11-AC"; a product call, flagged): the employee's own app, the organisation's shared
 * app with Day0 recording who did what, the manager's delegated grant, a pasted key whose owner
 * the writes show, or the employee's own browser seat. The row's label says "Acts as", so the
 * words begin with whom.
 *
 * @param identity - Whom the card acts as, or will.
 * @param names - The employee's name and the system's.
 */
export function actsAsWords(identity: CardIdentity, names: IdentityNames): string {
  const { employee, system } = names;
  switch (identity.kind) {
    case 'own-app': {
      const named =
        identity.label !== undefined && identity.label !== employee
          ? `, named “${identity.label}” in ${system}`
          : '';
      return `${employee}, its own ${system} app${named}`;
    }
    case 'shared-app':
      return 'the Day0 app shared by your employees; Day0 records which employee did what';
    case 'delegated':
      return `you in ${system}: what it touches shows your name`;
    case 'shared-key': {
      const key =
        identity.keyFrom === 'documentation'
          ? 'a key found in your documentation'
          : `a key someone ${identity.planned ? 'pastes here' : 'pasted'}`;
      return `${key}; its writes show that key's owner, and Day0 adds ${employee}'s name to each write`;
    }
    case 'browser-seat':
      return `${employee}, signed in to its own seat in ${system}`;
    default: {
      const unknown: never = identity.kind;
      throw new Error(`unhandled identity kind ${String(unknown)}`);
    }
  }
}

/**
 * The warning chip beside an identity the employee shares with someone (a person's delegated
 * grant, a pasted or documented key), as the card draws one for a governance finding (the access
 * plan, section 4.3), or nothing for the employee's own identity and the organisation's shared
 * app.
 *
 * @param identity - Whom the card acts as, and where a key it holds came from.
 */
export function identityChip(identity: Pick<CardIdentity, 'kind' | 'keyFrom'>): string | undefined {
  const { kind } = identity;
  switch (kind) {
    case 'delegated':
      return 'Delegated';
    case 'shared-key':
      return identity.keyFrom === 'documentation' ? 'Documented key' : 'Pasted key';
    case 'own-app':
    case 'shared-app':
    case 'browser-seat':
      return undefined;
    default: {
      const unknown: never = kind;
      throw new Error(`unhandled identity kind ${String(unknown)}`);
    }
  }
}

/**
 * A day as the card names it: "1 October", in the zone given.
 *
 * @param ms - The instant.
 * @param zone - The zone the day is named in.
 */
export function calendarDay(ms: number, zone: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', timeZone: zone }).format(
    ms,
  );
}

/**
 * What a card its approval's probe found with no credential says while it waits for one (the wave
 * 11 review's m23): the employee reads nothing from the system until IT gives it access, or until
 * the manager connects it.
 *
 * @param employee - The employee's name.
 * @param system - The card's system, as the card names it.
 * @param waitsOn - Whom the card waits on.
 */
export function awaitingAccessWords(
  employee: string,
  system: string,
  waitsOn: 'it' | 'connect',
): string {
  return waitsOn === 'it'
    ? `${employee} reads nothing from ${system} until IT gives it access.`
    : `${employee} reads nothing from ${system} until you connect it.`;
}

/**
 * The manager's read-only line for a system IT connected for the organisation: "Connected for
 * your organisation by IT on 1 October" (the wave file's draft; a product call, flagged). A card
 * still acting as a pasted key says the connection is not its own yet, so the line is not read as
 * true of the card beside "Acts as a key someone pasted" (the wave 11 review's m19).
 *
 * @param connection - The organisation's connection for the card's system.
 * @param zone - The zone the day is named in.
 * @param onPastedKey - Whether the card still acts as a key someone pasted.
 */
export function connectedForOrganisationWords(
  connection: Pick<OrganisationSystem, 'connectedAt'>,
  zone: string,
  onPastedKey = false,
): string {
  const line = `Connected for your organisation by IT on ${calendarDay(connection.connectedAt, zone)}`;
  return onPastedKey ? `${line}. This card does not use it yet.` : line;
}

/**
 * What a card's Disconnect does at the vendor, line by line, for the dialog that confirms it
 * (11-AR's `surfaces.disconnect`; D4, D5): what Day0 obtained is revoked there and an app it
 * created stays, a shared app is not revoked, a delegated grant is revoked where the system offers
 * a way, and a pasted key is left as it is. A Slack app's bot also loses its channels (S1), which
 * a renewal restores by RM4's rule (ruled 1 October: public channels re-joined by the employee,
 * private ones by a person). The wave file's draft, flagged as a product call.
 *
 * @param identity - Whom the card acts as.
 * @param names - The employee's name and the system's.
 * @param options - Whether the card is on Slack, whose bot leaves its channels at the end.
 */
export function disconnectLines(
  identity: CardIdentity,
  names: IdentityNames,
  options: { readonly slack: boolean },
): string[] {
  const { employee, system } = names;
  switch (identity.kind) {
    case 'own-app':
      return options.slack
        ? [
            `${employee}'s own Slack app stays installed, but its token is revoked at Slack and its bot leaves every channel.`,
            'Connect brings it back: it re-joins its public channels itself, and someone adds it to each private one.',
          ]
        : [
            `${employee}'s own ${system} app: its token is revoked at ${system}. The app stays, so Connect brings it back.`,
          ];
    case 'shared-app':
      return [
        `The Day0 app your employees share is not revoked at ${system}: the others still use it. Day0 stops using it for ${employee}.`,
      ];
    case 'delegated':
      return [
        `Your authorisation for ${employee} is revoked at ${system}, where ${system} offers a way to.`,
      ];
    case 'shared-key':
    case 'browser-seat':
      return [
        identity.keyFrom === 'documentation'
          ? `The key found in your documentation is left as it is at ${system}: Day0 stops using it and never revokes a key it did not obtain, and it stays in your stored credentials. Revoke it there if it should end.`
          : `The key someone pasted is left as it is at ${system}: Day0 stops using it and never revokes a pasted key, and it stays in your stored credentials. Revoke it there if it should end.`,
      ];
    default: {
      const unknown: never = identity.kind;
      throw new Error(`unhandled identity kind ${String(unknown)}`);
    }
  }
}

/**
 * What ending a Slack own-app card does to its bot's channels, and what bringing it back restores
 * (S1; RM4, ruled 1 October). The wave file's draft said the manager adds it to its channels
 * again; RM4's ruling has the employee re-join its public channels itself.
 *
 * @param employee - The employee's name.
 * @param restoredBy - What brings the card back, as the sentence's subject: "Renewing",
 *   "Connecting again".
 */
export function slackChannelsGoWords(employee: string, restoredBy: string): string {
  return `Slack: ${employee}'s bot is switched off and removed from its channels. ${restoredBy} turns it back on; it re-joins its public channels itself, and someone in each private channel adds it again.`;
}

/** A card's latest re-join after a Slack renewal, as `surfaces.listForAgent` lists it. */
export interface RejoinFacts {
  readonly joined: readonly string[];
  readonly needsPerson: readonly string[];
  /** Slack's words when it refused a join. */
  readonly reason?: string;
  /** When the re-join was recorded. */
  readonly at: number;
}

/** Channel names as a sentence lists them: "#a", "#a and #b", "#a, #b and #c". */
function channelList(channels: readonly string[]): string {
  return channels.length <= 1
    ? (channels[0] ?? '')
    : `${channels.slice(0, -1).join(', ')} and ${channels.at(-1) ?? ''}`;
}

/**
 * What the latest renewal's re-join did (AS10; 11-AC's item 5): the channels the bot re-joined
 * itself, and those that need a person in them to add it, with Slack's words for a refused join.
 * Nothing for a re-join older than the install the card holds now, or one that touched no channel.
 *
 * @param rejoin - The card's latest re-join, when a renewal made one.
 * @param employee - The employee's name.
 * @param installedAt - When the card's app was last installed.
 */
export function rejoinWords(
  rejoin: RejoinFacts | undefined,
  employee: string,
  installedAt: number | undefined,
): string | undefined {
  if (rejoin === undefined || (installedAt !== undefined && rejoin.at < installedAt)) {
    return undefined;
  }
  const parts = [
    ...(rejoin.joined.length > 0
      ? [`${employee} rejoined ${channelList(rejoin.joined)} itself`]
      : []),
    ...(rejoin.needsPerson.length > 0
      ? [
          rejoin.needsPerson.length === 1
            ? `${channelList(rejoin.needsPerson)} needs someone in it to add ${employee}`
            : `${channelList(rejoin.needsPerson)} need someone in each to add ${employee}`,
        ]
      : []),
  ];
  if (parts.length === 0) return undefined;
  // Slack's words keep their own full stop, never a second one.
  const said =
    rejoin.reason === undefined ? '' : ` Slack said: ${rejoin.reason.replace(/[.\s]+$/, '')}.`;
  return `After the renewal, ${parts.join('; ')}.${said}`;
}

/**
 * The move off a pasted key a card offers at its renewal once IT has connected its system (A27;
 * the access plan, section 8 step 8): whom it would act as instead, and that the key keeps working
 * until the manager moves it. A product call, flagged.
 *
 * @param target - Whom the card would act as through the organisation's connection.
 * @param names - The employee's name and the system's.
 * @param from - Where the key the card holds came from: a paste, or the documentation (B1).
 */
export function moveOfferWords(
  target: CardIdentity,
  names: IdentityNames,
  from: KeyOrigin = 'paste',
): string {
  const instead =
    target.kind === 'delegated'
      ? 'act as you there'
      : target.kind === 'shared-app'
        ? 'use the Day0 app your employees share'
        : `use its own ${names.system} app`;
  const key = from === 'documentation' ? 'the key found in your documentation' : 'the pasted key';
  return `IT has connected ${names.system}. ${names.employee} can ${instead} instead of ${key}, which keeps working until you move it.`;
}

/**
 * The move's button, naming the key it moves off (A27; B1).
 *
 * @param from - Where the key the card holds came from.
 */
export function moveLabel(from: KeyOrigin): string {
  return from === 'documentation' ? 'Move off the documented key' : 'Move off the pasted key';
}

/**
 * What a card says of a key its documentation gives where IT's active connection covers the
 * system (B1, decision 1 (a), a product call, flagged): the orientation found it, Day0 bound none,
 * and the employee acts through IT's connection. A draft.
 *
 * @param system - The system's name.
 * @param employee - The employee's name.
 */
export function documentedKeyUnusedWords(employee: string): string {
  return `Found and not used: ${employee} acts through IT's connection.`;
}

/**
 * Whom a card an administrator ended by revoking its connection acts as: nobody, until IT connects
 * the system again (the design pass's major 3: never the planned key the card no longer plans).
 *
 * @param names - The employee's name and the system's.
 */
export function actsAsAfterRevokeWords(names: {
  readonly employee: string;
  readonly system: string;
}): string {
  return `nobody until IT connects ${names.system} again; then ${names.employee}, through IT's connection`;
}

/**
 * Whom a Slack card acts as once its employee's own app was created through a connection IT
 * revoked: nobody, whatever IT connects next, since Day0 never installs that app again (W12X-4;
 * `KEPT_APP_CONNECTION_REVOKED`). The card's provisioning row says why, once. A draft.
 */
export const NOT_REINSTALLED_ACTS_AS = 'nobody';

/**
 * What such a card says in place of its renewal (W12X-4): nothing goes through it, and renewing
 * brings nothing back, so none is offered. A draft.
 */
export const NOT_REINSTALLED_ACCESS = 'Nothing is read or sent through this card.';

/**
 * How the forget's message names the app it forgot: its name and its Slack app id, since the new
 * app takes the same name and IT deletes the old one by it (13-S). A draft.
 *
 * @param app - The card's app as it stood before the forget.
 */
export function forgottenAppWords(
  app: { readonly appId: string; readonly appName: string } | undefined,
): string {
  return app === undefined ? 'The app' : `${app.appName} (Slack app ${app.appId})`;
}

/**
 * The forget's message (13-S): the app by its name and Slack app id, who deletes it, and that a
 * request it already sent is no longer decided in its own messages, so the manager decides it in
 * day0 (W13-R16: a press there is another app's and is ignored). A draft.
 *
 * @param app - The card's app as it stood before the forget.
 */
export function forgetDoneWords(
  app: { readonly appId: string; readonly appName: string } | undefined,
): string {
  return `${forgottenAppWords(app)} is forgotten. IT deletes it in Slack's app settings. A request it already sent can no longer be decided in its own messages: decide it in day0.`;
}

/**
 * The reason an administrator gave for the revoke that ended a card, said as theirs (the design
 * pass's major 2).
 *
 * @param reason - The administrator's words.
 */
export function itsReasonWords(reason: string): string {
  return `IT's reason: ${reason}`;
}

/**
 * What a card says where IT connected its system in a way no issuer of Day0's acts through (a
 * shared key, a service account): the card takes a key of its own meanwhile (11-AC's item 8, a
 * product call, flagged).
 *
 * @param system - The connection's name.
 */
export function unservedConnectionWords(system: string): string {
  return `IT connected ${system} for the organisation in a way Day0 cannot act through, so this card takes a key of its own.`;
}

/**
 * What a card says when IT's connection covers its system and nothing on the card can use it: no
 * issuer runs for the system, no request is asked and no key may be pasted while it is active
 * (finding 14, for the cockpit). A product call, flagged.
 *
 * @param system - The connection's name.
 * @param employee - The employee's name.
 */
export function noWayOnWords(system: string, employee: string): string {
  return `IT connected ${system} for the organisation in a way this card cannot use for ${employee}. Ask IT how ${employee} should reach it.`;
}

/** The poll's refusal of a Slack history read the card's page never named (`chat-reader.ts`). */
const HISTORY_REFUSAL =
  /Connected Slack surface does not allow conversations\.(?:history|replies)\.$/;

/**
 * A failing manager decision poll in the manager's words (W13-R1): a history read the page never
 * named is a typed code Day0 cannot read, so the manager decides in day0; any other failure is
 * said as the poll recorded it.
 *
 * @param error - The card's `lastDecisionError`.
 */
export function decisionErrorWords(error: string): string {
  return HISTORY_REFUSAL.test(error)
    ? "Day0 cannot read a code you type in Slack, because the documentation's Slack page does not let it read your messages there. Decide in day0 until it does."
    : error;
}

/** What a Slack card says about where the manager's decisions reach them, and what it asks for. */
export interface DecisionButtonsWords {
  readonly title: string;
  readonly note: string;
  /** The card asks for the app's app-level token. */
  readonly asksForToken: boolean;
  /** The card offers to replace a token already landed. */
  readonly offersReplacement: boolean;
}

/**
 * Where a manager channel's decision requests reach the manager (wave 12, 12-M; RM3 (a)): with
 * Approve and Reject buttons beside the typed code, or the typed code alone and why. Asks for the
 * app's app-level token only where its absence is the reason.
 *
 * @param buttons - Whether the card's requests carry buttons, as `listForAgent` read it.
 * @param appName - The employee's own app, where the card has one.
 * @param typedCode - Whether the manager's typed code reaches the app (W12V-7): an app that takes
 *   no messages is never said to take one.
 */
export function decisionButtonsWords(
  buttons: DecisionButtons,
  appName: string | undefined,
  typedCode = true,
): DecisionButtonsWords {
  const app = appName ?? "the employee's app";
  if (buttons.available) {
    // The card reads the bridge's heartbeat, so it says what it knows (D-6 (b)); a request asked
    // before the token landed keeps its typed code alone (W12-R10).
    const live = `The Slack socket service last reported a live connection for ${app}, so each new request to you arrives with Approve and Reject buttons`;
    return {
      title: 'Decisions in Slack: buttons are on',
      note: typedCode
        ? `${live} and a typed code. Either one decides it, and the typed code still decides it if a button press does not get through.`
        : `${live}. Slack does not let you message ${app} yet, so no typed code reaches it: if a press does not get through, decide in day0.`,
      asksForToken: false,
      offersReplacement: true,
    };
  }
  // Where the requests reach the manager without buttons: the typed code, or day0 alone for an app
  // that takes no messages.
  const withoutButtons = typedCode
    ? 'requests reach you with a typed code only'
    : `requests reach you with no buttons, and with no typed code until ${app} takes messages: decide them in day0`;
  const typedOnly = (title: string, note: string): DecisionButtonsWords => ({
    title,
    note,
    asksForToken: false,
    offersReplacement: false,
  });
  switch (buttons.why) {
    case 'no-app-level-token':
      return {
        title: "Buttons: needs this app's socket token",
        note: `${
          typedCode
            ? 'Requests reach you with a typed code only.'
            : 'Requests reach you with no buttons and no typed code, so you decide them in day0.'
        } To add Approve and Reject buttons, someone who manages ${app} in Slack makes its app-level token, with the connections:write scope, and pastes it below. In the app's settings, if Socket Mode is on (apps Day0 created from v0.16.0), that is Basic Information, App-Level Tokens, Generate Token and Scopes; if it is off (apps created before), turning on Enable Socket Mode makes the token in the same dialog.`,
        asksForToken: true,
        offersReplacement: false,
      };
    case 'no-bridge':
      return typedOnly(
        'Buttons: needs the Slack socket service',
        buttons.tokenStored
          ? `The app-level token of ${app} is stored, but this deployment does not run the Slack socket service that carries a press, so ${withoutButtons}. Ask whoever runs this deployment to run ./setup.sh again; that starts the service.`
          : `This deployment does not run the Slack socket service that carries a press, so ${withoutButtons}. Ask whoever runs this deployment to run ./setup.sh again; that starts the service, and this card then asks for the app-level token of ${app}.`,
      );
    case 'bridge-down':
      return {
        title: 'Buttons: off until the Slack socket service connects',
        note: `The app-level token of ${app} is stored, but the Slack socket service that carries a press has not reported a live connection for it lately, so ${withoutButtons}. Buttons come back on new requests once the service reports one again. If they stay off, ask whoever runs this deployment to check the service: pnpm check:access says what is wrong in its socket row.`,
        asksForToken: false,
        // A token Slack refuses, or one of another app, keeps the connection from opening.
        offersReplacement: true,
      };
    case 'no-own-app':
      return typedOnly(
        'Decisions in Slack: typed codes only',
        'Buttons need the Slack app Day0 creates for this employee, and this card uses a different connection.',
      );
    case 'not-slack-api':
      return typedOnly(
        'Decisions in Slack: typed codes only',
        "This connection can only send plain messages; buttons need Slack's own API.",
      );
    default: {
      const unknown: never = buttons;
      throw new Error(`unhandled reason ${JSON.stringify(unknown)}`);
    }
  }
}

/** What a Slack card says when the manager's typed code cannot reach its app, and its one control. */
export interface TypedCodeWords {
  readonly title: string;
  readonly note: string;
  /** The control with which the manager says a person turned the messages tab on. */
  readonly confirm: string;
}

/**
 * Whether the manager's typed code reaches the employee's own Slack app (W12V-7): nothing while it
 * takes messages; otherwise that it does not, who opens its messages tab (Day0 at the card's next
 * check, Day0 again only when asked after Slack refused it, or only a person in Slack), the one
 * toggle by Slack's own words, and the control with which the manager says it is on.
 *
 * @param reach - Whether the typed code reaches the app, as `listForAgent` read it.
 */
export function typedCodeWords(reach: TypedCodeReach): TypedCodeWords | undefined {
  const toggle = `turns on App Home, “${MESSAGES_TAB_TOGGLE}”`;
  switch (reach.state) {
    case 'open':
      return undefined;
    case 'day0-opens':
      return {
        title: 'Typed code: off until this app takes messages',
        note: `Slack does not let you message ${reach.appName} yet, so no typed code reaches it. Day0 tries to open its messages tab at this card’s next check, or now if you press Check the connection. If it stays off, someone who manages ${reach.appName} in Slack ${toggle}, and you say so here.`,
        confirm: 'It is on in Slack',
      };
    case 'refused':
      return {
        title: 'Typed code: off until this app takes messages',
        note: `Slack would not let Day0 open the messages tab of ${reach.appName}, so no typed code reaches it. Slack’s answer: ${reach.reason.replace(/\.$/, '')}. Press Check the connection for Day0 to try again, or have someone who manages ${reach.appName} in Slack turn on App Home, “${MESSAGES_TAB_TOGGLE}”, and say so here.`,
        confirm: 'It is on in Slack',
      };
    case 'needs-toggle':
      return {
        title: 'Typed code: off until this app takes messages',
        note: `Slack does not let you message ${reach.appName} yet, so no typed code reaches it, and Day0 cannot change this app’s settings. Someone who manages ${reach.appName} in Slack ${toggle}; then say so here.`,
        confirm: 'It is on in Slack',
      };
    default: {
      const unknown: never = reach;
      throw new Error(`unhandled reach ${JSON.stringify(unknown)}`);
    }
  }
}
