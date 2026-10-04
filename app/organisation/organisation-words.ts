import type { FunctionReturnType } from 'convex/server';
import type { api } from '@convex/_generated/api';
import { formatStamp } from '@/lib/zone';
import type {
  OrganisationConnectionMode,
  OrganisationConnectionStatus,
} from '@/surfaces/access-identity';
import { systemDisplayName } from '@/surfaces/revokers/outcome';
import { recordWords } from '../agent/[agentId]/record/record-words';
import type { Tone } from '../components/tone';

/** One organisation connection as `organisationConnections.listForAdministrator` lists it. */
export type ConnectionView = FunctionReturnType<
  typeof api.organisationConnections.listForAdministrator
>[number];

/** One line of the organisation's ledger as `connectionEvents.forAdministrator` reads it. */
export type LedgerLine = FunctionReturnType<typeof api.connectionEvents.forAdministrator>[number];

/**
 * What the organisation page says to a signed-in person who is not one of its administrators
 * (B8): words, not an error, saying who manages the connections and that each employee's access
 * stays the manager's to approve. A product call, flagged.
 */
export const ORGANISATION_REFUSED = {
  title: "This page is for your organisation's administrators",
  lines: [
    'IT named the administrators when Day0 was installed. Ask one of them when a system needs connecting, a new secret or revoking.',
    "Each employee's access is still yours to approve, on its card.",
  ],
} as const;

/**
 * A connection's mode in words (D3, B11).
 *
 * @param mode - Whether each employee gets its own identity or all share the connection's.
 */
export function modeWords(mode: OrganisationConnectionMode): string {
  switch (mode) {
    case 'per-employee':
      return 'Each employee gets its own identity';
    case 'shared':
      return 'Every employee shares one identity; Day0 records who did what';
    default: {
      const unknown: never = mode;
      throw new Error(`unhandled connection mode ${String(unknown)}`);
    }
  }
}

/**
 * What IT registered, in words: Slack's configuration token, an OAuth app, a service account, an
 * MCP client by how its id was obtained (AC7), or a key.
 *
 * @param view - The connection.
 */
export function kindWords(view: Pick<ConnectionView, 'kind' | 'clientRegistration'>): string {
  switch (view.kind) {
    case 'slack-configuration':
      return "Slack configuration token, which creates each employee's app";
    case 'oauth-app':
      return 'OAuth app';
    case 'mcp-client':
      return view.clientRegistration === 'dynamic'
        ? 'MCP client, registered by Day0 with the server'
        : 'MCP client, registered by IT';
    case 'service-account':
      return 'Service account';
    case 'static-key':
      return 'API key';
    default: {
      const unknown: never = view.kind;
      throw new Error(`unhandled connection kind ${String(unknown)}`);
    }
  }
}

/** A connection's status chip: its words and its tone. */
export interface ConnectionChip {
  readonly text: string;
  readonly tone: Tone;
}

/**
 * The chip a connection carries for its status.
 *
 * @param status - In use, needing IT's attention, or revoked.
 */
export function connectionStatusChip(status: OrganisationConnectionStatus): ConnectionChip {
  switch (status) {
    case 'active':
      return { text: 'Active', tone: 'ok' };
    case 'needs-attention':
      return { text: 'Needs IT', tone: 'warn' };
    case 'revoked':
      return { text: 'Revoked', tone: 'muted' };
    default: {
      const unknown: never = status;
      throw new Error(`unhandled connection status ${String(unknown)}`);
    }
  }
}

/**
 * The line that names the zone every time on the organisation page is printed in: the viewer's
 * browser's, since the page belongs to no one employee's day (the wave 11 review's m23).
 *
 * @param zone - The zone the page's times are printed in.
 */
export function zoneLine(zone: string): string {
  return `Times on this page are in ${zone}, this browser's zone.`;
}

/**
 * Who registered a connection and when: an administrator by verified address on this page, or the
 * setup command, which names nobody (11-AO's `registeredBy`).
 *
 * @param registeredBy - The registration's registrar and time.
 * @param zone - The zone the time is named in.
 */
export function registeredWords(
  registeredBy: ConnectionView['registeredBy'],
  zone: string,
): string {
  const when = formatStamp(registeredBy.at, zone);
  return registeredBy.via === 'organisation-page' && registeredBy.address !== undefined
    ? `${registeredBy.address}, on this page, ${when}`
    : `The setup command, ${when}`;
}

/**
 * Whether the connection holds a secret and when the vendor dates it to expire: never the secret,
 * which never leaves the backend. A per-employee OAuth app holds none for the organisation.
 *
 * @param view - The connection.
 * @param zone - The zone the expiry is named in.
 */
export function secretWords(
  view: Pick<ConnectionView, 'hasSecret' | 'secretExpiresAt' | 'kind' | 'mode' | 'status'>,
  zone: string,
): string {
  if (view.hasSecret) {
    return view.secretExpiresAt === undefined
      ? 'Held encrypted'
      : `Held encrypted; it expires ${formatStamp(view.secretExpiresAt, zone)}`;
  }
  return view.kind === 'oauth-app' && view.mode === 'per-employee' && view.status !== 'revoked'
    ? "None for the organisation: each employee's own app holds its own"
    : 'None held';
}

