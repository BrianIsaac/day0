import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';
import { MANAGER_TRANSFER_STATES, TRANSFER_CANCEL_REASONS } from '../src/agent/manager-transfer';

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
    createdAt: v.number(),
  })
    .index('by_bossEmail', ['bossEmail'])
    .index('by_userId', ['userId']),

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
  })
    .index('by_userId', ['userId'])
    .index('by_user_source_ref', ['userId', 'source.sourceId', 'source.ref']),

  docSources: defineTable({
    userId: v.string(),
    label: v.string(),
    kind: v.union(v.literal('mcp'), v.literal('folder'), v.literal('git'), v.literal('urls')),
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
    ),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    /** How many listings of the source a sync has started from page one; the newest's number. */
    listings: v.optional(v.number()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  // Phase 2 lane A - generation fences and safe cursors for 25-page sync batches.
  docSyncRuns: defineTable({
    sourceId: v.id('docSources'),
    cursor: v.optional(v.string()),
    /**
     * The page refs a run of a release before 0.6.0 listed, which bounded a
     * generation at Convex's 8,192-entry array. Nothing writes it from 0.6.0:
     * a listed page is stamped on its `docPageListings` row instead. Read only
     * as a pre-0.6.0 run's listing when that run is resumed or finished.
     */
    refs: v.optional(v.array(v.string())),
    /**
     * The source's listing this run reads (`docSources.listings`): a sync that
     * reads from page one starts the next, a resumed one carries it on. Given
     * lazily to a run begun before 0.6.0.
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
    ),
    createdAt: v.number(),
    completedAt: v.optional(v.number()),
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
  })
    .index('by_source', ['sourceId'])
    .index('by_source_ref', ['sourceId', 'ref']),

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
    /**
     * The IT approval of releases before 0.6.0. Nothing writes or reads it;
     * the `surfaces-single-approval` migration clears it, and the release
     * after that removes this declaration (N10).
     */
    itApprovedAt: v.optional(v.number()),
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
     * proposed before the field, which keep the page scan; present with no
     * value means intake reads nothing, and `notes` says why. */
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
    .index('by_verdict', ['verdict']),

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
    .index('by_agent_unsent', ['agentId', 'claimedAt', 'providerTs']),

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
    kind: v.union(v.literal('received'), v.literal('unknown')),
    text: v.string(),
    createdAt: v.number(),
    claimedAt: v.optional(v.number()),
    providerTs: v.optional(v.string()),
    failure: v.optional(v.string()),
  })
    .index('by_surface_message', ['surfaceId', 'messageTs'])
    /** One agent's acknowledgements in creation order, for the export's delivery records. */
    .index('by_agent', ['agentId']),

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
    /** The row a revision replaces at its registration; the replaced row runs until then. */
    revisionOf: v.optional(v.id('skills')),
  })
    .index('by_agent_name', ['agentId', 'name'])
    .index('by_agent_state', ['agentId', 'state'])
    /** Every holder of a version: a withdrawal, a newer version's re-check stamp, a transfer. */
    .index('by_version', ['versionId']),

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
    harnessToolsBySurface: v.optional(
      v.array(
        v.object({
          slug: v.string(),
          surfaceClass: v.optional(v.string()),
          tools: v.array(v.string()),
        }),
      ),
    ),
    /** The surface slug the author's row targeted, where it had one. */
    targetSurface: v.optional(v.string()),
    /** The employee that wrote it; absent once that employee is retired or handed over. */
    authorAgentId: v.optional(v.id('agents')),
    /** The author's name, kept for the adoption card after the author leaves. */
    authorName: v.string(),
    /** The pages the authoring run read, for the page-change triggers of waves 13 and 14. */
    readRefs: v.array(
      v.object({ sourceId: v.id('docSources'), ref: v.string(), title: v.string() }),
    ),
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
    cancelReason: v.optional(
      v.union(...TRANSFER_CANCEL_REASONS.map((reason) => v.literal(reason))),
    ),
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

  events: defineTable({
    agentId: v.id('agents'),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_type', ['agentId', 'type'])
    /** Events of one type across agents: the `retirements` migration reads the older retire tombstones here. */
    .index('by_type', ['type']),

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
