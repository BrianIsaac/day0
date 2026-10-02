import type { ActsAs, ActsAsKind, OrganisationConnectionMode } from './access-identity';
import { MCP_SYSTEM_PREFIX, organisationSystemOf } from './access-request';
import {
  presentProvisioning,
  type CredentialOwnerSummary,
  type SurfaceCredentialFinding,
  type SurfaceProvisioning,
} from './credential-presentation';

/*
 * Whom a card acts as in its system (D2; the access plan, section 4.3), the one rule (11-AC's
 * cockpit item 1): `surfaces.listForAgent` answers it on every row and the card reads it, so the
 * issuers' rules are applied in one place and the card never re-derives them.
 */

/**
 * Where a key a card holds came from: a documentation page the orientation read (B1, decision
 * 1 (a): bound where no organisation connection covers the system), or a paste on the card.
 */
export type KeyOrigin = 'documentation' | 'paste';

/**
 * Whom a card acts as in its system: the identity a connect path wrote, or, before one has landed,
 * the one it will land, so the manager approves knowing which (the access plan, section 4.3).
 * `planned` says which of the two it is; `label` is the identity's name as the system shows it,
 * known only once it has landed; `keyFrom` says where a shared key the card holds came from.
 */
export interface CardIdentity {
  readonly kind: ActsAsKind;
  readonly label?: string;
  readonly planned: boolean;
  readonly keyFrom?: KeyOrigin;
}

/** What the identity is read from: the identity a connect path wrote, the endpoint and path. */
export interface IdentityCard {
  readonly actsAs?: ActsAs;
  readonly endpoint?: string;
  readonly path?: string;
  readonly credentialId?: string;
}

/** The organisation's connection for a card's system, as the identity reads it. */
export interface IdentityConnection {
  /** The system's key, as `organisationSystemOf` reads it off a card. */
  readonly system: string;
  readonly mode: OrganisationConnectionMode;
  readonly status: 'active' | 'needs-attention' | 'revoked';
}

/**
 * Whom a card acts as, or will once connected. An identity a connect path wrote is read as it is
 * while the card holds a credential; a card that holds none names no landed identity (the wave 11
 * review's M8: an end, a revoke or a handover's cut takes the credential and leaves `actsAs`), and
 * says whom it will act as instead. Before one has landed, the card's system and the
 * organisation's active connection for it decide, by the issuers' own rules: an MCP server's
 * authorisation is the manager's delegated consent (AM6); a shared connection is the
 * organisation's one app (11-AL's shared app actor); a per-employee one is the employee's own app
 * (11-AS, 11-AL). With no active connection, a Slack card that registers its own app acts as it,
 * and any other card as the key someone pastes, which is what `landCredential` writes
 * (`actsAsAtUpgrade`). A connection that needs IT's attention covers nothing: `landCredential`
 * refuses only while one is active.
 *
 * @param card - The card's identity, endpoint and path, and the credential it holds.
 * @param connection - The organisation's connection for the card's system, when it has one.
 * @param options - Whether, with no connection, the card registers the employee's own app itself,
 *   and where the key it holds came from, when it holds one.
 */
export function cardIdentity(
  card: IdentityCard,
  connection: IdentityConnection | undefined,
  options: { readonly selfProvisions: boolean; readonly heldKeyFrom?: KeyOrigin },
): CardIdentity {
  if (card.actsAs !== undefined && card.credentialId !== undefined) {
    const landed = { kind: card.actsAs.kind, label: card.actsAs.label, planned: false };
    return card.actsAs.kind === 'shared-key' && options.heldKeyFrom !== undefined
      ? { ...landed, keyFrom: options.heldKeyFrom }
      : landed;
  }
  const covering = coveringConnection(card, connection);
  if (covering === undefined) {
    return { kind: options.selfProvisions ? 'own-app' : 'shared-key', planned: true };
  }
  if (covering.system.startsWith(MCP_SYSTEM_PREFIX)) return { kind: 'delegated', planned: true };
  return { kind: covering.mode === 'shared' ? 'shared-app' : 'own-app', planned: true };
}

/** The connection when it is active and for the card's own system, else undefined. */
function coveringConnection(
  card: IdentityCard,
  connection: IdentityConnection | undefined,
): IdentityConnection | undefined {
  return connection !== undefined &&
    connection.status === 'active' &&
    connection.system === organisationSystemOf(card)
    ? connection
    : undefined;
}

/**
 * Where a stored key came from, by its row's `source`: a documentation page, or a field the
 * manager typed into; a token an install obtained is no key either way.
 *
 * @param source - The credential row's `source`.
 */
export function keyOriginOf(source: CredentialOwnerSummary['source']): KeyOrigin | undefined {
  if (typeof source === 'object') return 'documentation';
  return source === 'entered' ? 'paste' : undefined;
}

/** What a listed card's identity is read from beside the card itself. */
export interface ListedIdentityInput {
  /** The card: its identity, endpoint, path, credential, proposal and app registration. */
  readonly card: IdentityCard & {
    readonly request?: unknown;
    readonly provisioning?: SurfaceProvisioning;
  };
  /** The organisation's active connection for the card's system, when it has one. */
  readonly connection?: IdentityConnection;
  /** The `source` of the credential the card holds, when it holds one. */
  readonly heldCredentialSource?: CredentialOwnerSummary['source'];
  /** Whether the deployment has a public address for a dedicated app's install to return to. */
  readonly hasPublicUrl: boolean;
}

/** Whom a listed card acts as, and whom IT's connection would make it act as instead. */
export interface ListedIdentity {
  readonly identity: CardIdentity;
  /**
   * Whom the card would act as through the organisation's active connection for its system, when
   * one covers it: the target of the move off a pasted or documented key (A27).
   */
  readonly connectionIdentity?: CardIdentity;
}

/**
 * Whom a listed card acts as (cockpit item 1), and whom IT's connection would make it act as: the
 * identity {@link cardIdentity} gives, with a Slack card's own app counted as its own registration
 * where the card can make one (the provisioning row's stage), and the key's origin read off the
 * credential it holds.
 *
 * @param input - The card, its system's active connection, its credential's source, and the
 *   deployment's public address.
 */
export function listedCardIdentity(input: ListedIdentityInput): ListedIdentity {
  const { card } = input;
  const covering = coveringConnection(card, input.connection);
  const slack = organisationSystemOf(card) === 'slack';
  const request =
    card.request !== null && typeof card.request === 'object'
      ? (card.request as { readonly credential?: SurfaceCredentialFinding })
      : undefined;
  const stage = slack
    ? presentProvisioning({
        credential: request?.credential,
        hasPublicUrl: input.hasPublicUrl,
        provisioning: card.provisioning,
        organisationConnected: covering !== undefined,
        credentialHeld: card.credentialId !== undefined,
      }).stage
    : 'not-applicable';
  const heldKeyFrom =
    input.heldCredentialSource === undefined ? undefined : keyOriginOf(input.heldCredentialSource);
  const identity = cardIdentity(card, input.connection, {
    selfProvisions: slack && stage !== 'not-applicable' && stage !== 'unavailable',
    ...(heldKeyFrom !== undefined ? { heldKeyFrom } : {}),
  });
  return covering === undefined
    ? { identity }
    : {
        identity,
        connectionIdentity: cardIdentity({ endpoint: card.endpoint, path: card.path }, covering, {
          selfProvisions: false,
        }),
      };
}