/** How many employee cards a revoke ends, as `organisationConnections.cardsOn` counts them. */
export interface CardsOnConnection {
  readonly cards: number;
  /** More cards than one revoke ends, which the revoke refuses. */
  readonly atLeast: boolean;
}

/**
 * What revoking a connection does, said before the administrator confirms it (11-AO's `revoke`
 * with 11-AR's `endCardsOnConnection`): the cards on it end with the reason, by number once the
 * count is read (11-AC's item 3; no employee is named, B8) and as every card until then, what Day0
 * obtained through it is revoked at the vendor, and no card on another system changes.
 *
 * @param view - The connection.
 * @param counted - How many cards it ends, once `cardsOn` has answered.
 */
export function revokeLines(
  view: Pick<ConnectionView, 'displayName' | 'system' | 'kind'>,
  counted?: CardsOnConnection,
): string[] {
  const system = systemDisplayName(view.system);
  const revoked = `what Day0 obtained through it is revoked at ${system}.`;
  // More cards than one revoke ends: the revoke is refused, so nothing after the count happens.
  if (counted?.atLeast === true) return [endedCardsLine(view.displayName, revoked, counted)];
  return [
    endedCardsLine(view.displayName, revoked, counted),
    // Where the count says no card ends, no manager sees a reason (the round review's m17).
    revokeEndsNoCard(counted)
      ? 'No card on any other system changes.'
      : 'No card on any other system changes. Each manager sees the reason on the card.',
    // Slack's `auth.revoke` ends the configuration token alone (R41V-10, R41X-8).
    ...(view.kind === 'slack-configuration' ? [SLACK_REFRESH_TOKEN_LINE] : []),
    'IT can connect it again with ./setup.sh access.',
  ];
}

/**
 * Whether the count says a revoke ends no card, so no manager reads its reason on a card (the
 * round review's m17): none is connected through it, or more are than one revoke ends, which the
 * revoke refuses. Unknown until the count answers.
 *
 * @param counted - How many cards it ends, once `cardsOn` has answered.
 */
export function revokeEndsNoCard(counted: CardsOnConnection | undefined): boolean {
  return counted !== undefined && (counted.cards === 0 || counted.atLeast);
}

/**
 * What a revoke of Slack's configuration connection cannot do, said before it is confirmed: nothing
 * ends the configuration token's refresh token but its lapse. Day0's `auth.revoke` and the token
 * row's Delete on api.slack.com each end an access token only, and once no access token lives the
 * row is not listed at all (the re-walk, R41X-8), so what IT can do is keep closed the sign-in it
 * was copied from.
 */
export const SLACK_REFRESH_TOKEN_LINE =
  'Day0 revokes the configuration token at Slack, but nothing ends its refresh token, neither ' +
  'Day0 nor a Delete on api.slack.com: it ends only when it lapses. Until then whoever copied it ' +
  'while its row was listed under "Your App Configuration Tokens" can mint a new token with it, ' +
  'so keep the sign-in of the account that generated it closed.';

/** The revoke's first line: the cards it ends, by number once counted, then what is revoked. */
function endedCardsLine(
  displayName: string,
  revoked: string,
  counted: CardsOnConnection | undefined,
): string {
  if (counted === undefined) {
    return `Every employee's ${displayName} card connected through it ends now, each with your reason, and ${revoked}`;
  }
  if (counted.atLeast) {
    return `More than ${counted.cards} employee cards are connected through it, too many to end at once: Day0 refuses the revoke until some are removed.`;
  }
  if (counted.cards === 0) {
    return `No employee card is connected through it, so none ends; ${revoked}`;
  }
  return counted.cards === 1
    ? `One employee card connected through it ends now, with your reason, and ${revoked}`
    : `${counted.cards} employee cards connected through it end now, each with your reason, and ${revoked}`;
}

/**
 * What a rotation of Slack's configuration connection cannot do, said before the new secret is
 * given: Day0 revokes the old configuration token, whose refresh token nothing ends but its lapse
 * (R41X-8), as {@link SLACK_REFRESH_TOKEN_LINE} says for a revoke.
 */
export const SLACK_ROTATE_REFRESH_TOKEN_LINE =
  "Nothing ends that token's refresh token, neither Day0 nor a Delete on api.slack.com: it ends " +
  'only when it lapses. Until then whoever copied it while its row was listed can mint a new ' +
  'token with it, so keep the sign-in of the account that generated it closed.';

/**
 * What a rotation does, said before the administrator gives the new secret: for Slack's
 * configuration connection, that the old token's refresh token outlives the rotation (the round
 * review's m17).
 *
 * @param view - The connection.
 */
export function rotateNote(view: Pick<ConnectionView, 'kind'>): string {
  return view.kind === 'slack-configuration'
    ? `No card is affected. Day0 seals the new secret, switches to it and revokes the old configuration token. ${SLACK_ROTATE_REFRESH_TOKEN_LINE}`
    : 'No card is affected. Day0 seals the new secret, switches to it and revokes the old one.';
}

/**
 * One ledger line in the record's words (the contract's renderer, so the page and the audit
 * export say the same), with the administrator who made the change where one did.
 *
 * @param line - The ledger line.
 */
export function ledgerLineWords(line: LedgerLine): string {
  const said = recordWords({ type: line.type, payload: line.payload }, { name: 'An employee' });
  return line.actorAddress === undefined ? said : `${said} By ${line.actorAddress}.`;
}
