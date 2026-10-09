import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import {
  MANAGER_TRANSFER_STATES,
  TRANSFER_ROW_CANCEL_REASONS,
} from '../src/agent/manager-transfer';
import { ORGANISATION_HOLDER } from '../src/lib/organisation-key';
import {
  ACCESS_ENDS,
  ACCESS_REQUEST_REASONS,
  ACTS_AS_KINDS,
  CREDENTIAL_GRANTS,
  MCP_CLIENT_REGISTRATIONS,
  ORGANISATION_CONNECTION_KINDS,
  ORGANISATION_CONNECTION_MODES,
  ORGANISATION_CONNECTION_STATUSES,
  ORGANISATION_REGISTRARS,
  SOURCE_REVOCATION_STATES,
  TOKEN_STORES,
} from '../src/surfaces/access-identity';
import { MESSAGES_TAB_OPEN_HOWS } from '../src/surfaces/slack-messages-tab-hows';
import { BLOCK_KINDS } from '../src/docs/blocks';
import {
  DEFAULT_PAGE_STATUSES,
  PAGE_STATUSES,
  RELATION_KINDS,
  RELATION_STATUSES,
  SOURCE_AUTHORITIES,
  STATUS_SOURCES,
} from '../src/docs/authority';
import {
  IDENTITY_PROVIDERS,
  PEOPLE_SOURCES,
  PERSON_STATUSES,
  RELATIONSHIP_STATUSES,
  RELATIONSHIP_TYPES,
} from '../src/people/vocabulary';
import {
  AGREEMENT_APPROVED_VIA,
  AGREEMENT_KINDS,
  AGREEMENT_KEEP_REFUSAL_REASONS,
  AGREEMENT_REFUSAL_REASONS,
  AGREEMENT_SCOPES,
  AGREEMENT_SOURCE_TYPES,
  AGREEMENT_STATUSES,
} from '../src/work/agreement-vocabulary';

/** A documentation page's status (wave 15, 15-K): `PAGE_STATUSES`. */
const pageStatus = v.union(...PAGE_STATUSES.map((status) => v.literal(status)));

/** How far a documentation source or page is trusted (wave 15, 15-K): `SOURCE_AUTHORITIES`. */
const sourceAuthority = v.union(...SOURCE_AUTHORITIES.map((authority) => v.literal(authority)));

/**
 * A tracker ticket as one intake listing showed it: who is assigned, its
 * workflow state and whether a person labelled it do-not-automate. The re-read
 * before apply compares the ticket with the listing a plan was made under.
 */
export const ticketSnapshotValidator = v.object({
  assigned: v.boolean(),
  assigneeId: v.optional(v.string()),
  assigneeEmail: v.optional(v.string()),
  state: v.optional(v.string()),
  stateType: v.optional(v.string()),
  doNotAutomate: v.boolean(),
});

/**
 * Why a plan was drafted without reading its candidate's record (P7-18): the
 * source system, what was not read, and whether the system was not
 * connected or was and the read did not land.
 */
export const planDraftedWithoutValidator = v.object({
  surfaceSlug: v.string(),
  subject: v.union(v.literal('record'), v.literal('thread')),
  cause: v.union(v.literal('not-connected'), v.literal('read-failed')),
});

/**
 * One turn of the chat one-to-one as its session keeps it (`OneToOneTurn` in
 * `src/agent/one-to-one-conversation.ts`): the manager's reply when it is received, the
 * employee's answer when it finishes.
 */
export const oneToOneTurnValidator = v.object({
  id: v.string(),
  speaker: v.union(v.literal('manager'), v.literal('employee')),
  text: v.string(),
  topicIndex: v.optional(v.number()),
  closingLine: v.optional(v.string()),
  at: v.number(),
});

/**
 * Day0 schema - one world per agent, by design.
 *
 * Every other table FK-points back at an `agents` row, the mock work
 * environment included, so an agent's workspace, queue, skills and grants
 * are its own and are never shared with another agent or another user.
 * `workspace` stores the 8-file convention as one row per (agent, file).
 * `events` is the feed driving the live UI; the server patches a row's payload in
 * place when a later phase completes it, so it is not strictly append-only.
 */
/** A page an authoring run read, as a skill version records it (10-K). */
export const readRefValidator = v.object({
  sourceId: v.id('docSources'),
  ref: v.string(),
  title: v.string(),
});

/** The tools a skill version needs on one surface, with that surface's class (10-K). */
export const surfaceToolsValidator = v.object({
  slug: v.string(),
  surfaceClass: v.optional(v.string()),
  tools: v.array(v.string()),
});

/** Whom a card acts as in its system (11-AK; the access plan, section 4.2). */
export const actsAsValidator = v.object({
  kind: v.union(...ACTS_AS_KINDS.map((kind) => v.literal(kind))),
  label: v.string(),
  providerIdentityId: v.optional(v.string()),
});

/**
 * How Day0 itself obtained a credential (11-AK; section 4.4): the system, the grant, the
 * organisation connection whose registration it came through, when one did, and the app it was
 * issued to, when it was an app's: the app's id and client id and the client secret's row. The
 * app is kept here because the card that named it goes with a retire while the revocation at
 * the vendor still needs it (`apps.manifest.delete` takes the app's id, `apps.uninstall` and an
 * RFC 7009 revoke the client's). Only a credential that carries this is revoked at the vendor; a
 * pasted key never is (D5, AC4).
 */
export const credentialIssuerValidator = v.object({
  system: v.string(),
  grant: v.union(...CREDENTIAL_GRANTS.map((grant) => v.literal(grant))),
  organisationConnectionId: v.optional(v.id('organisationConnections')),
  appId: v.optional(v.string()),
  clientId: v.optional(v.string()),
  clientSecretCredentialId: v.optional(v.id('credentials')),
});

/**
 * How a credential's revocation at the vendor stands (11-AK for 11-AR; section 4.4, F19): the
 * state, the attempts made, the vendor's words for the last failure, when the state was last
 * written, and which end of access asked for it.
 */
export const sourceRevocationValidator = v.object({
  state: v.union(...SOURCE_REVOCATION_STATES.map((state) => v.literal(state))),
  attempts: v.number(),
  lastError: v.optional(v.string()),
  at: v.optional(v.number()),
  end: v.optional(v.union(...ACCESS_ENDS.map((end) => v.literal(end)))),
});

/**
 * The access request a card drafted for IT (11-AK for 11-AO; section 4.5, A24): why, the scopes it
 * asks for, the connection it widens when it does, and when it was drafted, copied, sent as an
 * email and sent to the manager in the chat surface, with that message's provider timestamp as
 * the evidence it was delivered.
 */
export const accessRequestValidator = v.object({
  reason: v.union(...ACCESS_REQUEST_REASONS.map((reason) => v.literal(reason))),
  scopes: v.array(v.string()),
  organisationConnectionId: v.optional(v.id('organisationConnections')),
  draftedAt: v.number(),
  copiedAt: v.optional(v.number()),
  emailedAt: v.optional(v.number()),
  messagedAt: v.optional(v.number()),
  messageProviderTs: v.optional(v.string()),
});

/**
 * An OAuth authorisation a card has started and its redirect has not consumed (11-AK for 11-AM;
 * section 4.6): the single-use state nonce and its expiry, the client it runs under, the PKCE
 * verifier sealed in this row with the credential key (never in the URL, and never a credential
 * row an owner's summary would list), the authorisation server the response's `iss` must name,
 * the resource indicator sent on both requests, the redirect, and the organisation connection
 * whose client it is, when it is one. Cleared the first time a redirect consumes it.
 */
export const pendingAuthorisationValidator = v.object({
  stateNonce: v.string(),
  stateExpiresAt: v.number(),
  clientId: v.string(),
  verifierCiphertext: v.string(),
  verifierIv: v.string(),
  /** Which credential key sealed the verifier, as `credentials.keyId` says it. */
  verifierKeyId: v.optional(v.string()),
  issuer: v.string(),
  resource: v.string(),
  redirectUrl: v.string(),
  organisationConnectionId: v.optional(v.id('organisationConnections')),
  startedAt: v.number(),
  /**
   * What the issuer's validated metadata said when the authorisation started (R-S), so the
   * callback acts on the issuer the start was checked against without fetching the metadata again:
   * whether it advertised `authorization_response_iss_parameter_supported` (RFC 9207), its token
   * endpoint and the client authentication methods it takes there. Absent on an authorisation
   * started before the field, whose callback reads the metadata again.
   */
  issuerMetadata: v.optional(
    v.object({
      issParameterSupported: v.boolean(),
      tokenEndpoint: v.string(),
      tokenEndpointAuthMethods: v.array(v.string()),
    }),
  ),
});

/** Where a person, an identity or an edge of the owner's graph came from (13-K for 13-P). */
const peopleSourceValidator = v.union(...PEOPLE_SOURCES.map((source) => v.literal(source)));

/**
 * The words a person or an edge was proposed on (13-K for 13-P; A1: quote-grounded): the quote,
 * where it was said in words a card can show (a page's title, "the one-to-one"), when, and for a
 * documentation page its source and ref, so evidence from a page that went can be told apart.
 */
export const peopleEvidenceValidator = v.object({
  quote: v.string(),
  where: v.string(),
  at: v.number(),
  sourceId: v.optional(v.id('docSources')),
  ref: v.optional(v.string()),
});

/**
 * Whom a work item's requester or owner string resolved to in the owner's graph when intake read
 * it (13-K for 13-P; `personFor`, a lookup and never an insert): a person, several people the
 * string could be (never a guess, Q11), or nobody the graph knows (RM6: a Slack id no lookup
 * recorded).
 */
export const personResolutionValidator = v.union(
  v.object({ kind: v.literal('person'), personId: v.id('people') }),
  v.object({ kind: v.literal('ambiguous'), candidates: v.number() }),
  v.object({ kind: v.literal('unknown') }),
);

