import { SURFACE_ACCESS_DEFAULT_DAYS } from './access';
import type {
  AccessRequestReason,
  OrganisationConnectionKind,
  OrganisationConnectionMode,
} from './access-identity';
import { SLACK_KIT_BOT_SCOPES } from './access-kit/slack';
import { isSlackApiEndpoint } from './slack-endpoint';

/*
 * The access request (the access plan, section 4.5; A24) and the rule it starts from: which of
 * the organisation's systems a card needs. Pure, so the card, the manager's DM and the export
 * build the same words from the same row, and so the deployment's guards (the pasted-key refusal,
 * the connection's system key) read a card's system one way.
 */

/** A plain system key: lower-case words joined by hyphens (`slack`, `google-workspace`). */
const PLAIN_SYSTEM_KEY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** The prefix of an MCP server's system key, followed by the server's host and any port. */
export const MCP_SYSTEM_PREFIX = 'mcp:';

/** One DNS host name, lower-case: what follows the MCP prefix. */
const HOST_NAME =
  /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** A port as a URL writes it: digits with no leading zero. */
const PORT = /^[1-9][0-9]{0,4}$/;

/** The largest TCP port. */
const PORT_MAX = 65_535;

/** The port an https address names when it names none, which a URL never writes out. */
const HTTPS_DEFAULT_PORT = '443';

/**
 * The system key of the MCP server at an endpoint: `mcp:`, the host in lower case without a
 * trailing dot, and the port when it is not the scheme's default. Two MCP servers on one host
 * are two systems, so a non-default port is part of the key; the default port names the same
 * server as no port, so it never is. The one rule the cards, the organisation's connections, the
 * MCP client and the access kit key a server by.
 *
 * @param endpoint - The MCP server's address.
 */
export function mcpSystemKey(endpoint: URL): string {
  const host = endpoint.hostname.toLowerCase().replace(/\.$/, '');
  return `${MCP_SYSTEM_PREFIX}${host}${endpoint.port === '' ? '' : `:${endpoint.port}`}`;
}

/** Whether what follows the MCP prefix is a host, with a port only where {@link mcpSystemKey} writes one. */
function isMcpServer(server: string): boolean {
  const colon = server.lastIndexOf(':');
  if (colon === -1) return HOST_NAME.test(server);
  const port = server.slice(colon + 1);
  return (
    HOST_NAME.test(server.slice(0, colon)) &&
    PORT.test(port) &&
    Number(port) <= PORT_MAX &&
    port !== HTTPS_DEFAULT_PORT
  );
}

/**
 * Whether a value is an organisation system key: a plain lower-case key (`slack`, `linear`,
 * `github`, ...) or `mcp:<host>` (with `:<port>` for a non-default port) for a generic MCP
 * server (the access plan, section 4.1), as {@link mcpSystemKey} writes it.
 *
 * @param value - The key as given.
 */
export function isOrganisationSystemKey(value: string): boolean {
  if (value.startsWith(MCP_SYSTEM_PREFIX)) {
    return isMcpServer(value.slice(MCP_SYSTEM_PREFIX.length));
  }
  return PLAIN_SYSTEM_KEY.test(value);
}

/**
 * The systems the access kit knows by an API host, each with the hosts that name it: the host
 * itself or any subdomain of it. Slack is read off its Web API base (`isSlackApiEndpoint`),
 * never off a host alone, as everywhere else Slack is recognised.
 */
const SYSTEM_HOSTS: ReadonlyArray<{ readonly system: string; readonly hosts: readonly string[] }> =
  [
    { system: 'linear', hosts: ['linear.app'] },
    { system: 'github', hosts: ['github.com'] },
    { system: 'atlassian', hosts: ['atlassian.net', 'atlassian.com'] },
    { system: 'notion', hosts: ['notion.com'] },
    { system: 'microsoft', hosts: ['graph.microsoft.com'] },
    { system: 'google', hosts: ['googleapis.com'] },
  ];

/** The parts of a card the system rule reads. */
export interface SystemCard {
  readonly endpoint?: string;
  readonly path?: string;
}

