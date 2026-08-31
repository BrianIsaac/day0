import type { Charter } from '../agent/charter';
import type { AgentId } from '../lib/ids';

/**
 * Work-gathering domain types. Single-tenant Day0 distillation —
 * dropped the Slack-userid + tenant-id bookkeeping from Protean's
 * version since this stack has neither.
 */

export type WorkSourceCategory =
  | 'inbox'
  | 'ticket-queue'
  | 'event-stream'
  | 'live-document'
  | 'meeting-transcript'
  | 'calendar';

export type WorkDecision = 'claim' | 'queue' | 'skip' | 'defer' | 'needs-skill';

/**
 * Where a reply to a chat-sourced work item belongs: the channel the ask was
 * posted in and, for a threaded reply, the message to reply under. A skill
 * addresses the public reply from this rather than from the ask's URL.
 */
export interface ReplyTarget {
  /** The provider channel id (`C0…`). */
  channel: string;
  /** The channel's display name without the `#`, when known. */
  channelName?: string;
  /** The `thread_ts` a threaded reply carries; absent for a top-level post. */
  threadTs?: string;
}

export interface WorkCandidate {
  sourceCategory: WorkSourceCategory;
  sourceSystem: string;
  externalId: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  observedAt: Date;
  priority?: string;
  requesterLabel?: string;
  replyTarget?: ReplyTarget;
}

export type WorkVerdict =
  | { decision: 'claim'; value: number; risk: number; requiredPermissions: string[] }
  | { decision: 'queue'; reason: string; openClaims: number }
  | { decision: 'skip'; reason: string }
  | { decision: 'defer'; reason: string; missingPermissions: string[] }
  | { decision: 'needs-skill'; reason: string; suggestedSkillName: string; suggestedSkillRationale: string };

export interface AgentContext {
  agentId: AgentId;
  charter: Charter;
  /** AGENTS.md content (slot 10) — feeds Layer-2 quality fit. */
  agentsMd: string;
  /** Display label of the boss (email or first name). */
  bossLabel: string;
}

export interface ExecutionPlan {
  summary: string;
  steps: string[];
  expectedOutputType: 'message' | 'doc-update' | 'spreadsheet-update' | 'ticket-update' | 'draft-document';
  riskNotes: string;
  reversibility: string;
  estimatedMinutes: number;
}

/** The four verbs that write to the per-agent mock environment. */
export const MOCK_ACTION_TOOLS = [
  'spreadsheet.appendRow',
  'slack.postMessage',
  'twitter.reply',
  'ticket.update',
] as const;

/**
 * The two generic verbs that reach a discovered real surface. Their arguments
 * travel as JSON strings so the flat argument bag stays a valid strict schema.
 */
export const SURFACE_ACTION_TOOLS = ['mcp.call', 'http.request'] as const;

export const ACTION_TOOLS = [...MOCK_ACTION_TOOLS, ...SURFACE_ACTION_TOOLS] as const;

export type MockActionTool = (typeof MOCK_ACTION_TOOLS)[number];
export type SurfaceActionTool = (typeof SURFACE_ACTION_TOOLS)[number];
export type ActionTool = (typeof ACTION_TOOLS)[number];

export interface MockActionArgs {
  // spreadsheet.appendRow
  sheetSlug?: string;
  tabName?: string;
  cells?: Array<{ header: string; value: string }>;
  // slack.postMessage
  channelSlug?: string;
  threadKey?: string;
  // shared body: slack/twitter text, or the http.request body
  body?: string;
  // twitter.reply
  tweetSlug?: string;
  // ticket.update
  slug?: string;
  status?: 'open' | 'in-progress' | 'blocked' | 'done';
  comment?: string;
  // mcp.call and http.request: the connected surface slug, exactly as listed
  surface?: string;
  // mcp.call
  tool?: string;
  toolArgsJson?: string;
  // http.request
  method?: string;
  path?: string;
  headersJson?: string;
}

export interface MockAction {
  tool: ActionTool;
  args: MockActionArgs;
}

export interface SuppressedDuplicateAction {
  phase: 'initial' | 'dependent';
  index: number;
  duplicateOf: number;
  tool: ActionTool;
  reason: 'duplicate write effect in the same phase';
}

export interface ExecutionOutput {
  draft: string;
  notes: string;
  actions: MockAction[];
  suppressedDuplicateActions?: SuppressedDuplicateAction[];
  /**
   * The emitted actions are prerequisites only; their actual ledger must be
   * available before the run authors its final, result-dependent actions.
   * Optional for rows and test fixtures written before dependent phases.
   */
  needsDependentPhase?: boolean;
}

/** The fixed upper bound on the one result-dependent phase of a run. */
export const DEPENDENT_ACTION_CAP = 4;

/** How one approved plan step is accounted for after real action results exist. */
export interface PlanStepOutcome {
  /** One-based position in the approved plan. */
  step: number;
  status: 'satisfied' | 'blocked';
  /** A ledger effect, provider failure or explicit reason the step could not run. */
  evidence: string;
}

/** Output authored once, after the initial action ledger has settled. */
export interface DependentExecutionOutput {
  draft: string;
  notes: string;
  actions: MockAction[];
  suppressedDuplicateActions?: SuppressedDuplicateAction[];
  planStepOutcomes: PlanStepOutcome[];
}

export interface MockSurfaceSnapshot {
  /** Available how-to-update guides — agent reads these to know action shape. */
  howToGuides: Array<{ slug: string; title: string; body: string }>;
  /** Snapshot of relevant team docs the agent might need to answer questions. */
  teamDocs: Array<{ slug: string; title: string; body: string }>;
  /** Current spreadsheets + visible rows. */
  spreadsheets: Array<{
    slug: string;
    title: string;
    tabs: Array<{ name: string; headers: string[] }>;
    rows: Array<{ tabName: string; cells: Record<string, string> }>;
  }>;
  /** Slack channels with last-N message snapshots. */
  slackChannels: Array<{
    slug: string;
    displayName: string;
    kind: 'channel' | 'dm';
    recentMessages: Array<{ sender: string; body: string; threadKey?: string }>;
  }>;
  tweets: Array<{ slug: string; author: string; handle: string; body: string }>;
  tickets: Array<{
    slug: string;
    title: string;
    status: string;
    body: string;
  }>;
}

export const COLD_START_WIP_LIMIT = 1;
export const AUTONOMOUS_WIP_LIMIT = 3;
export const VALUE_THRESHOLD = 30;
