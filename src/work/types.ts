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

export interface MockActionArgs {
  // spreadsheet.appendRow
  sheetSlug?: string;
  tabName?: string;
  cells?: Array<{ header: string; value: string }>;
  // slack.postMessage
  channelSlug?: string;
  threadKey?: string;
  // shared body
  body?: string;
  // twitter.reply
  tweetSlug?: string;
  // ticket.update
  slug?: string;
  status?: 'open' | 'in-progress' | 'blocked' | 'done';
  comment?: string;
}

export interface MockAction {
  tool: 'spreadsheet.appendRow' | 'slack.postMessage' | 'twitter.reply' | 'ticket.update';
  args: MockActionArgs;
}

export interface ExecutionOutput {
  draft: string;
  notes: string;
  actions: MockAction[];
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
export const VALUE_THRESHOLD = 30;