/** Whether a host is a domain or one of its subdomains. */
function hostWithin(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/**
 * The organisation system a card needs, read off its endpoint: Slack's Web API base, a host the
 * access kit knows, and on the MCP rung any other server by {@link mcpSystemKey}. A card with no endpoint, or
 * one on a host nobody registers for the organisation, needs no organisation system, and keeps
 * the paths it has today.
 *
 * @param card - The card's endpoint and rung.
 * @returns The system key, or undefined when the card needs none.
 */
export function organisationSystemOf(card: SystemCard): string | undefined {
  if (card.endpoint === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(card.endpoint);
  } catch {
    // Not an address: a card orientation could not place names no system.
    return undefined;
  }
  // A fully qualified host's trailing dot names the same host, Slack's API base's included.
  url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
  if (isSlackApiEndpoint(url.href)) return 'slack';
  if (url.protocol !== 'https:') return undefined;
  const host = url.hostname;
  const known = SYSTEM_HOSTS.find((entry) =>
    entry.hosts.some((domain: string): boolean => hostWithin(host, domain)),
  );
  if (known !== undefined) return known.system;
  if (card.path === 'mcp' && HOST_NAME.test(host)) return mcpSystemKey(url);
  return undefined;
}

/** The connection kind an issuer of Day0's acts through, by the named system it serves. */
const ISSUER_KINDS: Readonly<Record<string, OrganisationConnectionKind>> = {
  slack: 'slack-configuration',
  linear: 'oauth-app',
};

/**
 * The kind an issuer of Day0's acts through for a system, or undefined where none serves it.
 *
 * @param system - The system key (`organisationSystemOf`).
 */
export function issuerKindFor(system: string): OrganisationConnectionKind | undefined {
  return system.startsWith(MCP_SYSTEM_PREFIX) ? 'mcp-client' : ISSUER_KINDS[system];
}

/**
 * Whether an issuer of Day0's serves a system at all: Slack's own apps, Linear's app, and an MCP
 * server's client. A card on any other system asks IT for nothing and takes a key of its own
 * (11-AC's item 8: a product call, flagged).
 *
 * @param system - The system key (`organisationSystemOf`).
 */
export function issuerServesSystem(system: string): boolean {
  return issuerKindFor(system) !== undefined;
}

/**
 * Whether an issuer of Day0's acts through an organisation connection, so the connection covers
 * the cards of its system: its kind is the one the issuer for its system acts through (Slack's
 * configuration token, Linear's OAuth app, an MCP server's client). A static key or a service
 * account landed for any system is recorded and acted through by nothing, so it covers no card and
 * the card takes a key of its own (decision D6 (b), a product call, flagged; the round review's
 * m11).
 *
 * @param connection - The connection's system and kind.
 */
export function servedByIssuer(
  connection: Readonly<{ system: string; kind: OrganisationConnectionKind }>,
): boolean {
  const kind = issuerKindFor(connection.system);
  return kind !== undefined && kind === connection.kind;
}

/**
 * Why a card refuses a pasted credential: its system has an active organisation connection, so
 * the card's credential comes from that connection, never from a paste (the access plan,
 * section 4.1). Says nothing of the value.
 *
 * @param displayName - The system's name as the connection shows it.
 */
export function organisationConnectedRefusal(displayName: string): string {
  return `${displayName} is connected for your organisation by IT, so this card connects through that connection, never a pasted key. Nothing was stored.`;
}

/** The parts of a card the access request reads, the system rule's among them. */
export interface AccessRequestCard extends SystemCard {
  readonly slug: string;
  readonly displayName: string;
  readonly managerApprovedAt?: number;
  /** The credential the card holds: a card holding one, a pasted key's included, needs no request (A27). */
  readonly credentialId?: string;
  readonly expiresAt?: number;
  /** The card's proposal, whose `scopeRequested` names the scopes it was approved for. */
  readonly request?: unknown;
  readonly discoveryEvidence?: ReadonlyArray<{ readonly quote: string; readonly current: boolean }>;
  /**
   * The employee's own app, once Day0 created it (Slack) or an administrator recorded it (Linear):
   * its client id, and the install link IT follows.
   */
  readonly provisioning?: {
    readonly clientId?: string;
    readonly installUrl?: string;
    /** When the employee's own app was installed: an ended card reinstalls it from its own row. */
    readonly installedAt?: number;
  };
}

/** The parts of an organisation connection the access request reads. */
export interface AccessRequestConnection {
  readonly system: string;
  readonly displayName: string;
  readonly kind: OrganisationConnectionKind;
  readonly mode: OrganisationConnectionMode;
  readonly scopes: readonly string[];
}

/**
 * Why an approved card asks IT for access instead of offering Connect, or undefined when it does
 * not (the access plan, section 4.5; A24): its system has no active organisation connection; the
 * connection is per employee and an administrator must install the employee's app (Linear's app
 * per employee until an administrator records it, L1, after which Connect starts its installation
 * with a fresh link; Slack's only when the install link the workspace holds for approval waits on
 * IT, since Day0 creates Slack's app itself); or the card needs scopes the registration does not
 * hold, when the caller knows the vendor scopes it needs. An MCP card on its server's client is
 * authorised by its manager's own consent (AM6), so it never asks once the server is connected. A
 * card not yet approved, one holding a credential (a pasted key keeps working to expiry, A27),
 * and one on no organisation system never ask.
 *
 * @param card - The card.
 * @param connection - The system's active organisation connection, or null.
 * @param neededScopes - The vendor scopes the card needs, when its connect path knows them.
 */
export function accessRequestReason(
  card: AccessRequestCard,
  connection: AccessRequestConnection | null,
  neededScopes?: readonly string[],
): AccessRequestReason | undefined {
  const system = organisationSystemOf(card);
  if (system === undefined) return undefined;
  if (card.managerApprovedAt === undefined || card.credentialId !== undefined) return undefined;
  // A system no issuer acts through asks IT for nothing, connected or not: the card takes a key.
  if (!issuerServesSystem(system)) return undefined;
  if (connection === null) return 'no-connection';
  // A connection no issuer acts through (a static key IT landed for Linear) covers nothing, and
  // the card takes a key of its own rather than asking IT for an install it cannot use (D6).
  if (!servedByIssuer(connection)) return undefined;
  if (neededScopes?.some((scope: string): boolean => !connection.scopes.includes(scope))) {
    return 'scope-widening';
  }
  if (connection.mode === 'shared') return undefined;
  switch (connection.kind) {
    case 'slack-configuration':
      // An app installed once is installed again from the card's own reinstall row, which an
      // administrator approves in Slack: one way on, not two (11-AC's cockpit item 9).
      return card.provisioning?.installUrl === undefined ||
        card.provisioning.installedAt !== undefined
        ? undefined
        : 'install-needed';
    case 'oauth-app':
      return card.provisioning?.clientId === undefined ? 'install-needed' : undefined;
    case 'mcp-client':
      return undefined;
    case 'service-account':
    case 'static-key':
      return 'install-needed';
    default: {
      const unknown: never = connection.kind;
      throw new Error(`unhandled organisation connection kind ${String(unknown)}`);
    }
  }
}

/** A card whose request is drafted: its id, which the organisation page's link names (M4). */
export interface DraftedAccessRequestCard extends AccessRequestCard {
  readonly _id: string;
}

/** Everything the request's words are built from. */
export interface AccessRequestInput {
  readonly card: DraftedAccessRequestCard;
  readonly connection: AccessRequestConnection | null;
  readonly reason: AccessRequestReason;
  /** The scopes to ask for; the card's approved scopes when not given (a widening names its own). */
  readonly scopes?: readonly string[];
  readonly employeeName: string;
  /** The employee's zone, which the access end date is named in. */
  readonly zone: string;
  /** The app's public origin, for the organisation page's address, when the deployment has one. */
  readonly publicUrl?: string;
  /** Whether IT revoked the system's connection and none is active since. */
  readonly connectionRevoked?: boolean;
}

/** The access request as the card shows it, the manager's DM carries it and the export records it. */
export interface AccessRequestDraft {
  readonly system: string;
  readonly reason: AccessRequestReason;
  readonly scopes: readonly string[];
  readonly subject: string;
  readonly text: string;
  /** `mailto:` with the subject and the text filled, for "Email it": the product sends no email. */
  readonly mailto: string;
}

/** The most documentation quotes the request carries. */
const QUOTES_MAX = 3;

/** The longest one quote may be in the request. */
const QUOTE_MAX = 200;

/** The scopes a card was approved for, from its proposal, or its slug's read and write. */
function approvedScopes(card: AccessRequestCard): readonly string[] {
  const requested =
    card.request !== null && typeof card.request === 'object'
      ? (card.request as { readonly scopeRequested?: unknown }).scopeRequested
      : undefined;
  const scopes = Array.isArray(requested)
    ? requested.filter((scope): scope is string => typeof scope === 'string' && scope !== '')
    : [];
  return scopes.length > 0 ? scopes : [`${card.slug}:read`, `${card.slug}:write`];
}

/** A Slack OAuth scope's shape, `channels:read` or `users:read.email`: a method name has no colon. */
const SLACK_SCOPE = /^[a-z][a-z_.]*:[a-z][a-z_.]*$/;

/**
 * The scopes an employee's own Slack app holds (W13V-5): the Slack scopes the card was approved
 * for, as a manifest on the page names them, then the kit's it lacks, as the issuer unions them
 * (W13V-2). The page's method names a card without a manifest proposes, and the `<slug>:read`
 * placeholders orientation writes with no scope found, are not scopes and are left out.
 */
function slackAppScopes(card: AccessRequestCard): string[] {
  const placeholders = new Set([`${card.slug}:read`, `${card.slug}:write`]);
  const own = approvedScopes(card).filter(
    (scope) => SLACK_SCOPE.test(scope) && !placeholders.has(scope),
  );
  return [...own, ...SLACK_KIT_BOT_SCOPES.filter((scope) => !own.includes(scope))];
}

/**
 * The scopes a card asks for, as its access request names them and its card lists them (W13V-5):
 * on a Slack card, the scopes of the employee's own app (`slackAppScopes`), never the page's method
 * names; on any other system, the scopes it was proposed with.
 *
 * @param card - The card, with its proposal.
 */
export function scopesRequestedOf(card: AccessRequestCard): string[] {
  return organisationSystemOf(card) === 'slack' ? slackAppScopes(card) : [...approvedScopes(card)];
}

/** Why the card asks, in IT's words: a connection IT revoked is said as revoked, never as not yet made. */
function reasonLine(
  reason: AccessRequestReason,
  system: string,
  employee: string,
  connectionRevoked: boolean,
): string {
  switch (reason) {
    case 'no-connection':
      return connectionRevoked
        ? `The organisation’s ${system} connection was revoked: an administrator connects it again, and every employee’s card then uses that connection.`
        : `${system} is not connected for the organisation yet: an administrator connects it once, and every employee’s card then uses that connection.`;
    case 'install-needed':
      return `${system} is connected for each employee, and ${employee}’s own app needs an administrator to install it.`;
    case 'scope-widening':
      return `${employee}’s card needs scopes ${system}’s connection does not hold yet.`;
    default: {
      const unknown: never = reason;
      throw new Error(`unhandled access request reason ${String(unknown)}`);
    }
  }
}

/** The documentation's current quotes for the card, clipped, or nothing when it has none. */
function evidenceLine(card: AccessRequestCard, employee: string): string | undefined {
  const quotes = (card.discoveryEvidence ?? [])
    .filter((evidence) => evidence.current && evidence.quote.trim() !== '')
    .slice(0, QUOTES_MAX)
    .map((evidence) => {
      const quote = evidence.quote.trim();
      return `“${quote.length > QUOTE_MAX ? `${quote.slice(0, QUOTE_MAX - 3)}...` : quote}”`;
    });
  return quotes.length === 0
    ? undefined
    : `Why ${employee} needs it, from the team’s documentation: ${quotes.join('; ')}.`;
}

/**
 * How long the access is for: the card's end date as a person reads a date ("31 December 2026",
 * in the employee's zone; the cockpit's kit item), or the approval's default length.
 */
function lengthLine(card: AccessRequestCard, zone: string): string {
  if (card.expiresAt === undefined) {
    return `For how long: ${SURFACE_ACCESS_DEFAULT_DAYS} days from approval, renewed by the manager.`;
  }
  const until = new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: zone,
  }).format(card.expiresAt);
  return `For how long: until ${until}.`;
}

