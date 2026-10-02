import type { Doc } from '@convex/_generated/dataModel';
import type { SurfacePath } from '@/surfaces/types';
import type { ActsAsKind, OrganisationConnectionMode } from '@/surfaces/access-identity';
import { MCP_SYSTEM_PREFIX, organisationSystemOf } from '@/surfaces/access-request';
import { isSlackApiEndpoint } from '@/surfaces/slack-endpoint';
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
 * card whose access request is out, or the manager's Connect, for a card IT's connection covers.
 *
 * @param surface - The card's row.
 * @param now - The instant to judge the access against.
 * @param options - What an approved card with nothing landed waits on, when not a paste.
 */
export function stateChip(
  surface: WordedSurface,
  now: number,
  zone: string | undefined,
  options: { readonly waitsOn?: 'it' | 'connect' } = {},
): StateChipWords {
  const access = accessStanding(surface, now, zone);
  if (access.kind === 'ended') return { text: 'Access ended', tone: 'warn' };
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
  readonly mode: OrganisationConnectionMode;
  readonly status: 'active' | 'needs-attention';
  readonly connectedAt: number;
}

/**
 * Whom a card acts as in its system (D2): the identity the connect path wrote, or, before one has
 * landed, the one it will land, so the manager approves knowing which (the access plan, section
 * 4.3). `planned` says which of the two it is; `label` is the identity's name as the system shows
 * it, known only once it has landed.
 */
export interface CardIdentity {
  readonly kind: ActsAsKind;
  readonly label?: string;
  readonly planned: boolean;
}

/** What the identity is read from: the card's identity once written, its endpoint and path. */
export type IdentityCard = Partial<
  Pick<Doc<'surfaces'>, 'actsAs' | 'endpoint' | 'path' | 'credentialId'>
>;

/**
 * Whom a card acts as, or will once connected. An identity a connect path wrote is read as it is.
 * Before one has, the card's system and the organisation's active connection for it decide, by the
 * issuers' own rules: an MCP server's authorisation is the manager's delegated consent (AM6); a
 * shared connection is the organisation's one app (11-AL's shared app actor); a per-employee one
 * is the employee's own app (11-AS, 11-AL). With no active connection, a Slack card that registers
 * its own app acts as it, and any other card as the key someone pastes, which is what
 * `landCredential` writes (`actsAsAtUpgrade`). A connection that needs IT's attention covers
 * nothing: `landCredential` refuses only while one is active.
 *
 * @param card - The card's identity, endpoint and path.
 * @param connection - The organisation's connection for the card's system, when it has one.
 * @param options - Whether, with no connection, the card registers the employee's own app itself.
 */
export function cardIdentity(
  card: IdentityCard,
  connection: OrganisationSystem | undefined,
  options: { readonly selfProvisions: boolean },
): CardIdentity {
  // A Disconnect leaves a pasted key's identity on the card with no key held: it acts as nothing
  // pasted any more, so the card says whom it will act as instead.
  const keyGone = card.actsAs?.kind === 'shared-key' && card.credentialId === undefined;
  if (card.actsAs !== undefined && !keyGone) {
    return { kind: card.actsAs.kind, label: card.actsAs.label, planned: false };
  }
  const system = organisationSystemOf(card);
  const covering =
    connection !== undefined && connection.status === 'active' && connection.system === system
      ? connection
      : undefined;
  if (covering === undefined) {
    return { kind: options.selfProvisions ? 'own-app' : 'shared-key', planned: true };
  }
  if (covering.system.startsWith(MCP_SYSTEM_PREFIX)) return { kind: 'delegated', planned: true };
  return { kind: covering.mode === 'shared' ? 'shared-app' : 'own-app', planned: true };
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
    case 'shared-key':
      return `a key someone ${identity.planned ? 'pastes here' : 'pasted'}; its writes show that key's owner, and Day0 adds ${employee}'s name to each`;
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
 * grant, a pasted key), as the card draws one for a governance finding (the access plan, section
 * 4.3), or nothing for the employee's own identity and the organisation's shared app.
 *
 * @param kind - Whom the card acts as.
 */
export function identityChip(kind: ActsAsKind): string | undefined {
  switch (kind) {
    case 'delegated':
      return 'Delegated';
    case 'shared-key':
      return 'Pasted key';
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
 * The hosted office's "Acts as" words, the same on every mock surface: in mock mode nothing
 * leaves the office, and the employee is the office's own app in each of its systems.
 *
 * @param employee - The employee's name.
 */
export function mockActsAsWords(employee: string): string {
  return `${employee}, its own app in this office`;
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
 * The manager's read-only line for a system IT connected for the organisation: "Connected for
 * your organisation by IT on 1 October" (the wave file's draft; a product call, flagged).
 *
 * @param connection - The organisation's connection for the card's system.
 * @param zone - The zone the day is named in.
 */
export function connectedForOrganisationWords(
  connection: Pick<OrganisationSystem, 'connectedAt'>,
  zone: string,
): string {
  return `Connected for your organisation by IT on ${calendarDay(connection.connectedAt, zone)}`;
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
        `The key someone pasted is left as it is at ${system}: Day0 stops using it and never revokes a pasted key, and it stays in your stored credentials. Revoke it there if it should end.`,
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

/**
 * The move off a pasted key a card offers at its renewal once IT has connected its system (A27;
 * the access plan, section 8 step 8): whom it would act as instead, and that the key keeps working
 * until the manager moves it. A product call, flagged.
 *
 * @param target - Whom the card would act as through the organisation's connection.
 * @param names - The employee's name and the system's.
 */
export function moveOfferWords(target: CardIdentity, names: IdentityNames): string {
  const instead =
    target.kind === 'delegated'
      ? 'act as you there'
      : target.kind === 'shared-app'
        ? 'use the Day0 app your employees share'
        : `use its own ${names.system} app`;
  return `IT has connected ${names.system}. ${names.employee} can ${instead} instead of the pasted key, which keeps working until you move it.`;
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
