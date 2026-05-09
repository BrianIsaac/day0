import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

/**
 * Day0 schema — single-tenant, single-agent hackathon distillation.
 *
 * One `agents` row at a time during a demo. Every other table FK-points
 * back to it. `workspace` stores the 8-file convention as one row per
 * (agent, file). `events` is an append-only feed driving the live UI.
 */
export default defineSchema({
  agents: defineTable({
    bossEmail: v.string(),
    name: v.string(),
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

  voiceSessions: defineTable({
    agentId: v.id('agents'),
    mode: v.union(
      v.literal('elevenlabs'),
      v.literal('gemini-live'),
      v.literal('chat'),
    ),
    state: v.union(
      v.literal('pending'),
      v.literal('active'),
      v.literal('done'),
      v.literal('failed'),
    ),
    answers: v.any(),
    transcriptText: v.optional(v.string()),
    elevenLabsConversationId: v.optional(v.string()),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  }).index('by_agent', ['agentId']),

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
    updatedAt: v.number(),
  }).index('by_agent_slug', ['agentId', 'slug']),

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