/**
 * What IT does (the wave 11 review's M4): the install link when the employee's app waits on it;
 * for an employee's own OAuth app no administrator has recorded yet, the organisation page's link
 * that names the card, where the app is recorded; for a system already connected, the kit's recipe
 * and the organisation page, never the setup verb, which IT has already run; else the setup verb
 * that connects the system, or the organisation page.
 */
function howLine(input: AccessRequestInput, system: string, name: string): string {
  const installUrl = input.card.provisioning?.installUrl;
  if (input.reason === 'install-needed' && installUrl !== undefined) {
    return `How to connect it: install it here: ${installUrl}`;
  }
  const recipe = `docs/running/access-${system.startsWith(MCP_SYSTEM_PREFIX) ? 'mcp' : system}.md`;
  const origin = input.publicUrl?.trim().replace(/\/+$/, '') ?? '';
  if (input.reason === 'install-needed' && input.connection?.kind === 'oauth-app') {
    const page = `${origin}/organisation?card=${encodeURIComponent(input.card._id)}`;
    return `How to connect it: a ${name} administrator creates ${input.employeeName}’s own app as ${recipe} says and records it on the organisation page, which then opens ${name} to install it: ${page}`;
  }
  if (input.connection !== null) {
    const page = origin ? `, on the organisation page at ${origin}/organisation` : '';
    return `How to connect it: an administrator follows ${recipe}${page}.`;
  }
  const page = origin ? `, or uses the organisation page at ${origin}/organisation` : '';
  return `How to connect it: an administrator runs ./setup.sh access for ${system}, following ${recipe}${page}.`;
}

