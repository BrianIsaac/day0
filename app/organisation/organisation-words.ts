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
  view: Pick<ConnectionView, 'displayName' | 'system'>,
  counted?: CardsOnConnection,
): string[] {
  const system = systemDisplayName(view.system);
  const revoked = `what Day0 obtained through it is revoked at ${system}.`;
  return [
    endedCardsLine(view.displayName, revoked, counted),
    'No card on any other system changes. Each manager sees the reason on the card.',
    'IT can connect it again with ./setup.sh access.',
  ];
}

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

/** What a rotation does, said before the administrator gives the new secret. */
export const ROTATE_NOTE =
  'No card is affected. Day0 seals the new secret, switches to it and revokes the old one.';

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