export default defineSchema({
  agents: defineTable({
    bossEmail: v.string(),
    name: v.string(),
    avatarId: v.optional(v.string()),
    /** Sources the owner unticked at deploy. Everything else the owner links,
     * before or after the deploy, is inherited. */
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
    /** The owner key (`ownerKeyOf` the caller's identity). Optional for legacy rows; new
     * deploys must populate it. Queries scope by this so each owner's
     * agents are isolated. */
    userId: v.optional(v.string()),
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
    /** Controlled-comparison mechanism. Optional only for rows deployed before
     * the evaluation harness; every new deploy persists one arm. */
    arm: v.optional(v.union(v.literal('day0'), v.literal('baseline'))),
    /** Whether the agent may act on connected systems without asking.
     * Absent reads as `false`, the supervised state: reads and the manager
     * DM apply on their own and every other write waits for the manager.
     * `true` applies every non-refused row in the auto phase. Only about
     * actions; skill and surface approval are unchanged. See
     * `src/work/autonomy.ts`. */
    autonomousActions: v.optional(v.boolean()),
    /** How the manager hears about run outcomes over the chat surface.
     * Absent reads as `per-run`: the landed note goes out as it happens and
     * a stop is never sent. `digest` keeps both for one hourly message.
     * Decision requests are sent at once in either mode. */
    managerNotifications: v.optional(v.union(v.literal('per-run'), v.literal('digest'))),
    /** The IANA zone the agent's day is measured in (N12): set at deploy from
     * the manager's browser, editable on the card, read through
     * `src/lib/zone.ts` for every day boundary and every stamp. Absent reads
     * as the deployment's zone; the `agents-zone` migration fills it. */
    zone: v.optional(v.string()),
    /** The surface mode the agent was deployed under, so a figure or an
     * export can say whether it came from the mock or real systems. Absent
     * on rows from before the stamp; the `agents-zone` migration fills it
     * with the deployment's mode. */
    mode: v.optional(v.union(v.literal('mock'), v.literal('real'))),
    /**
     * When the manager paused this one employee (wave 12, 12-P; A15): orthogonal to `state`.
     * While it is set intake takes nothing for the employee and no step of its runs starts;
     * a decision already asked stays answerable. Cleared by resume. Absent on every older row,
     * which reads as running.
     */
    pausedAt: v.optional(v.number()),
    /** The owner key (`ownerKeyOf`) of the manager who paused the employee, set with `pausedAt`. */
    pausedBy: v.optional(v.string()),
    /** The reason the manager gave with the pause, if any, set and cleared with `pausedAt`. */
    pauseReason: v.optional(v.string()),
    createdAt: v.number(),
  }).index('by_userId', ['userId']),

  charters: defineTable({
    agentId: v.id('agents'),
    version: v.string(),
    body: v.any(),
    approved: v.boolean(),
    approvedAt: v.optional(v.number()),
    /** The version this amendment replaced. Every row is kept; the newest is
     * the active one, so the chain is the charter's history. */
    supersedes: v.optional(v.id('charters')),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_version', ['agentId', 'version']),

  workspace: defineTable({
    agentId: v.id('agents'),
    fileName: v.string(),
    content: v.string(),
    updatedAt: v.number(),
  }).index('by_agent_file', ['agentId', 'fileName']),

  // Phase 2 lane A - encrypted credentials shared by documentation and surfaces.
  credentials: defineTable({
    userId: v.string(),
    kind: v.union(v.literal('value'), v.literal('location'), v.literal('oauth')),
    appId: v.optional(v.string()),
    label: v.string(),
    /** Absent once the value is deleted by a reset or an unlink; the row then
     * stays as the audit trail of a credential that was held. */
    ciphertext: v.optional(v.string()),
    iv: v.optional(v.string()),
    /** True only when documentation explicitly assigned this value as a credential. */
    explicitlyAssigned: v.optional(v.boolean()),
    /**
     * True when the page gave the value between an author's quote pair, so the
     * re-checks read a quoted phrase as the author's value, as the floor did
     * when it found it, and the owner-wide exact layer carries it.
     */
    quoted: v.optional(v.boolean()),
    /** Where the value came from: a documentation page, a field the approver
     * typed into, or - Phase 3 - the provider's own OAuth install redirect. */
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
      v.literal('oauth'),
    ),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    status: v.optional(v.union(v.literal('suspect'), v.literal('superseded'))),
    statusReason: v.optional(v.string()),
    /**
     * When a sync first superseded the row, kept while it stays superseded and
     * cleared when its value returns. A page row superseded longer than
     * `SUPERSEDED_CREDENTIAL_KEEP_MS` that no surface holds is pruned by its
     * source's next finish (C2 D2 (a)). The `credentials-superseded-at`
     * migration stamps the rows superseded before it with the upgrade.
     */
    supersededAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    /** Which credential key sealed this row. Declared ahead of the re-seal
     * that writes it (step 32); nothing writes or reads it yet. */
    keyId: v.optional(v.string()),
    /**
     * Who holds the row (11-AK for 11-AO; AC12): `organisation` for a secret IT connected at
     * install or a token every employee shares, stored under `ORGANISATION_OWNER_KEY`
     * (`src/lib/organisation-key.ts`) as its `userId` and sealed with that key; absent means
     * the owner named by `userId`, as every row before wave 11.
     */
    holder: v.optional(v.literal(ORGANISATION_HOLDER)),
    /** How Day0 itself obtained the row, absent for a pasted or documented value (11-AR reads it). */
    issuedBy: v.optional(credentialIssuerValidator),
    /** When the token stops working at the vendor (11-AL, 11-AM, 11-AT refresh before it). */
    expiresAt: v.optional(v.number()),
    /** The refresh token paired with this access token, a row of its own (11-AM, 11-AT). */
    refreshCredentialId: v.optional(v.id('credentials')),
    /**
     * Counts the rotations written to this row; a refresh or a rotation writes the new pair only
     * if the row is still at the generation it read, so a concurrent one loses and re-reads
     * (11-AS, 11-AL, 11-AM; section 4.6). Absent reads as 0.
     */
    generation: v.optional(v.number()),
    /**
     * The refresh lease on an access token's row (the round after wave 11, R-S; the wave 11
     * review's m11): until when one refresh holds the right to present the paired refresh token,
     * taken in the transaction that reads the generation (`refreshLease.claim`). A second refresh
     * waits for the holder's rotation instead of presenting the same token to a server with reuse
     * detection; a lease left by an action that died lapses by itself at this time. Cleared by the
     * rotation and by the holder's release. Absent means no refresh holds it.
     */
    refreshingUntil: v.optional(v.number()),
    /** Where the token lives (11-AT; B15): absent or `native` is this row, `nango` the service. */
    tokenStore: v.optional(v.union(...TOKEN_STORES.map((store) => v.literal(store)))),
    /**
     * The revocation at the vendor of a credential Day0 obtained (11-AR; F19): written with
     * `revokedAt` by the revoking transaction, which keeps the ciphertext for the vendor call
     * until the state is final or the attempts run out.
     */
    sourceRevocation: v.optional(sourceRevocationValidator),
  })
    .index('by_userId', ['userId'])
    .index('by_user_source_ref', ['userId', 'source.sourceId', 'source.ref'])
    /** The revocations at source in one state, oldest revoke first: the retry and the 24-hour purge (11-AR). */
    .index('by_source_revocation_state', ['sourceRevocation.state', 'revokedAt']),

  docSources: defineTable({
    userId: v.string(),
    label: v.string(),
    kind: v.union(
      v.literal('mcp'),
      v.literal('folder'),
      v.literal('git'),
      v.literal('urls'),
      /**
       * A Feishu or Lark wiki space or Drive folder (wave 14, 14-F). The region is the locator's
       * host (`open.feishu.cn` or `open.larksuite.com`); the app's ID and secret are the reader
       * secret, held as `credentialId`. No field of its own.
       */
      v.literal('feishu'),
      /**
       * The wave 15 readers' kinds (15-K for 15-X; K-3), each declared before its reader lands so
       * one push proves them all: until it lands, `readerFor` names the kind as not read yet and
       * the link refuses it. A SharePoint site's document library and pages, read through
       * Microsoft Graph.
       */
      v.literal('sharepoint'),
      /** A Confluence Cloud space, read through its v2 REST API. */
      v.literal('confluence-v2'),
      /** A Confluence Data Center space on the customer's own host, read through its REST API. */
      v.literal('confluence-dc'),
      /** A Yuque knowledge base, read through its open API. */
      v.literal('yuque'),
      /** A Google Drive folder read directly through the Drive API, not through an MCP server. */
      v.literal('drive'),
    ),
    locator: v.string(),
    serverKind: v.optional(
      v.union(
        v.literal('notion'),
        v.literal('confluence'),
        v.literal('drive'),
        v.literal('generic'),
      ),
    ),
    credentialId: v.optional(v.id('credentials')),
    /**
     * How far the manager trusts the source's pages (wave 15, 15-K for 15-A; A5, A19): official
     * beats team beats personal, and within a source a page's own status decides. Absent reads as
     * `team` (`sourceAuthorityOf`, `src/docs/authority.ts`).
     */
    authority: v.optional(sourceAuthority),
    /**
     * The status the source's pages take when neither the manager, the source, a marker in the
     * page nor a confirmed relation decides one (wave 15, 15-K for 15-A). Absent reads as
     * `active`.
     */
    defaultStatus: v.optional(v.union(...DEFAULT_PAGE_STATUSES.map((status) => v.literal(status)))),
    activeSyncId: v.optional(v.id('docSyncRuns')),
    /** The completed generation whose pages are currently authoritative. */
    lastCompletedSyncId: v.optional(v.id('docSyncRuns')),
    /** The completed generation whose system candidates were reconciled. */
    lastDiscoverySyncId: v.optional(v.id('docSyncRuns')),
    discoveryFingerprint: v.optional(v.string()),
    lastDiscoveryAt: v.optional(v.number()),
    lastDiscoveryError: v.optional(v.string()),
    status: v.union(
      v.literal('linking'),
      v.literal('synced'),
      v.literal('error'),
      v.literal('credential-not-landed'),
      /**
       * A sync the deployment's pause held before it read anything (wave 13, 13-K for the
       * documentation fix; W12V-2, W12-R28): it tried nothing, so it did not fail. Written by
       * `failSync` (13-FS); a source held before that writer landed reads `error` with
       * `SYNC_HELD_REASON`.
       */
      v.literal('held'),
    ),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /** How many listings of the source a sync has started from page one; the newest's number. */
    listings: v.optional(v.number()),
    /**
     * The people extraction of the source's documentation (wave 13, 13-K for 13-P), kept as
     * discovery keeps its own: the completed generation it read, the fingerprint of the pages it
     * read (an unchanged fingerprint is skipped), when it last ran, and why it last failed.
     */
    peopleExtractionSyncId: v.optional(v.id('docSyncRuns')),
    peopleExtractionFingerprint: v.optional(v.string()),
    lastPeopleExtractionAt: v.optional(v.number()),
    lastPeopleExtractionError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  // Phase 2 lane A - generation fences and safe cursors for 25-page sync batches.
  docSyncRuns: defineTable({
    sourceId: v.id('docSources'),
    cursor: v.optional(v.string()),
    /**
     * The source's listing this run reads (`docSources.listings`): a sync that
     * reads from page one starts the next, a resumed one carries it on. Absent
     * only on a run begun before 0.6.0, which the `sync-runs-refs` pass (0.16.0)
     * left with no cursor, so it takes no batch and no finish.
     */
    listing: v.optional(v.number()),
    /** How many page refs the run's listing has named so far, a resumed run's carried. */
    pagesListed: v.optional(v.number()),
    credentialRefs: v.array(v.string()),
    pageCount: v.number(),
    redactionCount: v.number(),
    state: v.union(
      v.literal('running'),
      v.literal('completed'),
      v.literal('superseded'),
      v.literal('error'),
      /**
       * Ended at its cursor by the deployment's pause rather than a failure (wave 13, 13-K for the
       * documentation fix; W12-R27): a resume carries it on like an `error` run, and a second run
       * held at the same cursor is not one that got nowhere. Written by `failSync` (13-FS); a run
       * held before that writer landed reads `error`.
       */
      v.literal('held'),
    ),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
    /**
     * How many times the run started its listing again from page one because the listing changed
     * under it (wave 14, 14-I for 14-D; M19): the back-off ends the run with its reason after
     * three. Written by `restartSync`; absent on a run that never restarted, read as 0.
     */
    restarts: v.optional(v.number()),
    /** Why the run ended without completing, on one line: the failure it recorded, or the newer run that superseded it. */
    reason: v.optional(v.string()),
    /**
     * The pages the run listed and could not read, each keeping its last
     * stored version (P5-11): how many, and the first ten by name with why.
     * A resumed run carries it on. Written from 0.6.0; the `sync-runs-unread`
     * migration moves the record earlier releases kept below `reason`.
     */
    unread: v.optional(
      v.object({
        count: v.number(),
        pages: v.array(v.object({ ref: v.string(), reason: v.string() })),
      }),
    ),
    /** What a completed run changed, as the final batch counted it. */
    summary: v.optional(
      v.object({
        pagesKept: v.number(),
        pagesRemoved: v.number(),
        mirrorsRemoved: v.number(),
        credentialsSuperseded: v.number(),
        surfacesToReapprove: v.number(),
        /** Superseded page credentials the finish pruned; absent on runs before 0.6.0. */
        credentialsPruned: v.optional(v.number()),
      }),
    ),
  })
    .index('by_source', ['sourceId'])
    /** The run that finished at a given moment, for the migration that tells
     * a sync's supersede stamp from a person's revoke. */
    .index('by_source_completed_at', ['sourceId', 'completedAt']),

  docPages: defineTable({
    sourceId: v.id('docSources'),
    ref: v.string(),
    title: v.string(),
    url: v.optional(v.string()),
    markdown: v.string(),
    updatedAt: v.number(),
    /**
     * A keyed hash of the page as its reader returned it, before redaction (wave 14, 14-I; P8-10):
     * `pageContentHash` (`src/docs/content-hash.ts`), an HMAC under the deployment's credential key
     * bound to the owner, so the row is no test of a guessed secret. Written by `upsertPage` with
     * every page a sync stores; read by the sync, which skips the redaction and the split of a
     * page whose hash is unchanged. Absent on a page stored before 0.18.0 or without a key: such
     * a page is redacted again at its next sync, which then writes the hash.
     */
    contentHash: v.optional(v.string()),
    /**
     * The page's status, the outcome of the inputs below (wave 15, 15-K for 15-A; K-2). Absent
     * reads as `active` (`pageStatusOf`, `src/docs/authority.ts`). Never part of `contentHash`: a
     * status reaches the row beside it, so an unchanged page whose status changed is marked
     * without being redacted or split again.
     */
    status: v.optional(pageStatus),
    /** What decided `status`. */
    statusSource: v.optional(v.union(...STATUS_SOURCES.map((source) => v.literal(source)))),
    /** What the reader, the page's front matter or its path said of its status, kept as said. */
    nativeStatus: v.optional(pageStatus),
    /**
     * The model's judgement of a free-text marker in the page ("deprecated", "do not use"; N20):
     * the status it read, the words it read it from and when.
     */
    marker: v.optional(v.object({ status: pageStatus, quote: v.string(), judgedAt: v.number() })),
    /** The manager's verified address, when the manager decided `status`. */
    decidedBy: v.optional(v.string()),
    /** When the manager decided `status`. */
    decidedAt: v.optional(v.number()),
    /**
     * The page's revision as its source numbers it (wave 15, 15-K for 15-X; 14-F's ruling 3):
     * Feishu's `revision_id`, Confluence's `version.number`, Drive's `version`, SharePoint's
     * `cTag`, Yuque's `content_updated_at`. One field for every reader; absent where the source
     * gives none.
     */
    sourceRevision: v.optional(v.string()),
    /** From when the page says it holds, and until when. */
    effectiveFrom: v.optional(v.number()),
    effectiveUntil: v.optional(v.number()),
    /** The page that superseded this one, by source and ref. */
    supersededBy: v.optional(v.object({ sourceId: v.id('docSources'), ref: v.string() })),
    /** The manager's trust for this page alone, over its source's `authority`. */
    authorityOverride: v.optional(sourceAuthority),
  })
    .index('by_source', ['sourceId'])
    .index('by_source_ref', ['sourceId', 'ref']),

  /**
   * Two pages that look related (wave 15, 15-K for 15-A; the wave file's section 6.1): one may be
   * the other again, a later version of it, or disagree with it. Proposed by the relation measures
   * and confirmed or dismissed by the manager on a card; never merged by code. Owner-level, as its
   * pages are; deleted with either end's source (`deleteSourceRows`, by `by_from` and `by_to`),
   * and so with its owner (`deleteOwnedDocumentation` removes every source).
   */
  docRelations: defineTable({
    /** The owner's key (`docSources.userId`) both pages' sources are under. */
    userId: v.string(),
    from: v.object({ sourceId: v.id('docSources'), ref: v.string() }),
    to: v.object({ sourceId: v.id('docSources'), ref: v.string() }),
    kind: v.union(...RELATION_KINDS.map((kind) => v.literal(kind))),
    /**
     * What proposed it, measure by measure: a shared share of the text, a title that differs only
     * by a version, a figure that differs under one heading; with the blocks each read, by their
     * hash (`docBlocks.hash`) on their page.
     */
    evidence: v.array(
      v.object({
        measure: v.string(),
        value: v.number(),
        blockRefs: v.optional(v.array(v.string())),
      }),
    ),
    status: v.union(...RELATION_STATUSES.map((status) => v.literal(status))),
    /** The manager's verified address, once they confirmed or dismissed it. */
    decidedBy: v.optional(v.string()),
    decidedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    /** The owner's relations in one standing: the cards still to decide, the confirmed ones. */
    .index('by_user_status', ['userId', 'status'])
    /** The relations from one page, or every page of one source: its status and its unlink. */
    .index('by_from', ['from.sourceId', 'from.ref'])
    /** The relations to one page, or every page of one source. */
    .index('by_to', ['to.sourceId', 'to.ref']),

  /**
   * A stored page as blocks for the search index (wave 14, 14-I; the wave file's section 6.1):
   * split at headings after redaction by `splitPage` (`src/docs/blocks.ts`), so a block holds
   * nothing its page does not. Real mode only, as `docPages` is (R3: mock mode reads the whole
   * mirror). Written by `docBlocks.splitStoredPage`, which `upsertPage` schedules for each page
   * it writes, and by the `docs-backfill-blocks` pass (both through `replacePageBlocks`,
   * `convex/docBlocks.ts`); pruned with its page (`prunePages`, scheduling
   * `docBlocks.prunePageBlocks`) and its source (`deleteSourceRows`). Read by
   * `docBlocks.searchBlocks` (14-R's selection), `docBlocks.unchangedPage` and by id.
   */
  docBlocks: defineTable({
    /** The source owner's key (`docSources.userId`): every search filters on it first. */
    userId: v.string(),
    sourceId: v.id('docSources'),
    /** The page's `docPages.ref`. */
    pageRef: v.string(),
    /** The sync run that wrote this version of the block; the backfill's, the source's last completed run. */
    generation: v.id('docSyncRuns'),
    /** The block's place in its page, from 0. */
    index: v.number(),
    /** The headings it sits under, outermost first. */
    headingPath: v.array(v.string()),
    text: v.string(),
    /** The heading path, the text, and the bigrams of every CJK run (R1): what the index reads. */
    searchText: v.string(),
    kind: v.union(...BLOCK_KINDS.map((kind) => v.literal(kind))),
    /** SHA-256 of the heading path, kind and text: a re-split leaves an unchanged block's row. */
    hash: v.string(),
    chars: v.number(),
  })
    /** A page's blocks in document order: the replace, the prune and an assembled citation. */
    .index('by_source_page', ['sourceId', 'pageRef', 'index'])
    /**
     * A page's block by its content: a plan's cite is read by the hash it was cited under, one row
     * a cite, never the whole page (the second pass on W14-R2).
     */
    .index('by_source_page_hash', ['sourceId', 'pageRef', 'hash'])
    /**
     * A source's blocks by the run that wrote them (the wave file's index; nothing reads it yet: a
     * source's removal pages through `by_source_page`, which also leads with the source).
     */
    .index('by_source_generation', ['sourceId', 'generation'])
    /**
     * At most 16 terms are read and 1,024 results scanned; filter on `userId` and one `sourceId`
     * a query (two equalities on `sourceId` are an AND), at most 8 filter expressions (14-I's
     * proof). Wave 15 adds `status` to the filters.
     */
    .searchIndex('by_text', { searchField: 'searchText', filterFields: ['userId', 'sourceId'] }),

  /**
   * The listing that last named each page of a source (D D2 (a)). Each batch
   * stamps the refs it listed; a finishing sync removes the pages whose stamp
   * is older than its own listing, reading only those. A slim row of its own
   * rather than a field on `docPages`, so restamping every listed page each
   * sync never rewrites a page body or wakes the page's readers (P5-18).
   * Every stored page has one (`upsertPage`, the `doc-page-listings`
   * migration); a listed page not stored yet may have one without a page.
   */
  docPageListings: defineTable({
    sourceId: v.id('docSources'),
    ref: v.string(),
    /** The source's listing (`docSources.listings`) that last named the ref; 0 for the upgrade's copy. */
    seenBy: v.number(),
  })
    /** By source, then listing: the finish's walk of what a listing did not name. */
    .index('by_source', ['sourceId', 'seenBy'])
    .index('by_source_ref', ['sourceId', 'ref']),

  docSystemDiscoveries: defineTable({
    sourceId: v.id('docSources'),
    slug: v.string(),
    displayName: v.string(),
    class: v.string(),
    ref: v.string(),
    quote: v.string(),
    url: v.optional(v.string()),
    evidence: v.optional(
      v.array(
        v.object({
          displayName: v.string(),
          ref: v.string(),
          quote: v.string(),
          url: v.optional(v.string()),
        }),
      ),
    ),
    mergedNames: v.optional(v.array(v.string())),
    identity: v.optional(
      v.object({
        slugs: v.array(v.string()),
        nameKeys: v.array(v.string()),
        endpoints: v.array(v.string()),
        hosts: v.array(v.string()),
      }),
    ),
    current: v.boolean(),
    firstSeenAt: v.number(),
    lastSeenAt: v.number(),
  })
    .index('by_source', ['sourceId'])
    .index('by_source_slug', ['sourceId', 'slug']),

  surfaces: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    displayName: v.string(),
    class: v.string(),
    verdict: v.union(
      v.literal('declared'),
      v.literal('proposed'),
      v.literal('approved'),
      v.literal('connected'),
      v.literal('ungranted'),
      v.literal('absent'),
      v.literal('listed-dead'),
    ),
    /** Evidence for why this system is in the employee's known-system set.
     * It is deliberately separate from `whereFound`, which freezes the route
     * evidence placed in front of the approvers. */
    discoveryEvidence: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal('charter'), v.literal('documentation')),
          sourceId: v.optional(v.id('docSources')),
          ref: v.string(),
          quote: v.string(),
          url: v.optional(v.string()),
          current: v.boolean(),
          firstSeenAt: v.number(),
          lastSeenAt: v.number(),
        }),
      ),
    ),
    whereFound: v.array(v.any()),
    path: v.optional(v.string()),
    fallbackPath: v.optional(v.string()),
    pathCandidates: v.optional(v.array(v.object({ path: v.string(), endpoint: v.string() }))),
    probeAttempts: v.optional(
      v.array(
        v.object({
          path: v.string(),
          endpoint: v.optional(v.string()),
          outcome: v.union(
            v.literal('demoted'),
            v.literal('ungranted'),
            v.literal('listed-dead'),
            v.literal('retried'),
          ),
          reason: v.string(),
          attemptedAt: v.number(),
          retryAfterMs: v.optional(v.number()),
        }),
      ),
    ),
    endpoint: v.optional(v.string()),
    request: v.optional(v.any()),
    /** The manager's approval of the card, the one approval there is (Q10). */
    managerApprovedAt: v.optional(v.number()),
    /** Phase 2 Lane B connection evidence. Credential contents remain in the
     * lane-A credentials table and are decrypted only inside Node actions. */
    credentialId: v.optional(v.id('credentials')),
    /** How `credentialId` was landed, copied from the credentials row when it
     * is attached: `value` and `location` are shared keys whose writes carry
     * the employee's name, `oauth` a dedicated app that posts as itself. */
    credentialKind: v.optional(
      v.union(v.literal('value'), v.literal('location'), v.literal('oauth')),
    ),
    credentialLocation: v.optional(v.string()),
    managerDmChannelId: v.optional(v.string()),
    // The DM counterpart allowed to resolve manager decisions.
    managerUserId: v.optional(v.string()),
    // The manager's Slack display name from the probe's `users.lookupByEmail`.
    managerName: v.optional(v.string()),
    toolAllowlist: v.optional(v.array(v.string())),
    /**
     * The tools the approval covers: the list the first connection after an
     * approval found, or the list the manager approved since (`approveTools`).
     * Every later probe keeps only these (`frozenTools`); a failed probe, an
     * expiry and a renewal leave it, and only a rejection or a demotion to
     * another route clears it. The `surfaces-approved-tools` migration fills it
     * on rows connected before it.
     */
    approvedToolAllowlist: v.optional(v.array(v.string())),
    /** When `approvedToolAllowlist` was set, by a connection or by the manager. */
    toolAllowlistApprovedAt: v.optional(v.number()),
    /**
     * The tools the last connection's provider offered that the approved list
     * left out (`frozenTools`), which the card offers the manager to approve.
     * Written by `recordConnected` beside the stored list, absent when it
     * withheld nothing; cleared with the stored list, and narrowed when the
     * manager approves one of them. The `surfaces-withheld-tools` migration
     * copies it from each connected card's newest `surface.connected` event.
     */
    withheldTools: v.optional(v.array(v.string())),
    toolArguments: v.optional(
      v.array(v.object({ tool: v.string(), arguments: v.array(v.string()) })),
    ),
    providerIdentityId: v.optional(v.string()),
    /** The `bot_id` the chat provider stamps on everything this credential
     * posts, read once at connection beside `providerIdentityId`. A post sent
     * under a customised display name carries no user id, so this is the only
     * mark intake has that the app itself wrote it. */
    providerBotId: v.optional(v.string()),
    providerWorkspaceId: v.optional(v.string()),
    /** Phase 3 - the dedicated provider app this employee registered for
     * itself from the procedure its documentation describes. Present from the
     * moment the app exists; `installedAt` is stamped when the administrator's
     * install click delivers a token through the OAuth redirect. The client
     * secret lives in the credentials table like every other secret; only its
     * id is here. `stateNonce` is the single-use claim on the current install
     * link and is cleared the first time a redirect consumes it. */
    provisioning: v.optional(
      v.object({
        appId: v.string(),
        appName: v.string(),
        clientId: v.string(),
        clientSecretCredentialId: v.id('credentials'),
        installUrl: v.string(),
        redirectUrl: v.string(),
        scopes: v.array(v.string()),
        createdAt: v.number(),
        stateNonce: v.optional(v.string()),
        stateExpiresAt: v.optional(v.number()),
        installedAt: v.optional(v.number()),
        lastError: v.optional(v.string()),
        /**
         * The organisation's Slack configuration connection the app was created with (11-AS),
         * absent for an app created with a token pasted on the card: with that connection's
         * token, `apps.manifest.delete` can delete only the apps it created (S4), which the
         * retire reads (11-AR).
         */
        organisationConnectionId: v.optional(v.id('organisationConnections')),
        /**
         * The app's app-level token (`xapp-`, scope `connections:write`), which a collaborator of
         * the app generates in its settings since no API issues one (wave 12, 12-M; RM3 (a)):
         * the Socket Mode bridge opens the app's connection with it, and the app's decision
         * requests carry Approve and Reject buttons only while it is set. A `credentials` row of
         * its own; absent until someone lands it, and the requests then carry the typed code only.
         */
        appLevelTokenCredentialId: v.optional(v.id('credentials')),
        /**
         * Whether the app's App Home messages tab takes the manager's typed code (wave 13, 13-K
         * for the Slack fix; W12V-7): `open`, with how Day0 knows it (`MESSAGES_TAB_OPEN_HOWS`)
         * and when, or `refused`, with Slack's words for the last refused opening, when, and how
         * many openings were refused, so the card stops trying at every probe. The
         * `surfaces-messages-tab` pass copies the open state from the employee's record, where
         * `surface.app-messages-open` kept it before this field.
         */
        messagesTab: v.optional(
          v.union(
            v.object({
              state: v.literal('open'),
              how: v.union(...MESSAGES_TAB_OPEN_HOWS.map((how) => v.literal(how))),
              at: v.number(),
            }),
            v.object({
              state: v.literal('refused'),
              reason: v.string(),
              at: v.number(),
              attempts: v.number(),
            }),
          ),
        ),
      }),
    ),
    /** Channels the documentation names that the dedicated app has not been
     * invited to yet, as the last probe found them. Slack answers
     * `not_in_channel` until an administrator invites the app, and that is a
     * step only a human can take, so it is reported rather than retried. */
    channelsNotJoined: v.optional(v.array(v.string())),
    probeGeneration: v.optional(v.number()),
    /**
     * When the probe of the current generation began, cleared when it records
     * its result (connected, failed, rate-limited) or the generation ends
     * (access ended, a sync's demotion). A routine re-probe asked for while
     * it is younger than `PROBE_LEASE_MS` is not made (E-88); a probe a person
     * asks for supersedes it. Absent means no probe is in flight.
     */
    probeStartedAt: v.optional(v.number()),
    /** The pending orientation job for a declared row, so a re-run cannot double-schedule. */
    orientationJobId: v.optional(v.id('_scheduled_functions')),
    waterfallPosition: v.optional(v.number()),
    intakeSkipReason: v.optional(v.string()),
    /** The queues this employee reads on a work-bearing surface: picked at
     * orientation from its own role's documented `Team:`, `Project:` and
     * `Channels:` lines, each value kept with the page line that states it,
     * and approved by the manager with the card. Absent on rows
     * proposed before the field that the `surfaces-intake-scope` pass (0.15.0)
     * could not scope, which keep the page scan and say so on the card;
     * present with no value means intake reads nothing, and `notes` says why. */
    intakeScope: v.optional(
      v.object({
        team: v.optional(
          v.object({
            value: v.string(),
            sourceId: v.optional(v.id('docSources')),
            ref: v.string(),
            quote: v.string(),
          }),
        ),
        project: v.optional(
          v.object({
            value: v.string(),
            sourceId: v.optional(v.id('docSources')),
            ref: v.string(),
            quote: v.string(),
          }),
        ),
        projects: v.optional(
          v.array(
            v.object({
              value: v.string(),
              sourceId: v.optional(v.id('docSources')),
              ref: v.string(),
              quote: v.string(),
            }),
          ),
        ),
        channels: v.optional(
          v.array(
            v.object({
              value: v.string(),
              sourceId: v.optional(v.id('docSources')),
              ref: v.string(),
              quote: v.string(),
            }),
          ),
        ),
        notes: v.optional(v.array(v.string())),
      }),
    ),
    lastPolledAt: v.optional(v.number()),
    /** Independent checkpoint for the latency-sensitive manager decision poll. */
    lastDecisionPolledAt: v.optional(v.number()),
    /** Why the last manager decision poll could not read this surface. The
     * work sweep no longer reads the manager DM, so its `intakeSkipReason`
     * stays clean while approvals silently stop arriving; this is the row's
     * own signal, cleared by the next poll that succeeds. */
    lastDecisionError: v.optional(v.string()),
    credentialLanded: v.boolean(),
    lastVerifiedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    /**
     * Who set `expiresAt` (Q5): the approval that started the clock, the
     * manager, or the upgrade that restarted a clock the proposal had started.
     * Cleared with the date; the `surface.access-set` event stays the record.
     * The `surfaces-access-set-by` migration fills it from that event.
     */
    accessSetBy: v.optional(
      v.union(v.literal('approval'), v.literal('manager'), v.literal('upgrade')),
    ),
    reason: v.optional(v.string()),
    /**
     * The organisation connection the card's access comes through (11-AK for 11-AO; section
     * 4.1): its credential then comes from the connection, never from a paste.
     */
    organisationConnectionId: v.optional(v.id('organisationConnections')),
    /**
     * Whom the card acts as (11-AK; D2), written by the paths that land a credential, never by
     * the model, and read by the card (11-AC) and the export. The `surfaces-acts-as` migration
     * writes it for every card holding a live credential before wave 11; a card connected after
     * it by a path that does not write it yet carries none until that path does.
     */
    actsAs: v.optional(actsAsValidator),
    /** The access request the card drafted for IT and how it went out (11-AO; A24). */
    accessRequest: v.optional(accessRequestValidator),
    /** The OAuth authorisation in flight for this card on the MCP rung (11-AM). */
    pendingAuthorisation: v.optional(pendingAuthorisationValidator),
    /**
     * When a handover kept the employee's own identity on this card for the new manager's
     * re-approval (A25): the marker the kept-identity sweep reads in place of the card's reason
     * words, and the start of its `KEPT_IDENTITY_WAIT_MS` wait (the round's review m16). Written by
     * the handover's keep (`reapprovePatch`) from v0.16.0 and cleared by an approval, a cut, a
     * rejection and the identity's end; the `surfaces-kept-identity-since` pass (0.17.0) marked
     * the cards kept before it, so from 0.18.0 the sweep reads the mark alone (14-I).
     */
    keptIdentitySince: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_slug', ['agentId', 'slug'])
    /** The minute-by-minute manager decision poll wants the deployment's chat
     * rows, not its whole surface set - which now grows with the documented
     * estate rather than with the systems a manager happened to name. */
    .index('by_class', ['class'])
    .index('by_credentialId', ['credentialId'])
    /** The deployment's cards in one verdict: the hourly re-probe reads the connected and the dead. */
    .index('by_verdict', ['verdict'])
    /** Every card on one organisation connection: a revoked connection ends each of them (11-AR). */
    .index('by_organisation_connection', ['organisationConnectionId']),

  voiceSessions: defineTable({
    agentId: v.id('agents'),
    mode: v.union(v.literal('elevenlabs'), v.literal('gemini-live'), v.literal('chat')),
    /** The finalisation state machine. A call has two independent finishers -
     * the browser's `onDisconnect` post and the ElevenLabs post-call webhook -
     * so `synthesising` is the reservation exactly one of them wins before any
     * model call is spent. See `convex/voice.ts`. */
    state: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('synthesising'),
      v.literal('done'),
      v.literal('failed'),
    ),
    answers: v.any(),
    transcriptText: v.optional(v.string()),
    elevenLabsConversationId: v.optional(v.string()),
    /** Per-session capability minted by `voice.start`. It rides out to
     * ElevenLabs as a dynamic variable and comes back on the post-call
     * webhook, which is how that unauthenticated route proves which session
     * a transcript belongs to. Optional only for rows written before it
     * existed; those can no longer be completed by webhook. */
    webhookToken: v.optional(v.string()),
    /** Fences the `synthesising` reservation. A finisher may only commit or
     * release while the token it was issued is still the one on the row, so a
     * caller whose lease expired mid-flight cannot overwrite its successor. */
    claimToken: v.optional(v.string()),
    claimedAt: v.optional(v.number()),
    claimedBy: v.optional(
      v.union(v.literal('browser'), v.literal('webhook'), v.literal('recovery')),
    ),
    /** The material the current claim is working from, written by the claim
     * itself. Neither client comes back after its one attempt, so a session
     * released by a failed finisher is only recoverable if what that finisher
     * was given outlives it. */
    pendingTranscript: v.optional(v.string()),
    pendingBossLabel: v.optional(v.string()),
    /** How many times the deployment has re-driven this session on its own.
     * Bounded, so a model that fails the same way every time costs a fixed
     * number of attempts rather than looping for the life of the row. */
    recoveryAttempts: v.optional(v.number()),
    /** When the last attempt handed the session back. Tells a session waiting
     * on its scheduled retry from one whose retry never ran. */
    finalisationFailedAt: v.optional(v.number()),
    /** The recorded result. A duplicate finisher returns this instead of
     * repeating the work, which is what makes a webhook retry idempotent. */
    charterId: v.optional(v.id('charters')),
    charterVersion: v.optional(v.string()),
    /** Why the last finalisation attempt gave up. Kept on a session that went
     * back to `active` so a failed run is visible rather than silent. */
    finalisationError: v.optional(v.string()),
    /** The notes the manager sent this session's drafts back with, oldest
     * first, each with the rules struck on the draft it came with. Every
     * finisher drafts from the transcript and these together, so a redraft
     * the deployment re-drives still carries them (`charters.requestChanges`). */
    changeRequests: v.optional(
      v.array(
        v.object({ reason: v.string(), struck: v.array(v.string()), requestedAt: v.number() }),
      ),
    ),
    /** The chat one-to-one so far, turn by turn, kept as each turn is given
     * (`convex/oneToOne.ts`), so a room closed at any point reopens on the same
     * conversation. Absent on a session no chat turn was kept on. */
    turns: v.optional(v.array(oneToOneTurnValidator)),
    /** The reply the manager was typing and had not sent, kept as they type. */
    replyDraft: v.optional(v.string()),
    /** Which conversation the session holds (`conversationOf`), moved on each time one is set
     * aside, so a write composed against the one before is refused. Absent means the first. */
    conversation: v.optional(v.number()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
    /**
     * When the conversation itself closed: the first claim of its transcript (Finish, the call's
     * webhook, or the close it earned), kept through a redraft the manager asked for and cleared
     * when the one-to-one is held again. The first week's rail dates the one-to-one by it, never by
     * the draft's commit (`endedAt`), which a redraft moves (the second review's x7). Wave 8 A,
     * additive; a session closed before it falls back to `endedAt`.
     */
    conversationEndedAt: v.optional(v.number()),
  })
    .index('by_agent', ['agentId'])
    .index('by_webhook_token', ['webhookToken'])
    // The two shapes the finalisation sweep looks for, each expressed as a
    // range rather than a scan-and-filter: a claim whose lease has expired, and
    // a released session whose scheduled retry never arrived.
    .index('by_state_claimed_at', ['state', 'claimedAt'])
    .index('by_state_failed_at', ['state', 'finalisationFailedAt']),

  workItems: defineTable({
    agentId: v.id('agents'),
    sourceCategory: v.string(),
    sourceSystem: v.string(),
    externalId: v.string(),
    /** Fixed at intake so a card edit cannot change which provider item a retry holds. */
    externalClaimKey: v.optional(v.string()),
    /**
     * The provider item's other name and the claim key it makes, when the
     * provider prints two (Linear: `FIN-1` and a UUID). A write naming either
     * meets this row.
     */
    externalAlias: v.optional(v.string()),
    externalClaimAlias: v.optional(v.string()),
    title: v.string(),
    contentSummary: v.string(),
    contentRefs: v.array(v.string()),
    priority: v.optional(v.string()),
    requesterLabel: v.optional(v.string()),
    owner: v.optional(v.string()),
    requester: v.optional(v.string()),
    /**
     * Whom `requester` and `owner` resolved to in the owner's people graph when intake read them
     * (wave 13, 13-K for 13-P): written beside each string, never in place of it. Absent on rows
     * read before the graph, and where intake had no string to resolve.
     */
    requesterPerson: v.optional(personResolutionValidator),
    ownerPerson: v.optional(personResolutionValidator),
    state: v.union(
      v.literal('discovered'),
      v.literal('claimed'),
      v.literal('plan-pending'),
      v.literal('plan-approved'),
      v.literal('executing'),
      v.literal('completed'),
      v.literal('cancelled'),
      v.literal('failed'),
      v.literal('skipped'),
      v.literal('deferred'),
      v.literal('needs-skill'),
      // ---- Lane C (executors and the gate): the exact-action gate ----
      // Between `runSkill` and apply in real mode: `output.actions` is
      // persisted and nothing reaches a surface until the manager approves.
      v.literal('actions-pending'),
    ),
    verdict: v.optional(v.any()),
    plan: v.optional(v.any()),
    skillId: v.optional(v.id('skills')),
    proposedSkillId: v.optional(v.id('skills')),
    output: v.optional(v.any()),
    skipReason: v.optional(v.string()),
    /**
     * The manager's written reason for rejecting the last held action set,
     * kept in full so a retry can address it; the dashboard shows it beside
     * the truncated skip reason.
     */
    managerFeedback: v.optional(
      v.object({
        reason: v.string(),
        at: v.number(),
        runId: v.optional(v.id('events')),
        /** A rejection reason, a cancelled plan's reason or a note given with Retry; absent rows predate the kind and are rejections. */
        kind: v.optional(
          v.union(v.literal('rejection'), v.literal('plan-rejection'), v.literal('retry-note')),
        ),
        /** Set when a run completed with this feedback as its direction; it is then a record, not an instruction. */
        addressedAt: v.optional(v.number()),
        /** Set on a Retry note given on a run that stopped with a question open: the note answers it (review D2). */
        answersQuestion: v.optional(v.boolean()),
      }),
    ),
    /**
     * What the manager answered when approving the plan: the charter's open
     * questions this plan touched (each also amended the charter through its
     * `managerQuestions` record) and the planner's own note. The executor
     * reads them as approved evidence for this run; cleared on completion.
     */
    managerAnswers: v.optional(
      v.array(
        v.object({
          question: v.string(),
          answer: v.string(),
          answeredAt: v.number(),
          questionId: v.optional(v.id('managerQuestions')),
        }),
      ),
    ),
    /**
     * When the manager retried this item after the quality-fit filter skipped
     * it. The retry is the manager's decision that the work is worth doing, so
     * the next evaluation leaves that filter out; plan approval still applies.
     */
    qualityFitWaivedAt: v.optional(v.number()),
    /**
     * When the manager retried this item after the scope judgement skipped it
     * as out of scope. The retry is the manager's decision that the work is
     * theirs to give, so the next evaluation leaves the scope rule out; the
     * plan gate still applies.
     */
    scopeWaivedAt: v.optional(v.number()),
    /**
     * Real mode: the charter judgement that placed this row in scope, and the
     * approved charter it was made against. While that charter is the latest,
     * a re-evaluation holds the judgement and asks no model; a skip a policy
     * change sends back loses it. `overruled` is every skip reading set aside
     * on the way, in order: the item's source is one the willDo names
     * (`namedBy`) and the skip cited nothing that excludes it.
     */
    scopeAdmission: v.optional(
      v.object({
        charterId: v.id('charters'),
        at: v.number(),
        basis: v.string(),
        namedBy: v.optional(v.string()),
        overruled: v.optional(v.array(v.string())),
      }),
    ),
    /**
     * What last sent this row back to `discovered`: a policy change, or the
     * thing a verdict waited on landing (`verdict-write` when the verdict was
     * written, `check` on Check for new work), or the skill its verdict names
     * having registered (`skill-registered`), with its idempotency key and
     * when. The same key never re-admits the row twice, whichever kind of
     * re-admission came between: `spent` is every key that has sent the row
     * back, this one last, the newest `SPENT_REEVALUATION_KEYS` of them. A
     * row stamped before the list existed has spent its one `key`.
     */
    reevaluation: v.optional(
      v.object({
        trigger: v.string(),
        key: v.string(),
        at: v.number(),
        spent: v.optional(v.array(v.string())),
      }),
    ),
    /**
     * Real mode: when an evaluation of this row started. A second evaluation
     * arriving while the claim is live returns at once, so two wake-ups cost
     * one model call; the verdict releases the claim, and a step that died
     * leaves it to lapse after `STEP_LEASE_MS` for the stalled-step sweep.
     */
    evaluationClaimedAt: v.optional(v.number()),
    /**
     * Real mode: how many evaluations of this row began since it last had a
     * verdict. A row whose evaluation keeps dying ranks behind unattempted
     * rows and is parked after `MAX_EVALUATION_ATTEMPTS` (`src/work/queue-order.ts`),
     * so it cannot hold the queue at a cap of one. Cleared by a verdict and by
     * every re-admission.
     */
    evaluationAttempts: v.optional(v.number()),
    /** When an evaluation of this row last found the scope judgement unreachable (E-70). */
    evaluationUnavailableAt: v.optional(v.number()),
    /**
     * Why it was unreachable, as that evaluation's `work.scope-judgement-unavailable`
     * event gave it: written and cleared with `evaluationUnavailableAt`, so the
     * card's waiting line reads the row, not the feed. The
     * `work-evaluation-unavailable-cause` migration copies it onto rows stamped before it.
     */
    evaluationUnavailableCause: v.optional(v.string()),
    /** Real mode: the same claim for drafting the plan of a claimed row, released by the stored plan. */
    draftClaimedAt: v.optional(v.number()),
    /**
     * When the item's current run began: set when the verdict claims it and when Retry puts it
     * back into a run, and what the queue orders runs by, the longest-running first (the second
     * review's x4). Wave 8 A, additive; a row claimed before it sorts by when it was found.
     */
    claimedAt: v.optional(v.number()),
    planPendingAt: v.optional(v.number()),
    /**
     * Set with a plan drafted without its ticket or thread: the plan waits
     * for the manager, and one drafted while its system was down is drafted
     * again when the system connects (P7-18). Cleared by the next plan.
     */
    planDraftedWithout: v.optional(planDraftedWithoutValidator),
    /**
     * A manager rejected an earlier plan for this item; its own redraft needs
     * explicit approval. A plan rejection also sets `rejectedAt`, which is
     * what a sibling's plan is held on (N3); this field stands in for it only
     * on a row rejected before `rejectedAt` existed.
     */
    planRejectedAt: v.optional(v.number()),
    /**
     * Real mode: when the manager first rejected this row's plan or its held
     * actions. Another employee's plan for the same provider item then waits
     * for the manager with the first rejection's reason, never for autonomy
     * (N3). Set once; optional and not backfilled.
     */
    rejectedAt: v.optional(v.number()),
    providerReconciliation: v.optional(
      v.object({
        actor: v.string(),
        confirmedAt: v.number(),
        entries: v.array(
          v.object({
            phase: v.union(v.literal('single'), v.literal('prerequisite'), v.literal('closing')),
            actionIndex: v.number(),
            tool: v.string(),
            outcome: v.union(v.literal('landed'), v.literal('outcome-unknown')),
            effect: v.optional(v.string()),
            reason: v.optional(v.string()),
            providerId: v.optional(v.string()),
            idempotencyKey: v.optional(v.string()),
            /**
             * The manager's answer for this entry (wave 12, 12-W; wave 5 U17 D1): `landed` is a
             * write the system shows, which a retry counts as landed and never repeats;
             * `not-sent` is one it does not show. Absent on entries confirmed before the
             * per-entry answer, which were confirmed as a whole.
             */
            answer: v.optional(v.union(v.literal('landed'), v.literal('not-sent'))),
          }),
        ),
      }),
    ),
    /**
     * When the manager dismissed this failed item (N7): it leaves the needs-you inbox and stays in
     * the record, and Retry still sends it back. Cleared by Retry. Wave 6 B, additive.
     */
    dismissedAt: v.optional(v.number()),
    /** A single-use decision requested through the manager's main chat surface. */
    decision: v.optional(
      v.object({
        id: v.string(),
        kind: v.union(v.literal('plan'), v.literal('actions')),
        requestedAt: v.number(),
        channel: v.string(),
        surfaceSlug: v.string(),
        surfaceName: v.string(),
        ts: v.optional(v.string()),
        requestFailedAt: v.optional(v.number()),
        requestFailure: v.optional(v.string()),
        decidedAt: v.optional(v.number()),
        outcome: v.optional(v.union(v.literal('approved'), v.literal('rejected'))),
        decidedVia: v.optional(v.union(v.literal('dashboard'), v.literal('channel'))),
        // Provider ts of the channel reply that decided; the same message read again is not a duplicate.
        decidedTs: v.optional(v.string()),
        duplicateNotifiedAt: v.optional(v.number()),
        duplicateNoticeClaimedAt: v.optional(v.number()),
        duplicateNoticeTs: v.optional(v.string()),
        duplicateNoticeFailure: v.optional(v.string()),
        /** The request's text as the manager's DM received it, for the edit that marks it decided. */
        requestText: v.optional(v.string()),
        /** When the one edit marking the decided request was claimed; never made twice. */
        closeClaimedAt: v.optional(v.number()),
        /**
         * The close edit's result (wave 12, 12-W; N-3): when it was made, or why it failed, so a
         * claim with neither is one a lease can find. The `work-decision-closed` pass stamps
         * every edit claimed before them as made.
         */
        closedAt: v.optional(v.number()),
        closeFailure: v.optional(v.string()),
        /**
         * Set when the request went out with Approve and Reject buttons (wave 12, 12-M; RM3 (a)),
         * so the edit that closes or replaces it removes them. Absent: the typed code only.
         */
        withButtons: v.optional(v.boolean()),
      }),
    ),
    // ---- Lane C (executors and the gate) ----
    /** The run whose actions are pending; preserved through approval so the
     * apply step keys its idempotency off the same claim as the skill run. */
    pendingRunId: v.optional(v.id('events')),
    // One verdict per `output.actions` row, decided when the run was held:
    // `auto` applies with no human step, `held` waits for the manager's
    // approval of the literal payload, `refused` is never applied and shows
    // its reason. `held` is the pre-ladder boolean, kept so rows written
    // before dispositions still validate (`normaliseActionVerdict` reads it).
    actionVerdicts: v.optional(
      v.array(
        v.object({
          held: v.optional(v.boolean()),
          disposition: v.optional(
            v.union(v.literal('auto'), v.literal('held'), v.literal('refused')),
          ),
          reason: v.optional(v.string()),
        }),
      ),
    ),
    /** Indexes into `output.actions` to apply in the current phase: the auto
     * rows when the gate classified them, the manager's list afterwards.
     * Every other index is recorded as held (or as awaiting the manager). */
    approvedIndexes: v.optional(v.array(v.number())),
    /** Which phase `approvedIndexes` belongs to. `auto` applies the gate's
     * rows straight from the hold; `approved` applies the manager's. */
    applyPhase: v.optional(v.union(v.literal('auto'), v.literal('approved'))),
    /** Where a reply to this work belongs when it came from a chat thread:
     * the source channel and message, so a skill can address the thread. */
    replyTarget: v.optional(
      v.object({
        channel: v.string(),
        channelName: v.optional(v.string()),
        threadTs: v.optional(v.string()),
      }),
    ),
    /** The execution claim currently allowed to move this row. */
    executionRunId: v.optional(v.id('events')),
    /** The apply claim and its start time, used to recover an interrupted
     * provider call without replaying an outcome that may already have landed. */
    applyAttemptId: v.optional(v.id('events')),
    applyClaimedAt: v.optional(v.number()),
    /**
     * The scheduled function of the latest step the loop queued for the row (wave 12, 12-W;
     * V12-3): recorded where it schedules a draft, an execution or an apply, so Stop can cancel
     * it. One id: an earlier step still pending is held off by the fences (`executionRunId`,
     * `applyAttemptId`), which Stop clears. Absent when no step is queued, and on rows scheduled
     * before the stamp.
     */
    stepJobId: v.optional(v.id('_scheduled_functions')),
    /**
     * When the row last entered a state that waits on the manager (wave 12, 12-W; H D11, D12):
     * stamped at each such transition, so the inbox reads it off the row. Absent on rows that
     * entered it before the stamp, which the inbox dates by their record as before.
     */
    waitingSince: v.optional(v.number()),
    /** The manager's optional "this would have taken me about N minutes",
     * given at plan approval (N11); hours saved is its sum over completed
     * items, an internal gauge only. */
    manualEstimateMinutes: v.optional(v.number()),
    /** When the ask was made: the provider's own timestamp when intake gave
     * one (a Slack `ts`, a Linear `createdAt`), else when intake saw it.
     * Cycle time starts here. */
    observedAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_agent_state', ['agentId', 'state'])
    /** One agent's rows in creation order: a stable order for the export's pages. */
    .index('by_agent', ['agentId'])
    .index('by_agent_decision', ['agentId', 'decision.id'])
    .index('by_agent_decision_surface_channel', [
      'agentId',
      'decision.surfaceSlug',
      'decision.channel',
    ])
    /** The rows asked on one manager channel by when they were decided: the notice window's read (M D3 (b)). */
    .index('by_agent_decision_channel_decided', [
      'agentId',
      'decision.surfaceSlug',
      'decision.channel',
      'decision.decidedAt',
    ])
    /**
     * One agent's claimed duplicate notices not yet sent or failed, by claim: the five-minute
     * sweep's read of a notice whose send died holding its claim (wave 12, 12-W; N-3).
     */
    .index('by_agent_duplicate_notice_open', [
      'agentId',
      'decision.duplicateNoticeTs',
      'decision.duplicateNoticeFailure',
      'decision.duplicateNoticeClaimedAt',
    ])
    /** One agent's claimed close edits with no result, by claim: the same sweep's (12-W; N-3). */
    .index('by_agent_close_open', [
      'agentId',
      'decision.closedAt',
      'decision.closeFailure',
      'decision.closeClaimedAt',
    ])
    .index('by_skill', ['skillId'])
    /** One employee's row for a provider item: intake's idempotency key. */
    .index('by_agent_extId', ['agentId', 'sourceSystem', 'externalId'])
    /** Every work item discovered from one provider item, across employees, by either of its names. */
    .index('by_claim_key', ['externalClaimKey'])
    .index('by_claim_alias', ['externalClaimAlias'])
    /**
     * The rejected rows of one provider item, first rejection first, so the
     * sibling check (N3) reads rejections only. The `planRejectedAt` pair
     * serves rows rejected before `rejectedAt` existed.
     */
    .index('by_claim_key_rejected', ['externalClaimKey', 'rejectedAt'])
    .index('by_claim_alias_rejected', ['externalClaimAlias', 'rejectedAt'])
    .index('by_claim_key_plan_rejected', ['externalClaimKey', 'planRejectedAt'])
    .index('by_claim_alias_plan_rejected', ['externalClaimAlias', 'planRejectedAt']),

  /**
   * Which employee holds an item of the owner's own systems: one live row per
   * (owner, provider item key), so of several employees reaching one ticket
   * or one ask exactly one works it. Taken in the transaction that claims the
   * work item, released when that item is cancelled; completed and failed
   * items keep theirs. Real mode only. The key is `providerItemKey`'s, read
   * from the provider's own identity, never from a surface slug.
   */
  externalClaims: defineTable({
    userId: v.string(),
    key: v.string(),
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    /**
     * The keys of the item's other names, copied from the work item when the
     * claim is taken. The record of everything this claim covers; the guard
     * finds a claim by an alias through the work item's `by_claim_alias`.
     */
    aliases: v.optional(v.array(v.string())),
    /**
     * Set on a claim a work item took on something it writes rather than on
     * the item it was discovered from: a documented page field of a
     * browser-driven surface, which has no intake row of its own.
     */
    writeTarget: v.optional(v.object({ surface: v.string(), field: v.string() })),
    /**
     * When the holder of a write-target claim finished. A page field outlives
     * the work that wrote it, so from then on the claim holds only against
     * work items that already existed; later work may write the field again.
     */
    settledAt: v.optional(v.number()),
    claimedAt: v.number(),
    releasedAt: v.optional(v.number()),
  })
    .index('by_user_key', ['userId', 'key'])
    .index('by_work_item', ['workItemId']),

  /** One question for the manager per (agent, question key): an open
   * question of the charter, asked once at the first plan approval whose plan
   * or candidate touched it. The answer becomes a charter amendment. The
   * record shape is `ManagerQuestionRecord` in `src/agent/manager-questions.ts`. */
  managerQuestions: defineTable({
    agentId: v.id('agents'),
    /** Stable across charter versions: the normalised question text. */
    key: v.string(),
    question: v.string(),
    context: v.object({
      touchedBy: v.union(v.literal('plan'), v.literal('candidate')),
      text: v.string(),
      words: v.array(v.string()),
    }),
    askedAt: v.number(),
    workItemId: v.id('workItems'),
    /** The charter version whose open question this was. */
    charterId: v.id('charters'),
    answer: v.optional(
      v.object({
        text: v.string(),
        answeredAt: v.number(),
        via: v.union(v.literal('dashboard'), v.literal('plan-approval')),
        amendedCharterId: v.optional(v.id('charters')),
      }),
    ),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_key', ['agentId', 'key'])
    .index('by_work_item', ['workItemId']),

  /**
   * One code that decides every held action set open on the manager's
   * channel at the moment it was issued. Each member is named by its item,
   * its own decision code and the run whose literal payloads were shown, so
   * the batch decides exactly what the manager was sent and nothing that
   * moved on since.
   */
  decisionBatches: defineTable({
    agentId: v.id('agents'),
    id: v.string(),
    surfaceSlug: v.string(),
    channel: v.string(),
    members: v.array(
      v.object({
        workItemId: v.id('workItems'),
        decisionId: v.string(),
        pendingRunId: v.id('events'),
      }),
    ),
    requestedAt: v.number(),
    decidedAt: v.optional(v.number()),
    outcome: v.optional(v.union(v.literal('approved'), v.literal('rejected'))),
    decidedTs: v.optional(v.string()),
  })
    .index('by_agent_id', ['agentId', 'id'])
    /**
     * One manager channel's batches by decision time: the undecided ones,
     * newest first, for the decision poll (M D3 (b)). Per channel, so batches
     * another DM was sent never crowd an open one out of the read.
     */
    .index('by_agent_channel_decided', ['agentId', 'surfaceSlug', 'channel', 'decidedAt']),

  /**
   * What the gate tells the manager about a finished run: that work landed,
   * or that the run stopped. Sent one per run or gathered into a digest,
   * claimed once either way, with the provider ts as delivery evidence.
   */
  managerNotes: defineTable({
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    kind: v.union(v.literal('landed'), v.literal('stopped')),
    text: v.string(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    /** The digest send that claimed this note, when it went out in one. */
    digestId: v.optional(v.id('events')),
    providerTs: v.optional(v.string()),
    failure: v.optional(v.string()),
    /** The mode the note was kept under: a digest note stays the digest's to send after a switch to per run. */
    keptFor: v.optional(v.union(v.literal('per-run'), v.literal('digest'))),
    /**
     * When an unsent note was set aside instead of sent: the employee was handed to another
     * manager and the DM it was kept for was the old manager's. The events it summarises stay.
     */
    discardedAt: v.optional(v.number()),
  })
    .index('by_agent', ['agentId'])
    /** One agent's notes not sent yet, so the digest never reads the sent history. */
    .index('by_agent_unsent', ['agentId', 'claimedAt', 'providerTs'])
    /**
     * One agent's claimed notes that neither went out, failed nor were set aside, by when they
     * were claimed: the five-minute sweep's read of a send that died holding its claim (12-W,
     * N-3), which never reads the sent history.
     */
    .index('by_agent_claim_open', ['agentId', 'providerTs', 'failure', 'discardedAt', 'claimedAt']),

  /**
   * The manager's corrections, kept for the employee's later work: a note
   * given with Retry, a reason for rejecting held actions, a reason for
   * cancelling a plan. Real mode only. The planner of a later item of the
   * same kind reads the newest active ones (`src/work/corrections.ts`), and
   * the executor carries those the approved plan applied. The text is kept
   * as the manager wrote it and scrubbed only when a prompt is assembled.
   */
  corrections: defineTable({
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    /** The run the reason was given on, when there was one. */
    runId: v.optional(v.id('events')),
    kind: v.union(v.literal('retry-note'), v.literal('rejection'), v.literal('plan-rejection')),
    text: v.string(),
    itemTitle: v.string(),
    sourceCategory: v.string(),
    sourceSystem: v.string(),
    /** Slugs of the surfaces the item's plan touched, with its own source surface. */
    surfaces: v.array(v.string()),
    createdAt: v.number(),
    /** When the manager retired it; a retired correction is never selected again. */
    retiredAt: v.optional(v.number()),
    /** The later items whose stored plan applied it. */
    appliedTo: v.array(v.id('workItems')),
    /**
     * Where the manager gave it (wave 13, 13-K for 13-W; A14): on the dashboard, or in the manager
     * channel (a Slack reject). Absent reads as `dashboard`, which every row before it was apart
     * from a Slack reject, and nothing can tell those apart, so no pass writes it. A channel
     * correction may propose an agreement and never activates one without the card.
     */
    origin: v.optional(v.union(v.literal('dashboard'), v.literal('channel'))),
    /** The agreement it was proposed into (13-W), so the same correction is not proposed twice. */
    agreementId: v.optional(v.id('workingAgreements')),
    /**
     * When the "do two of these say the same thing" judgement (F10) last read it as a new
     * correction (13-W), so the judgement runs at most once per correction.
     */
    agreementJudgedAt: v.optional(v.number()),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_active', ['agentId', 'retiredAt'])
    .index('by_agent_active_createdAt', ['agentId', 'retiredAt', 'createdAt']),

  /** One idempotent manager-DM acknowledgement per parsed provider reply. */
  managerDecisionNotices: defineTable({
    agentId: v.id('agents'),
    surfaceId: v.id('surfaces'),
    workItemId: v.id('workItems'),
    decisionId: v.string(),
    messageTs: v.string(),
    /**
     * `replaced` answers a reply or a press naming a request a newer one replaced, with the code
     * that replaced it (wave 12, 12-M; F2 D14).
     */
    kind: v.union(v.literal('received'), v.literal('unknown'), v.literal('replaced')),
    text: v.string(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    providerTs: v.optional(v.string()),
    failure: v.optional(v.string()),
  })
    .index('by_surface_message', ['surfaceId', 'messageTs'])
    /** One agent's acknowledgements in creation order, for the export's delivery records. */
    .index('by_agent', ['agentId'])
    /** One agent's claimed notices not yet sent or failed, by claim: the N-3 sweep's read (12-W). */
    .index('by_agent_claim_open', ['agentId', 'providerTs', 'failure', 'claimedAt']),

  /**
   * A decision request a newer one replaced, kept by its code (wave 12, 12-M; F2 D14): a
   * re-drafted plan or a re-held action set asks again under a new code, and overwrites or clears
   * the item's `decision`. The old code stays answerable ("that request was replaced by ..."),
   * and its delivered message is edited once to say so. Written by the paths that replace or
   * clear a delivered or undelivered request; real mode only.
   */
  replacedDecisionRequests: defineTable({
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    /** The replaced request's code. */
    decisionId: v.string(),
    /** The code of the request that replaced it; absent until the new request is asked. */
    replacedBy: v.optional(v.string()),
    kind: v.union(v.literal('plan'), v.literal('actions')),
    surfaceSlug: v.string(),
    channel: v.string(),
    /** The replaced message's provider ts, when it was delivered. */
    ts: v.optional(v.string()),
    /** The replaced message's text as the DM received it, for the edit. */
    requestText: v.optional(v.string()),
    /** Whether the replaced message carried Approve and Reject buttons, which the edit removes. */
    withButtons: v.optional(v.boolean()),
    replacedAt: v.number(),
    /** The one edit marking the old message replaced: its claim, then its result. */
    editClaimedAt: v.optional(v.number()),
    editedAt: v.optional(v.number()),
    editFailure: v.optional(v.string()),
    /**
     * The decision the replaced request had before it was replaced, when it had one (wave 13,
     * 13-K for the Slack fix; W12V-16): a decided request a Retry re-drafted is answered as
     * replaced and, from these, as approved or rejected too. Copied from the item's `decision`.
     */
    outcome: v.optional(v.union(v.literal('approved'), v.literal('rejected'))),
    decidedAt: v.optional(v.number()),
    decidedVia: v.optional(v.union(v.literal('dashboard'), v.literal('channel'))),
    /**
     * When a reply or a press naming the replaced code was first answered (wave 13, 13-K for the
     * Slack fix; W12-R19): one "was replaced" notice per replaced request, never one per press.
     */
    answeredAt: v.optional(v.number()),
  })
    /** A reply's or a press's code, looked up when no live request carries it. */
    .index('by_agent_decision', ['agentId', 'decisionId'])
    /** One item's replaced requests: the new request names itself on each. */
    .index('by_work_item', ['workItemId'])
    /** One agent's edits claimed and not finished, by claim: the N-3 sweep's read (12-W, 12-M). */
    .index('by_agent_edit_open', ['agentId', 'editedAt', 'editFailure', 'editClaimedAt']),

  /**
   * What the Socket Mode bridge (`slack-socket/`, RM7) last reported of one card's app (wave 13,
   * 13-K for the Slack fix; D-6 (b), W12-R16): whether its connection is live, since when, and
   * when the bridge said so, so the card and a new decision request offer buttons only while a
   * bridge carries the app's presses. A table of its own rather than a field on the card: the
   * bridge reports every half minute, and a write to the card would wake every reader of it and
   * conflict with the work loop's transactions that read the card. One row per card; real mode
   * only, so a mock deployment holds none.
   */
  socketHeartbeats: defineTable({
    agentId: v.id('agents'),
    surfaceId: v.id('surfaces'),
    /** The app the report is about; a report for another app than the card's is stale. */
    appId: v.string(),
    /** Whether the bridge holds a greeted connection for the app. */
    live: v.boolean(),
    /** When the live connection was greeted, while `live`. */
    liveSince: v.optional(v.number()),
    /** When the bridge last reported on the app. */
    reportedAt: v.number(),
    /** Why the bridge could not open the app's connection, when it could not. */
    failure: v.optional(v.string()),
  })
    /** One employee's reports: the reset's reader. */
    .index('by_agent', ['agentId'])
    /** One card's report, which the card and the decision request read. */
    .index('by_surface', ['surfaceId']),

  skills: defineTable({
    agentId: v.id('agents'),
    name: v.string(),
    description: v.string(),
    body: v.string(),
    sourceType: v.union(v.literal('builtin'), v.literal('agent-authored')),
    state: v.union(
      v.literal('proposed'),
      v.literal('approved'),
      v.literal('authoring'),
      v.literal('verified'),
      v.literal('registered'),
      v.literal('rejected'),
      v.literal('failed'),
      /** Taken out of one employee's use by the manager; its version and other holders stay. */
      v.literal('retired'),
      /** Replaced by the revision that registered after it (`revisionOf` on the newer row). */
      v.literal('superseded'),
    ),
    proposedFor: v.optional(v.id('workItems')),
    rationale: v.optional(v.string()),
    requiredScopes: v.optional(v.array(v.string())),
    // ---- Lane C (executors and the gate) ----
    /** The surface slug a real-mode skill acts on; approval refuses the skill
     * while that surface is not connected. Absent for mock-only skills. */
    targetSurface: v.optional(v.string()),
    /** The shape the skill was proposed for: one documented operation on one
     * surface class. A registered skill is matched to later work by this pair,
     * never by the item that first needed it. Absent on builtin rows and on
     * rows proposed before shapes existed, which the legacy token matcher
     * still serves. */
    surfaceClass: v.optional(v.string()),
    operation: v.optional(v.string()),
    /** The authoring run that currently holds this skill, and when it took it.
     * Authoring is an exclusive, fenced run: a second run cannot start while
     * this is set and unexpired, and a run may only write its result while this
     * is still its own id. Cleared by every exit, and by the boss's rejection.
     * See `convex/skills.ts`. */
    authoringRunId: v.optional(v.id('events')),
    authoringClaimedAt: v.optional(v.number()),
    /** How many authoring runs in a row were deferred because the model provider could not be reached. */
    authoringDeferrals: v.optional(v.number()),
    /** Names the run that checked this body: a Daytona sandbox id, or
     * `local:<run id>` from the bundled local sandbox. */
    sandboxId: v.optional(v.string()),
    verificationLog: v.optional(v.string()),
    /** A validated smoke test awaiting a sandbox; Retry verifies this body without authoring again. */
    pendingSmokeTest: v.optional(v.string()),
    /** The draft a static-gate or preflight refusal turned away before any
     * sandbox ran, kept so the manager can read what was refused and the
     * retry can correct it rather than start again. Redacted through the
     * outcome redactor and bounded before it is written; never registered.
     * Cleared by every later exit that stores or verifies a body. */
    refusedBody: v.optional(v.string()),
    refusedSmokeTest: v.optional(v.string()),
    createdAt: v.number(),
    registeredAt: v.optional(v.number()),
    // ---- The owner's skill library (10-K; the enhancements plan, section 4.1) ----
    /** The library version this row was verified as. Absent on a builtin, an unshaped row, a
     * row of an owner-less employee and a row not registered yet. */
    versionId: v.optional(v.id('skillVersions')),
    /** How many execution claims named this row, and when the newest did (`claimForExecution`).
     * Backfilled once as the work items that named it; absent on a row never used. */
    useCount: v.optional(v.number()),
    lastUsedAt: v.optional(v.number()),
    /** Authoring runs that wrote a body for this row ("Attempt n of 3"), counted at the claim. */
    authoringAttempts: v.optional(v.number()),
    /** The "Re-check due" chip: stamped by a trigger, cleared only by a passing re-check. The
     * employee keeps running the verified body meanwhile. */
    recheckDueAt: v.optional(v.number()),
    recheckReason: v.optional(v.string()),
    /** Why and when the row left its employee's use (`retired`). */
    retiredAt: v.optional(v.number()),
    retiredReason: v.optional(v.string()),
    /** A proposal's adoption offer: the owner's version another employee verified (10-A). */
    offeredVersionId: v.optional(v.id('skillVersions')),
    /** When the row registered as a version another employee wrote: an adopted skill, which the
     * reuse figure splits out (K7). */
    adoptedAt: v.optional(v.number()),
    /**
     * When the row last entered a state that waits on the manager (wave 12, 12-W; H D11, D12),
     * stamped at each such transition so the inbox reads it off the row. Absent on rows that
     * entered it before the stamp, which the inbox dates by their record as before.
     */
    waitingSince: v.optional(v.number()),
    /** The row a revision replaces at its registration; the replaced row runs until then. */
    revisionOf: v.optional(v.id('skills')),
    /**
     * The employee's owner key (`agents.userId`) when the row was written (the round after wave
     * 11, R-S; the wave 10 review's K-m3): written at every insert, rewritten by a handover's move,
     * filled on older rows by the `skills-owner-key` pass. Absent on a row of an employee with no
     * owner, and on an older row until the pass has run.
     */
    ownerKey: v.optional(v.string()),
  })
    .index('by_agent_name', ['agentId', 'name'])
    .index('by_agent_state', ['agentId', 'state'])
    /**
     * A version's holders among one owner's employees, the owner first (`holdersOf`, K-m3); an
     * owner-less employee's rows are read under an absent key.
     */
    .index('by_owner_version', ['ownerKey', 'versionId']),

  /**
   * The owner's skill library (K1): what a verified skill is, apart from which employee holds it.
   *
   * A `skills` row is what one employee holds and runs, with its own copy of the body it was
   * verified with; a version is the owner's record of that body, its passing smoke test and what
   * it needs, numbered per name. Every lookup leads with the owner key by index
   * (`convex/skillVersions.ts`, `ownerVersions`), so no lookup can cross owners. Retiring an
   * author keeps its versions (clearing `authorAgentId`); deleting the owner's data deletes them;
   * a handover copies the versions the moving employee holds into the new owner's library.
   */
  skillVersions: defineTable({
    /** The owner key (`ownerKeyOf`); every index leads with it. */
    userId: v.string(),
    name: v.string(),
    description: v.string(),
    surfaceClass: v.string(),
    operation: v.string(),
    /** 1, 2, ... per (owner, name). */
    version: v.number(),
    /** SKILL.md as registered, redacted as the holder row keeps it. */
    body: v.string(),
    /** The smoke test that passed with this body. Absent on a version registered before the
     * check was kept, which is not offerable until a re-check keeps one (K3). */
    smokeTest: v.optional(v.string()),
    /** `versionBodyHash(body, smokeTest)` (`src/work/skill-library.ts`). */
    bodyHash: v.string(),
    requiredScopes: v.array(v.string()),
    /** The tools SKILL.md names that the smoke harness allowed: what an adopter's approved
     * allowlist must hold. Empty in mock mode and on a backfilled version. */
    harnessTools: v.array(v.string()),
    /** The same tools surface by surface, with each surface's class, so an adopter's surface of
     * that class is held to the tools listed for it. Absent where `harnessTools` is empty. */
    harnessToolsBySurface: v.optional(v.array(surfaceToolsValidator)),
    /** The surface slug the author's row targeted, where it had one. */
    targetSurface: v.optional(v.string()),
    /** The employee that wrote it; absent once that employee is retired or handed over. */
    authorAgentId: v.optional(v.id('agents')),
    /** The author's name, kept for the adoption card after the author leaves. */
    authorName: v.string(),
    /**
     * How the author stopped naming this version, and when (wave 13, 13-K for the skills fix;
     * 12-FX's "No longer works for you"): retired, or handed over to another manager. Written with
     * the clearing of `authorAgentId`; absent on a version whose author stays, and on one cleared
     * before the field, which the adoption card words as true of both.
     */
    authorLeft: v.optional(
      v.object({
        how: v.union(v.literal('retired'), v.literal('transferred')),
        at: v.number(),
      }),
    ),
    /** The pages the authoring run read, for the page-change triggers of waves 13 and 14. */
    readRefs: v.array(readRefValidator),
    verifiedAt: v.number(),
    /** The version a revision replaced, and when this one was itself replaced. */
    supersedes: v.optional(v.id('skillVersions')),
    supersededAt: v.optional(v.number()),
    /** Withdrawn from every employee (10-C's Withdraw, A12). */
    revokedAt: v.optional(v.number()),
    revokedReason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_owner_shape', ['userId', 'surfaceClass', 'operation'])
    .index('by_owner_name_version', ['userId', 'name', 'version'])
    /** The versions one employee wrote: its retire and its handover clear the author. */
    .index('by_author', ['authorAgentId']),

  /**
   * The people the owner's employees work with (wave 13, 13-K for 13-P; the wave file's section
   * 5.1; A1, A10): one graph per owner, keyed by the owner scope (`ownerScope`,
   * `convex/ownership.ts`), proposed from the charter, the one-to-one, the documentation and
   * provider lookups and confirmed on a card (A14), never written as a confirmed fact behind the
   * manager's back. The owner's own row (`isOwner`) is written at the owner's sign-in by
   * `people.ensureOwner`, keyed by the verified address. An owner table: an employee's retire keeps
   * it, the owner's deletion deletes it.
   */
  people: defineTable({
    /** The owner scope (`ownerScope`); every index leads with it. */
    userId: v.string(),
    displayName: v.string(),
    /** `personNameKey(displayName)`: the name-only match ("possibly the same as", C5). */
    nameKey: v.string(),
    /** The person's address, normalised (`normaliseManagerAddress`), when a source gave one. */
    primaryEmail: v.optional(v.string()),
    title: v.optional(v.string()),
    team: v.optional(v.string()),
    /** The owner's own row: at most one per owner scope. */
    isOwner: v.optional(v.boolean()),
    status: v.union(...PERSON_STATUSES.map((status) => v.literal(status))),
    source: peopleSourceValidator,
    /** The source's own reference: a page ref, a charter version, a session. */
    sourceRef: v.optional(v.string()),
    evidence: v.array(peopleEvidenceValidator),
    /** A proposal whose name alone matches this person (C5): offered, merged only by the manager. */
    possiblySameAs: v.optional(v.id('people')),
    /**
     * Addresses the manager said are someone else's (wave 14, 14-I for 14-FX; W13-R8's "A different
     * person"), normalised: never merged onto this person again, and a lookup by one is not this
     * person's. Replaces the `not-their-address:` evidence marker, which the
     * `people-not-their-addresses` pass lifts into it; 14-FX writes it at "A different person" and
     * reads it in the merge and the lookup. The marker goes in a later release (N10).
     */
    notTheirAddresses: v.optional(v.array(v.string())),
    /**
     * A title, team or address a source proposed for a person the manager already confirmed (wave
     * 14, 14-I for 14-FX; W13-R3): kept beside the confirmed values, never over them, until the
     * manager takes or dismisses it on the card. One at a time: a newer proposal replaces it.
     * Written by the merge (`peopleProposals.mergeProposal`), read by the person's card; 14-FX's.
     */
    proposedChange: v.optional(
      v.object({
        title: v.optional(v.string()),
        team: v.optional(v.string()),
        primaryEmail: v.optional(v.string()),
        source: peopleSourceValidator,
        evidence: peopleEvidenceValidator,
        proposedAt: v.number(),
      }),
    ),
    /**
     * When a provider lookup for this person last failed and was not retried within its bound
     * (wave 14, 14-I for 14-FX; W13-R25: a Slack 429 was logged and dropped). Written by the
     * lookup (`convex/peopleLookupActions.ts`), cleared by the next one that answers; read by the
     * person's card. 14-FX's.
     */
    lookupFailedAt: v.optional(v.number()),
    confirmedAt: v.optional(v.number()),
    dismissedAt: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  })
    /** The owner's people in one standing: the Proposed card and the confirmed list. */
    .index('by_user_status', ['userId', 'status'])
    /** The owner's person with an address: an identity or address match merges as evidence. */
    .index('by_user_email', ['userId', 'primaryEmail'])
    /** The owner's people under one name key: the name-only match. */
    .index('by_user_name', ['userId', 'nameKey'])
    /** The owner's own row (`isOwner`). */
    .index('by_user_owner', ['userId', 'isOwner']),

  /**
   * A person's identity in a system (wave 13, 13-K for 13-P): an address, a sign-in subject, a
   * Slack user or a Linear user, so intake's requester and assignee strings resolve to a person by
   * id, then address, never by name alone (Q11). A Slack identity is recorded only through a lookup
   * (`users.lookupByEmail` on the employee's own connection; RM6: no `users.info`). People's
   * identities only: whom a card acts as is `surfaces.actsAs`, and the two never share a row.
   */
  personIdentities: defineTable({
    /** The owner scope; every index but `by_person` leads with it. */
    userId: v.string(),
    personId: v.id('people'),
    provider: v.union(...IDENTITY_PROVIDERS.map((provider) => v.literal(provider))),
    /** The vendor's workspace the id is unique in: a Slack team, a Linear organisation. */
    providerWorkspaceId: v.optional(v.string()),
    /** The id in the system: a Slack user id, a Linear user id, a normalised address, a subject. */
    externalId: v.string(),
    displayName: v.optional(v.string()),
    /** `personNameKey(displayName)`: a display name intake read, which may match several people. */
    displayNameKey: v.optional(v.string()),
    /** When a provider or the sign-in proved the identity; absent for one a page only named. */
    verifiedAt: v.optional(v.number()),
    source: peopleSourceValidator,
    createdAt: v.number(),
  })
    /** One person's identities: the person row and the merge. */
    .index('by_person', ['personId'])
    /** `personFor(provider, externalId)`: a lookup, never an insert. */
    .index('by_user_provider_external', ['userId', 'provider', 'externalId'])
    /** A display name intake read: one match is the person, more are ambiguous. */
    .index('by_user_provider_display', ['userId', 'provider', 'displayNameKey']),

  /**
   * An edge of the owner's graph (wave 13, 13-K for 13-P): from an employee (`fromAgentId`) or a
   * person (`fromPersonId`) to a person, with when it holds, so a past date is answerable
   * ("approver on a past date"). An edit supersedes (`supersedes` on the new row, the old one
   * `superseded` with `effectiveUntil`); an employee's retire and handover retire its edges.
   * `fromAgentId` is not `agentId` on purpose: an edge is the owner's record and outlives the
   * employee as `retired`, so the reset's agent-keyed rule does not take it.
   */
  relationships: defineTable({
    /** The owner scope; the owner's indexes lead with it. */
    userId: v.string(),
    fromAgentId: v.optional(v.id('agents')),
    fromPersonId: v.optional(v.id('people')),
    toPersonId: v.id('people'),
    type: v.union(...RELATIONSHIP_TYPES.map((type) => v.literal(type))),
    /** What the edge covers, in the source's words: the approvals an `approval-authority` gives. */
    scope: v.optional(v.string()),
    effectiveFrom: v.number(),
    effectiveUntil: v.optional(v.number()),
    status: v.union(...RELATIONSHIP_STATUSES.map((status) => v.literal(status))),
    /** The edge this one replaced. */
    supersedes: v.optional(v.id('relationships')),
    source: peopleSourceValidator,
    sourceRef: v.optional(v.string()),
    evidence: v.optional(v.array(peopleEvidenceValidator)),
    confirmedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    /** The edges pointing at one person: the person row, the owner's deletion. */
    .index('by_user_to', ['userId', 'toPersonId'])
    /** One employee's edges of a type: `escalationContactFor`, `collaboratorsOf`, the retire. */
    .index('by_from_agent_type', ['fromAgentId', 'type'])
    /** The owner's edges of a type by when they began: `approverFor`, on a date. */
    .index('by_user_type', ['userId', 'type', 'effectiveFrom'])
    /** The edges leaving one person. */
    .index('by_from_person', ['fromPersonId']),

  /**
   * The owner's working agreements (wave 13, 13-K for 13-W; the wave file's sections 5.1 and
   * 5.3; A10, A14, A18): standing preferences proposed from corrections given twice or a note kept
   * at a plan approval, activated on a card, read by the planner and both executor phases and never
   * by the scope judgement. One employee's (`agentId`) or every employee's (no `agentId`, A10's
   * promotion). Agent-keyed by the reset's rule (RM5 (a)): an employee's retire deletes its own
   * rows, and the owner's deletion deletes the owner-wide ones by `by_user_status`.
   */
  workingAgreements: defineTable({
    /** The owner scope; `by_user_status` leads with it. */
    userId: v.string(),
    /** The one employee it binds; absent for every employee of the owner. */
    agentId: v.optional(v.id('agents')),
    kind: v.union(...AGREEMENT_KINDS.map((kind) => v.literal(kind))),
    /** The agreement in the manager's words, redacted, at most `AGREEMENT_STATEMENT_LIMIT` long. */
    statement: v.string(),
    scope: v.union(...AGREEMENT_SCOPES.map((scope) => v.literal(scope))),
    /** The surface slug of a `surface` scope, the operation of an `operation` one. */
    scopeRef: v.optional(v.string()),
    /** The person of a `person` scope. */
    personId: v.optional(v.id('people')),
    sourceType: v.union(...AGREEMENT_SOURCE_TYPES.map((source) => v.literal(source))),
    sourceRef: v.optional(v.string()),
    /** The corrections a `correction-promotion` came from. */
    correctionIds: v.optional(v.array(v.id('corrections'))),
    /** The item whose plan approval a `plan-approval` agreement was kept at. */
    workItemId: v.optional(v.id('workItems')),
    status: v.union(...AGREEMENT_STATUSES.map((status) => v.literal(status))),
    /** Why a `refused` statement was refused before it was shown (F11), quoting the clause. */
    refusal: v.optional(
      v.object({
        /** A judgement's verdict, or a keep refused before any judgement (14-FX, W13-R28). */
        reason: v.union(
          ...AGREEMENT_REFUSAL_REASONS.map((reason) => v.literal(reason)),
          ...AGREEMENT_KEEP_REFUSAL_REASONS.map((reason) => v.literal(reason)),
        ),
        clause: v.optional(v.string()),
        judgedAt: v.number(),
      }),
    ),
    /** The agreement this one replaced (an edit is a supersede). */
    supersedes: v.optional(v.id('workingAgreements')),
    approvedAt: v.optional(v.number()),
    approvedVia: v.optional(v.union(...AGREEMENT_APPROVED_VIA.map((via) => v.literal(via)))),
    /** When it took effect: absent while it is a proposal. */
    effectiveFrom: v.optional(v.number()),
    effectiveUntil: v.optional(v.number()),
    createdAt: v.number(),
    /** The items whose stored plan applied it (`appliedAgreements`). */
    appliedTo: v.array(v.id('workItems')),
  })
    /** The owner's agreements in one standing: selection, the Agreements card, the deletion. */
    .index('by_user_status', ['userId', 'status'])
    /**
     * One employee's agreements in one standing: the reset's read of an employee's own rows.
     * Never read with an absent `agentId`, which would answer every owner's every-employee rows;
     * those are read by `by_user_agent_status`.
     */
    .index('by_agent_status', ['agentId', 'status'])
    /**
     * One owner's agreements for one employee, or for every employee (absent `agentId`), in one
     * standing: selection reads the candidate's and the every-employee rows, owner first.
     */
    .index('by_user_agent_status', ['userId', 'agentId', 'status'])
    /**
     * One owner's agreements about one person, in one standing (wave 14, 14-I for 14-FX; W13-R33):
     * the merge of two people repoints a person-scoped agreement from the one merged away, read
     * whole rather than past a bounded scan of every agreement.
     */
    .index('by_user_person', ['userId', 'personId', 'status']),

  /**
   * The lease on the verification sandbox: at most one row, the skill whose
   * authoring run may call the sandbox now.
   *
   * The sandbox serves one request at a time behind a backlog of eight and
   * the client gives up at 75 s, so three employees authoring together used
   * to queue on the socket and time out on each other's slow smoke tests
   * (measured 18 September 2026). The queue lives here instead, where a wait
   * is a visible row rather than a timeout.
   */
  sandboxLeases: defineTable({
    /** Always `local-sandbox`: the single lease, by name, so it is one row. */
    name: v.string(),
    /** The skill whose verification holds it. */
    skillId: v.id('skills'),
    /** The authoring run that took it; only that run may release it. */
    runId: v.id('events'),
    takenAt: v.number(),
  }).index('by_name', ['name']),

  permissionGrants: defineTable({
    agentId: v.id('agents'),
    scope: v.string(),
    /** The authority path that created this grant. Optional for rows written
     * before permission events were introduced. */
    source: v.optional(
      v.union(v.literal('deploy'), v.literal('manager'), v.literal('skill'), v.literal('surface')),
    ),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_agent_scope', ['agentId', 'scope']),

  /**
   * One row per employee a real-mode retire deleted, keyed by its owner
   * (decisions Q15 and N1): the owner-keyed tombstone, what the retire
   * deleted and revoked, and the two boundaries a colleague's work reads that
   * must outlive the employee. `claims` are the provider items the retired
   * employee may already have written, which a colleague still may not take;
   * `rejections` are the items the manager rejected its plan or actions for,
   * whose sibling plans still wait for the manager (N3). A whole-owner retire
   * empties both, as it deletes the live claims. No reset deletes a row.
   *
   * A handover leaves the same boundary for the old owner (decision D11):
   * a row of `kind: 'transferred'` naming its request, whose employee lives
   * on under its new owner. A row without `kind` is a retire.
   */
  retirements: defineTable({
    userId: v.string(),
    /** How the employee left its owner; absent on a retire's row, and on every row from before handovers. */
    kind: v.optional(v.union(v.literal('retired'), v.literal('transferred'))),
    /** The accepted handover request, on a `transferred` row. */
    transferId: v.optional(v.id('managerTransfers')),
    /** The retired employee's id; its row is gone. */
    agentId: v.id('agents'),
    /** Absent on a row the upgrade copied from an older tombstone event. */
    agentName: v.optional(v.string()),
    retiredAt: v.number(),
    rowCounts: v.record(v.string(), v.number()),
    revokedCredentials: v.number(),
    keptCredentials: v.number(),
    claims: v.array(
      v.object({
        claimId: v.id('externalClaims'),
        key: v.string(),
        aliases: v.optional(v.array(v.string())),
        workItemId: v.id('workItems'),
        title: v.string(),
        /** The holding item's state when its employee was retired. */
        state: v.string(),
        writeTarget: v.optional(v.object({ surface: v.string(), field: v.string() })),
        settledAt: v.optional(v.number()),
        claimedAt: v.number(),
      }),
    ),
    rejections: v.array(
      v.object({
        workItemId: v.id('workItems'),
        /** The item's claim key and alias, as the sibling check matches them. */
        keys: v.array(v.string()),
        rejectedAt: v.number(),
      }),
    ),
  }).index('by_user', ['userId', 'retiredAt']),

  /**
   * One row per request to hand an employee to another manager (the
   * transfer plan, section 4.1): who asked, the address it names, and how it
   * ended. Nothing about the employee changes while it is `asked`; the named
   * manager's acceptance, signed in with that verified address, moves it. A
   * request outlives its employee (the old manager's record of where it went,
   * the new one's of what it took on), so it is a record table no reset
   * deletes (`RETIRE_RECORD_TABLES`). A declined or expired request is never
   * reopened: asking again writes a new row.
   */
  managerTransfers: defineTable({
    agentId: v.id('agents'),
    /** The employee's name when asked, for a record that outlives its row. */
    agentName: v.string(),
    /** The requester's owner key: the employee's `userId` when asked. */
    fromOwnerKey: v.string(),
    /** The requester's verified address, normalised, for the named manager's entry. */
    fromAddress: v.string(),
    /** The named address, normalised (`src/agent/manager-address.ts`). */
    toAddress: v.string(),
    /** The old manager's handover note, bounded and redacted in real mode before it is stored. */
    note: v.optional(v.string()),
    state: v.union(...MANAGER_TRANSFER_STATES.map((state) => v.literal(state))),
    requestedAt: v.number(),
    /** When an `asked` request expires (`transferExpiresAt`). */
    expiresAt: v.number(),
    /** When it left `asked`. */
    decidedAt: v.optional(v.number()),
    /**
     * Why the request was cancelled: an ask's cancel, or `handover-ended` for an accepted
     * handover that ended without its move (`HANDOVER_ENDED_CANCEL_REASON`, declared in wave 11
     * for the settle's writer). Absent on a request that was not cancelled, and on one an older
     * release ended after its acceptance.
     */
    cancelReason: v.optional(
      v.union(...TRANSFER_ROW_CANCEL_REASONS.map((reason) => v.literal(reason))),
    ),
    /**
     * How many settles of an `accepting` request have failed (decision 4), counted on the row so
     * the count need not be read back from the employee's events. Declared in wave 11; absent
     * reads as none counted on the row.
     */
    settleFailures: v.optional(v.number()),
    /** The named manager's words for declining, bounded. */
    declineReason: v.optional(v.string()),
    /** The acceptor's owner key, written at acceptance. */
    toOwnerKey: v.optional(v.string()),
    /**
     * The acceptor's browser zone and documentation choices, given at acceptance and kept so
     * the move can apply them when an `accepting` request settles later, with no caller.
     */
    toZone: v.optional(v.string()),
    toExcludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
    /** While `accepting`: the deadline for runs in flight (`transferSettleBy`). */
    settleBy: v.optional(v.number()),
    /** When the one DM notice to the named person was claimed for sending (D7); never re-sent. */
    noticeSentAt: v.optional(v.number()),
    /** The chat provider's message timestamp, the evidence the notice was delivered. */
    noticeProviderTs: v.optional(v.string()),
    /** What the move did, as counts, for both managers' records; written when the employee moves. */
    outcome: v.optional(
      v.object({
        workItemsMoved: v.number(),
        surfacesCut: v.number(),
        credentialsRevoked: v.number(),
        credentialsKept: v.number(),
        /** The write scopes the cut surfaces had granted, revoked with them. */
        scopesRevoked: v.number(),
        claimsMoved: v.number(),
        claimsReleased: v.number(),
        /** The keys released because the new owner already held a live claim on them. */
        conflictingClaimKeys: v.array(v.string()),
        decisionRequestsVoided: v.number(),
        /** Approved plans not yet started, returned to pending (D13). */
        plansReturned: v.number(),
        sessionsFailed: v.number(),
        notesDiscarded: v.number(),
        /** Pages mirrored from the old owner's sources, hidden and then deleted. */
        mirroredPagesHidden: v.number(),
        /** Runs the settle deadline stopped. */
        runsStopped: v.number(),
        /** Whether a never-approved draft charter was discarded (D8). */
        charterDiscarded: v.boolean(),
      }),
    ),
  })
    /** The one-open rule and the employee's own reads. */
    .index('by_agent_state', ['agentId', 'state'])
    /** The named account's inbox and the per-address bound. */
    .index('by_to_address_state', ['toAddress', 'state'])
    /** The old manager's notices and the per-owner bounds; `_creationTime` ranges the rolling day. */
    .index('by_from_owner_state', ['fromOwnerKey', 'state'])
    /** The expiry sweep over `asked` rows. */
    .index('by_state_expires', ['state', 'expiresAt'])
    /** The settle sweep over `accepting` rows whose runs outlived `settleBy`. */
    .index('by_state_settle', ['state', 'settleBy']),

  /**
   * One row per system IT connected for the whole deployment at install (11-AK for 11-AO; the
   * access plan, section 4.1; B8): the registration every card of the system reuses. A
   * deployment table: owned by no manager, managed by the administrators alone, and never
   * touched by an owner's reset (`DEPLOYMENT_ACCESS_TABLES`, `convex/reset.ts`). Its secrets are
   * `credentials` rows the organisation holds.
   */
  organisationConnections: defineTable({
    /** The stable system key: `slack`, `linear`, `github`, ..., or `mcp:<host>` for an MCP server. */
    system: v.string(),
    displayName: v.string(),
    kind: v.union(...ORGANISATION_CONNECTION_KINDS.map((kind) => v.literal(kind))),
    /** One identity per employee, or one shared by all (D3, B11), chosen per system at install. */
    mode: v.union(...ORGANISATION_CONNECTION_MODES.map((mode) => v.literal(mode))),
    clientId: v.optional(v.string()),
    appId: v.optional(v.string()),
    /** The vendor's id for the customer's workspace (a Slack team, a Linear organisation). */
    providerWorkspaceId: v.optional(v.string()),
    /** The authorisation server, for an MCP client (11-AM): the response's `iss` must name it. */
    issuer: v.optional(v.string()),
    /** The protected resource an MCP client asks tokens for (RFC 8707), the server's URL. */
    resource: v.optional(v.string()),
    /** How an MCP client's client id was obtained (AC7). */
    clientRegistration: v.optional(
      v.union(...MCP_CLIENT_REGISTRATIONS.map((registration) => v.literal(registration))),
    ),
    /** The authorisation server's endpoints as its metadata last gave them (RFC 8414, 11-AM). */
    authorisationEndpoints: v.optional(
      v.object({
        authorisation: v.string(),
        token: v.string(),
        /** RFC 7009's endpoint, which 11-AR's generic revoker calls when it is advertised. */
        revocation: v.optional(v.string()),
        registration: v.optional(v.string()),
        discoveredAt: v.number(),
      }),
    ),
    /** The redirect URI IT registered with the vendor, which `check:access` compares (11-AI). */
    redirectUrl: v.optional(v.string()),
    /** The scopes IT registered for the system (B10). */
    scopes: v.array(v.string()),
    /**
     * The one scope set a client-credentials token is requested with (Linear's `oauth-app` in
     * `shared` mode; 11-AL). Fixed at land and never changed by a rotation: Linear revokes every
     * app-actor token of the app when a token is requested with other scopes (L2).
     */
    clientCredentialsScopes: v.optional(v.array(v.string())),
    /** The client secret, service key or refresh token, as a row the organisation holds. */
    secretCredentialId: v.optional(v.id('credentials')),
    /** In `shared` mode, the one token every employee's card uses until it expires (11-AL). */
    sharedTokenCredentialId: v.optional(v.id('credentials')),
    /** Who registered it, from where, and when: an administrator's verified address, or the CLI. */
    registeredBy: v.object({
      via: v.union(...ORGANISATION_REGISTRARS.map((registrar) => v.literal(registrar))),
      address: v.optional(v.string()),
      at: v.number(),
    }),
    status: v.union(...ORGANISATION_CONNECTION_STATUSES.map((status) => v.literal(status))),
    statusReason: v.optional(v.string()),
    lastRotatedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  })
    /** The system's connection in one status: `activeFor(system)` and the landing check (11-AO). */
    .index('by_system_status', ['system', 'status']),

  /**
   * The ledger of the organisation's connections (11-AK for 11-AO; AC11): install, rotation,
   * scope change, revocation and every vendor call made with a connection's secret. Owner-less,
   * so its rows are never an employee's events; its `type`s join `src/events/contract.ts` and
   * its `payload` is typed there, as `events.payload` is. A deployment table, like its
   * connections.
   */
  connectionEvents: defineTable({
    organisationConnectionId: v.id('organisationConnections'),
    type: v.string(),
    payload: v.any(),
    /** The administrator's verified address; absent for the operator's CLI and for Day0 itself. */
    actorAddress: v.optional(v.string()),
    createdAt: v.number(),
  })
    /** One connection's ledger in order: the administrator's page. */
    .index('by_connection', ['organisationConnectionId', 'createdAt'])
    /** Every connection's ledger in order: the audit export. */
    .index('by_created', ['createdAt']),

  events: defineTable({
    agentId: v.id('agents'),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_type', ['agentId', 'type'])
    /** Events of one type across agents: the `retirements` migration reads the older retire tombstones here. */
    .index('by_type', ['type'])
    /** One agent's events by when they happened, which a record's window reads (wave 12, 12-S3). */
    .index('by_agent_created', ['agentId', 'createdAt']),

  /**
   * Each intake listing of a ticket that changed it, one row per change, so
   * the re-read before apply finds the listing a plan was made under by the
   * work item's own index rather than by walking the agent's events. The
   * first listing still rides on the item's `work.discovered` event.
   */
  ticketListings: defineTable({
    agentId: v.id('agents'),
    workItemId: v.id('workItems'),
    tracker: ticketSnapshotValidator,
    /** Why intake refused the ticket on this listing, when it did. */
    refused: v.optional(v.string()),
    listedAt: v.number(),
  })
    .index('by_work_item_listed_at', ['workItemId', 'listedAt'])
    /** The listings intake took the ticket on (`refused` absent), newest last. */
    .index('by_work_item_refused_listed_at', ['workItemId', 'refused', 'listedAt']),

  /**
   * One row per migration the upgrade runs (`convex/migrations.ts`): where
   * its batches have reached and when it finished. A finished migration is
   * never run again.
   */
  migrations: defineTable({
    name: v.string(),
    /** The release that ships the migration. */
    release: v.string(),
    cursor: v.optional(v.string()),
    /** Rows read so far, and of those, rows the migration changed. */
    read: v.number(),
    changed: v.number(),
    startedAt: v.number(),
    completedAt: v.optional(v.number()),
    /** What the migration chose where it had to choose, for `migrations:status`. */
    note: v.optional(v.string()),
  }).index('by_name', ['name']),

  /**
   * The release this deployment's rows are at, one row per upgrade that
   * completed; the newest is current. The upgrade reads it before it pushes
   * and refuses to skip a release (decision N10). The stamp is the checkout's
   * own, because the pinned backend image answers `unknown` from `/version`.
   */
  deploymentVersions: defineTable({
    release: v.string(),
    /** The commit the functions were pushed from, when git could say. */
    commit: v.optional(v.string()),
    recordedAt: v.number(),
  }),

  // ---- Mock work environment (per-agent) ----
  // Agent-readable docs (Confluence-style). Includes both team docs (the
  // existing onboarding/team-overview content) and machine-readable
  // "how-to-update-X" guides that describe the action API the executor emits.
  mockDocs: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    body: v.string(),
    category: v.union(v.literal('team-doc'), v.literal('how-to-guide')),
    sourceId: v.optional(v.id('docSources')),
    sourceRef: v.optional(v.string()),
    sourceUrl: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index('by_agent_slug', ['agentId', 'slug'])
    .index('by_source', ['sourceId']),

  // A spreadsheet has named tabs; rows belong to a (sheetSlug, tabName).
  mockSpreadsheets: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    tabs: v.array(
      v.object({
        name: v.string(),
        headers: v.array(v.string()),
      }),
    ),
    updatedAt: v.number(),
  }).index('by_agent_slug', ['agentId', 'slug']),

  mockSpreadsheetRows: defineTable({
    agentId: v.id('agents'),
    sheetSlug: v.string(),
    tabName: v.string(),
    cells: v.any(), // { headerName: stringValue }
    addedBy: v.optional(v.string()), // 'agent' | 'manual' | display label
    addedAt: v.number(),
  }).index('by_agent_sheet_tab', ['agentId', 'sheetSlug', 'tabName']),

  mockSlackChannels: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    displayName: v.string(),
    kind: v.union(v.literal('channel'), v.literal('dm')),
    createdAt: v.number(),
  }).index('by_agent_slug', ['agentId', 'slug']),

  mockSlackMessages: defineTable({
    agentId: v.id('agents'),
    channelSlug: v.string(),
    threadKey: v.optional(v.string()),
    sender: v.string(),
    senderKind: v.union(
      v.literal('agent-draft'),
      v.literal('agent-posted'),
      v.literal('manager'),
      v.literal('teammate'),
      v.literal('requester'),
      v.literal('system'),
    ),
    body: v.string(),
    timestamp: v.number(),
  }).index('by_agent_channel', ['agentId', 'channelSlug']),

  mockTweets: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    author: v.string(),
    handle: v.string(),
    body: v.string(),
    createdAt: v.number(),
  }).index('by_agent_slug', ['agentId', 'slug']),

  mockTweetReplies: defineTable({
    agentId: v.id('agents'),
    tweetSlug: v.string(),
    author: v.string(),
    handle: v.string(),
    body: v.string(),
    isAgentDraft: v.boolean(),
    createdAt: v.number(),
  }).index('by_agent_tweet', ['agentId', 'tweetSlug']),

  mockTickets: defineTable({
    agentId: v.id('agents'),
    slug: v.string(),
    title: v.string(),
    body: v.string(),
    status: v.union(
      v.literal('open'),
      v.literal('in-progress'),
      v.literal('blocked'),
      v.literal('done'),
    ),
    priority: v.optional(v.string()),
    assignee: v.optional(v.string()),
    comments: v.array(
      v.object({
        author: v.string(),
        body: v.string(),
        timestamp: v.number(),
      }),
    ),
    updatedAt: v.number(),
  }).index('by_agent_slug', ['agentId', 'slug']),
});
