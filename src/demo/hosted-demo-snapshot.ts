import snapshot from './hosted-demo-snapshot.json';

/**
 * The recorded hosted demo, as `/demo` shows it to a signed-out visitor.
 *
 * `hosted-demo-snapshot.json` is built once, offline, from a private export of
 * the hosted deployment: an allowlisted display model with every backend id
 * replaced by a local alias, every address, link, host and sandbox id removed,
 * and every wall-clock instant rewritten as an offset from the moment the agent
 * was deployed. The private export is not in this repository and is not needed
 * to build or run the app. `tests/src/demo/hosted-demo-snapshot.test.ts` holds
 * those properties against the committed file.
 *
 * The shapes below mirror the live dashboard's rather than inventing new ones:
 * a work item carries the same verdict, plan and output a `Doc<'workItems'>`
 * does, a skill the same source type and state. What they deliberately drop is
 * everything the dashboard needs only to act - row ids, agent ids, and the
 * callbacks behind every approval control - because nothing on this page acts.
 */

export interface RecordingMeta {
  label: string;
  headline: string;
  readOnly: string;
  sanitised: string;
  clock: string;
  /** Offset of the last recorded event, as `+MM:SS`. */
  spanLabel: string;
  /** The day the export this page is built from was taken, as `YYYY-MM-DD`. */
  recordedOn: string;
  /** The short commit of the frontend build the hosted deployment was serving that day. */
  revision: string;
}

/** The recording's date as the page prints it, in British English: `12 September 2026`. */
export function recordedOnLabel(recording: Pick<RecordingMeta, 'recordedOn'>): string {
  return new Date(`${recording.recordedOn}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

/**
 * The one sentence that dates the recording and names its build, and says
 * the product has moved on since (decision Q3: date and caveat now,
 * regenerate later).
 */
export function recordingProvenanceLine(
  recording: Pick<RecordingMeta, 'recordedOn' | 'revision'>,
): string {
  return (
    `Recorded from the hosted deployment on ${recordedOnLabel(recording)}, frontend build ` +
    `${recording.revision}. The product has moved on since, and this page is not regenerated with it.`
  );
}

/** The recorded employee: its alias, name, state and deployment offset. */
export interface RecordedAgent {
  id: string;
  name: string;
  state: string;
  deployedAt: string;
}

/** One sentence the recorded charter cites and where it came from. */
export interface CharterEvidence {
  source: string;
  text: string;
}

/** The recorded charter as the walkthrough shows it. */
export interface RecordedCharter {
  id: string;
  version: string;
  approved: boolean;
  draftedAt: string;
  approvedAt: string;
  source: string;
  proposedFunction: string;
  whyThisHire: string;
  shortTermGoals: { day30: string; day60: string; day90: string };
  proposedBoundaries: { willDo: string[]; willNotDo: string[]; escalationTriggers: string[] };
  namedCollaborators: Array<{ name: string; topic: string }>;
  adjacentRoles: Array<{ who: string; staysOutOfTheirLaneBy: string }>;
  priorityReading: string[];
  openQuestions: string[];
  approvalChain: { boss: string; confidence: string };
  evidence: CharterEvidence[];
}

/** One permission scope the recorded employee held, with when it was granted. */
export interface RecordedScope {
  scope: string;
  grantedAt: string;
  /** True when the boss granted it by approving a skill rather than at deployment. */
  grantedWithSkill: boolean;
}

/** One action from the recording: its tool, its arguments and its outcome. */
export interface RecordedAction {
  tool: string;
  args: Record<string, string>;
  applied: boolean;
}

/** One recorded work item with its verdict, plan, output and ledger. */
export interface RecordedWorkItem {
  id: string;
  title: string;
  state: string;
  priority: string;
  sourceSystem: string;
  sourceCategory: string;
  requesterLabel: string;
  contentSummary: string;
  contentRefs: string[];
  observedAt: string;
  verdict: {
    decision: string;
    value: number | null;
    risk: number | null;
    requiredPermissions: string[];
    reason: string | null;
  };
  skipReason?: string;
  skillUsed?: string;
  proposedSkill?: string;
  plan?: {
    summary: string;
    steps: string[];
    expectedOutputType: string;
    estimatedMinutes: number;
    reversibility: string;
    riskNotes: string;
  };
  output?: { draft: string; notes: string; actions: RecordedAction[] };
}

/** One recorded skill: its source, state and the item it was proposed for. */
export interface RecordedSkill {
  id: string;
  name: string;
  description: string;
  sourceType: string;
  state: string;
  registeredAt: string;
  body: string;
  /** True when only the opening of an authored skill is shown. */
  bodyExcerpted: boolean;
  rationale?: string;
  requiredScopes?: string[];
  proposedFor?: string;
  verificationLog?: string;
}

/** One of the recorded employee's workspace files, with its purpose and an excerpt. */
export interface RecordedWorkspaceFile {
  fileName: string;
  purpose: string;
  bytes: number;
  excerpt: string;
  excerpted: boolean;
}

/** The mock office as the recording left it: documents, channels, messages, sheets, tweets and tickets. */
export interface RecordedOffice {
  docs: Array<{ slug: string; title: string; category: string; body: string }>;
  channels: Array<{ slug: string; displayName: string; kind: string }>;
  messages: Array<{
    channelSlug: string;
    sender: string;
    senderKind: string;
    body: string;
    at: string;
  }>;
  tickets: Array<{
    slug: string;
    title: string;
    status: string;
    priority: string;
    body: string;
    comments: Array<{ author: string; body: string; at: string }>;
  }>;
  spreadsheet: {
    slug: string;
    title: string;
    tabs: Array<{ name: string; headers: string[] }>;
    rows: Array<{ tabName: string; addedBy: string; cells: Record<string, string> }>;
  };
  socialMention: { slug: string; author: string; handle: string; body: string };
}

/** One event of the recording, at its offset from deployment. */
export interface RecordedTimelineEntry {
  at: string;
  type: string;
  label: string;
  subject?: string;
  detail?: string;
}

/** The whole recording the walkthrough renders. */
export interface HostedDemoSnapshot {
  recording: RecordingMeta;
  agent: RecordedAgent;
  charter: RecordedCharter;
  scopes: RecordedScope[];
  workItems: RecordedWorkItem[];
  skills: RecordedSkill[];
  /** Why the authored skill and the completed work are two facts, not one. */
  skillLoopNote: string;
  workspace: RecordedWorkspaceFile[];
  conversation: { rooms: Array<{ mode: string; state: string }>; note: string };
  office: RecordedOffice;
  timeline: RecordedTimelineEntry[];
}

/** The tracked recording, typed. */
export const HOSTED_DEMO_SNAPSHOT = snapshot as HostedDemoSnapshot;
