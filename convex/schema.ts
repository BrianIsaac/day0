import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Day0 schema — one world per agent, by design.
 *
 * Every other table FK-points back at an `agents` row, the mock work
 * environment included, so an agent's workspace, queue, skills and grants
 * are its own and are never shared with another agent or another user.
 * `workspace` stores the 8-file convention as one row per (agent, file).
 * `events` is an append-only feed driving the live UI.
 */
export default defineSchema({
  agents: defineTable({
    bossEmail: v.string(),
    name: v.string(),
    avatarId: v.optional(v.string()),
    /** Legacy explicit inclusion list; new deploys store exclusions instead. */
    docSourceIds: v.optional(v.array(v.id('docSources'))),
    /** Sources the owner unticked at deploy. Everything else the owner links,
     * before or after the deploy, is inherited. */
    excludedDocSourceIds: v.optional(v.array(v.id('docSources'))),
    /** Clerk user id (`identity.subject`). Optional for legacy rows; new
     * deploys must populate it. Queries scope by this so each judge's
     * agents are isolated. */
    userId: v.optional(v.string()),
    state: v.union(
      v.literal('deployed'),
      v.literal('day-one-in-progress'),
      v.literal('charter-pending'),
      v.literal('active'),
    ),
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
    ciphertext: v.string(),
    iv: v.string(),
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
    ),
    createdAt: v.number(),
    lastUsedAt: v.optional(v.number()),
    revokedAt: v.optional(v.number()),
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
    status: v.union(
      v.literal('linking'),
      v.literal('synced'),
      v.literal('error'),
      v.literal('credential-not-landed'),
    ),
    lastSyncAt: v.optional(v.number()),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    updatedAt: v.number(),
  }).index('by_user', ['userId']),

  // Phase 2 lane A - generation fences and safe cursors for 25-page sync batches.
  docSyncRuns: defineTable({
    sourceId: v.id('docSources'),
    cursor: v.optional(v.string()),
    refs: v.array(v.string()),
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
  }).index('by_source', ['sourceId']),

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
    whereFound: v.array(v.any()),
    path: v.optional(v.string()),
    fallbackPath: v.optional(v.string()),
    endpoint: v.optional(v.string()),
    request: v.optional(v.any()),
    managerApprovedAt: v.optional(v.number()),
    itApprovedAt: v.optional(v.number()),
    /** Phase 2 Lane B connection evidence. Credential contents remain in the
     * lane-A credentials table and are decrypted only inside Node actions. */
    credentialId: v.optional(v.id('credentials')),
    credentialLocation: v.optional(v.string()),
    managerDmChannelId: v.optional(v.string()),
    toolAllowlist: v.optional(v.array(v.string())),
    toolArguments: v.optional(
      v.array(v.object({ tool: v.string(), arguments: v.array(v.string()) })),
    ),
    providerIdentityId: v.optional(v.string()),
    providerWorkspaceId: v.optional(v.string()),
    probeGeneration: v.optional(v.number()),
    /** The pending orientation job for a declared row, so a re-run cannot double-schedule. */
    orientationJobId: v.optional(v.id('_scheduled_functions')),
    waterfallPosition: v.optional(v.number()),
    intakeSkipReason: v.optional(v.string()),
    lastPolledAt: v.optional(v.number()),
    credentialRef: v.optional(v.string()),
    credentialLanded: v.boolean(),
    lastVerifiedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_slug', ['agentId', 'slug']),

  voiceSessions: defineTable({
    agentId: v.id('agents'),
    mode: v.union(v.literal('elevenlabs'), v.literal('gemini-live'), v.literal('chat')),
    /** The finalisation state machine. A call has two independent finishers —
     * the browser's `onDisconnect` post and the ElevenLabs post-call webhook —
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
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
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
    title: v.string(),
    contentSummary: v.string(),
    contentRefs: v.array(v.string()),
    priority: v.optional(v.string()),
    requesterLabel: v.optional(v.string()),
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
    ),
    verdict: v.optional(v.any()),
    plan: v.optional(v.any()),
    skillId: v.optional(v.id('skills')),
    proposedSkillId: v.optional(v.id('skills')),
    output: v.optional(v.any()),
    skipReason: v.optional(v.string()),
    observedAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_agent_state', ['agentId', 'state'])
    .index('by_extId', ['sourceSystem', 'externalId']),

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
    ),
    proposedFor: v.optional(v.id('workItems')),
    rationale: v.optional(v.string()),
    requiredScopes: v.optional(v.array(v.string())),
    /** The authoring run that currently holds this skill, and when it took it.
     * Authoring is an exclusive, fenced run: a second run cannot start while
     * this is set and unexpired, and a run may only write its result while this
     * is still its own id. Cleared by every exit, and by the boss's rejection.
     * See `convex/skills.ts`. */
    authoringRunId: v.optional(v.id('events')),
    authoringClaimedAt: v.optional(v.number()),
    /** Names the run that checked this body: a Daytona sandbox id, or
     * `local:<run id>` from the bundled local sandbox. */
    sandboxId: v.optional(v.string()),
    /** What that field was called while Daytona was the only backend. Nothing
     * writes it and nothing reads it. It stays declared because Convex checks
     * every existing document against this validator at push time and refuses
     * one carrying a field the validator does not name - so dropping it here
     * would refuse the push on any deployment that has authored a skill. It
     * comes out once those rows have been moved by
     * `skills.migrateSandboxIdField`. */
    daytonaSandboxId: v.optional(v.string()),
    verificationLog: v.optional(v.string()),
    createdAt: v.number(),
    registeredAt: v.optional(v.number()),
  })
    .index('by_agent_name', ['agentId', 'name'])
    .index('by_agent_state', ['agentId', 'state']),

  permissionGrants: defineTable({
    agentId: v.id('agents'),
    scope: v.string(),
    revokedAt: v.optional(v.number()),
    createdAt: v.number(),
  }).index('by_agent_scope', ['agentId', 'scope']),

  events: defineTable({
    agentId: v.id('agents'),
    type: v.string(),
    payload: v.any(),
    createdAt: v.number(),
  }).index('by_agent', ['agentId']),

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