/**
 * For an employee's own Slack app, the person's step that turns on decision buttons (wave 12,
 * 12-M; RM3 (a)): Slack issues no app-level token by API (K2), so the request names it. It never
 * says the typed code always works, which an app that takes no messages refuses (W12V-7). Nothing
 * for any other system.
 */
function buttonsLine(system: string, employee: string): string | undefined {
  if (system !== 'slack') return undefined;
  return `For Approve and Reject buttons in the manager’s decision requests (optional; without them the manager decides each request in day0, or by its typed code where the app takes messages): a collaborator on ${employee}’s app generates an app-level token with the connections:write scope, as docs/running/access-slack.md says, and the manager pastes it on ${employee}’s Slack card.`;
}

/**
 * The access request's words (the access plan, section 4.5): what system, which scopes and why
 * (the documentation quotes the card carries), for how long, and how IT connects it; the same on
 * the card, in the manager's DM and in the export, since all three build them here from the same
 * row. Who asks is the manager who sends it, from their own account in every delivery (Copy,
 * Email, their DM); the words carry no address, which the export's policy would redact and so
 * make its words differ. A request, never a grant: nothing changes until IT acts.
 *
 * @param input - The card, its system's connection, why it asks, and who asks.
 * @throws Error when the card is on no organisation system, which never asks.
 */
