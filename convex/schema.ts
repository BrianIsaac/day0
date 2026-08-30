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
    /** REMOVED 26 Aug (late): the posture ladder this toggle replaced. Kept
     * optional for one more deployment so rows the ladder wrote still
     * validate at push; nothing reads or writes it. Delete once the primary
     * has been pushed and its rows no longer carry it. */
    posture: v.optional(
      v.union(v.literal('cold-start'), v.literal('supervised'), v.literal('trusted')),
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
    /** Where the value came from: a documentation page, a field the approver
     * typed into, or - Phase 3 - the provider's own OAuth install redirect. */
    source: v.union(
      v.object({ sourceId: v.id('docSources'), ref: v.string() }),
      v.literal('entered'),
      v.literal('oauth'),
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
          outcome: v.union(v.literal('demoted'), v.literal('ungranted'), v.literal('listed-dead')),
          reason: v.string(),
          attemptedAt: v.number(),
        }),
      ),
    ),
    endpoint: v.optional(v.string()),
    request: v.optional(v.any()),
    managerApprovedAt: v.optional(v.number()),
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
    toolArguments: v.optional(
      v.array(v.object({ tool: v.string(), arguments: v.array(v.string()) })),
    ),
    providerIdentityId: v.optional(v.string()),
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
    /** The pending orientation job for a declared row, so a re-run cannot double-schedule. */
    orientationJobId: v.optional(v.id('_scheduled_functions')),
    waterfallPosition: v.optional(v.number()),
    intakeSkipReason: v.optional(v.string()),
    lastPolledAt: v.optional(v.number()),
    /** Independent checkpoint for the latency-sensitive manager decision poll. */
    lastDecisionPolledAt: v.optional(v.number()),
    /** Why the last manager decision poll could not read this surface. The
     * work sweep no longer reads the manager DM, so its `intakeSkipReason`
     * stays clean while approvals silently stop arriving; this is the row's
     * own signal, cleared by the next poll that succeeds. */
    lastDecisionError: v.optional(v.string()),
    /** Transitional validator for rows written before credentialId. Every
     * current state transition clears it; remove after deployed rows migrate. */
    credentialRef: v.optional(v.string()),
    credentialLanded: v.boolean(),
    lastVerifiedAt: v.optional(v.number()),
    expiresAt: v.optional(v.number()),
    reason: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index('by_agent', ['agentId'])
    .index('by_agent_slug', ['agentId', 'slug'])
    /** The minute-by-minute manager decision poll wants the deployment's chat
     * rows, not its whole surface set - which now grows with the documented
     * estate rather than with the systems a manager happened to name. */
    .index('by_class', ['class']),

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
    observedAt: v.number(),
    createdAt: v.number(),
  })
    .index('by_agent_state', ['agentId', 'state'])
    .index('by_agent_decision', ['agentId', 'decision.id'])
    .index('by_agent_decision_surface_channel', [
      'agentId',
      'decision.surfaceSlug',
      'decision.channel',
    ])
    .index('by_skill', ['skillId'])
    .index('by_extId', ['sourceSystem', 'externalId']),

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
  }).index('by_surface_message', ['surfaceId', 'messageTs']),

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
    // ---- Lane C (executors and the gate) ----
    /** The surface slug a real-mode skill acts on; approval refuses the skill
     * while that surface is not connected. Absent for mock-only skills. */
    targetSurface: v.optional(v.string()),
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
    /** REMOVED 26 Aug (late): the posture ladder's per-skill supervised-run
     * counter, replaced by `agents.autonomousActions`. Kept optional for one
     * more deployment so rows the ladder wrote still validate at push;
     * nothing reads or writes it. */
    supervisedRunsCompleted: v.optional(v.number()),
    createdAt: v.number(),
    registeredAt: v.optional(v.number()),
  })
    .index('by_agent_name', ['agentId', 'name'])
    .index('by_agent_state', ['agentId', 'state']),

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