export function draftAccessRequest(input: AccessRequestInput): AccessRequestDraft {
  const system = organisationSystemOf(input.card);
  if (system === undefined)
    throw new Error('A card on no organisation system asks IT for nothing.');
  const name = input.connection?.displayName ?? input.card.displayName;
  const employee = input.employeeName;
  const scopes = [...(input.scopes ?? scopesRequestedOf(input.card))];
  const subject = `Day0 access request: ${name} for ${employee}`;
  const lines = [
    `${employee}, a Day0 employee, needs access to ${name}; ${employee}’s manager approved it and asks IT to connect it.`,
    reasonLine(input.reason, name, employee, input.connectionRevoked === true),
    `Access needed: ${scopes.join(', ')}.`,
    evidenceLine(input.card, employee),
    lengthLine(input.card, input.zone),
    howLine(input, system, name),
    buttonsLine(system, employee),
    `Nothing changes until IT connects it; then Connect appears on ${employee}’s card.`,
  ].filter((line): line is string => line !== undefined);
  const text = lines.join('\n');
  return {
    system,
    reason: input.reason,
    scopes,
    subject,
    text,
    mailto: accessRequestMailto(subject, text),
  };
}

/**
 * The `mailto:` link "Email it" opens, with the subject and the words filled: the product sends
 * no email (the enhancements plan's G3), the manager's own mail client does.
 *
 * @param subject - The request's subject line.
 * @param text - The request's words.
 */
export function accessRequestMailto(subject: string, text: string): string {
  return `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
}
