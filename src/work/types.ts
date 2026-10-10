import type { Charter } from '../agent/charter';
import type { AgentId } from '../lib/ids';
import type { AppliedAction } from '../surfaces/types';

/**
 * Work-gathering domain types. Single-tenant Day0 distillation -
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

/** What the evaluator decides for a candidate: take it, queue it, skip it, defer it, or ask for a skill first. */
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

/** One piece of work as intake found it, before any evaluation. */
export interface WorkCandidate {
  sourceCategory: WorkSourceCategory;
  sourceSystem: string;
  externalId: string;
  /**
   * The item's other name, when the provider prints two: a Linear issue is
   * `FIN-1` and a UUID, and a write may name either.
   */
  externalAlias?: string;
  title: string;
  contentSummary: string;
  contentRefs: string[];
  observedAt: Date;
  priority?: string;
  /** Display label of who asked: the requester, else the owner. */
  requesterLabel?: string;
  /** The person the provider shows the item assigned to, when it returns one. */
  owner?: string;
  /** The person the provider shows as having raised the item, when it returns one. */
  requester?: string;
  replyTarget?: ReplyTarget;
}

/**
 * What a skill is for: one documented operation on one surface class. A skill
 * is named, matched and authored by its shape, never by the work item that
 * first needed it.
 */
export interface SkillShape {
  surfaceClass: string;
  operation: string;
}

/** The evaluator's decision on a candidate with the figures or reason behind it, by decision. */
export type WorkVerdict =
  | { decision: 'claim'; value: number; risk: number; requiredPermissions: string[] }
  | { decision: 'queue'; reason: string; openClaims: number }
  | { decision: 'skip'; reason: string }
  | { decision: 'defer'; reason: string; missingPermissions: string[] }
  | {
      decision: 'needs-skill';
      reason: string;
      suggestedSkillName: string;
      suggestedSkillRationale: string;
      suggestedSkillShape: SkillShape;
    };

/** Everything the evaluator and planner read about the employee: its charter, workspace, skills, grants and surfaces. */
export interface AgentContext {
  agentId: AgentId;
  charter: Charter;
  /** AGENTS.md content (slot 10) - feeds Layer-2 quality fit. */
  agentsMd: string;
  /** Display label of the boss (email or first name). */
  bossLabel: string;
}

/** What a plan step does to the surfaces it names: the character of the step, not its wording. */
export type PlanStepKind = 'read' | 'write' | 'report' | 'conditional-write';

/**
 * What a plan says about the originating ticket's state: an unconditional
 * close, a close under a condition the evidence settles, a close the manager
 * decides, a state the plan leaves alone in its own words, or nothing.
 */
export type PlanTransition =
  | 'promised'
  | 'conditional-on-evidence'
  | 'conditional-on-manager'
  | 'withheld'
  | 'none';

/** What one approved plan step obliges the run to do, as declared structure beside the prose. */
export interface PlanStepObligation {
  /** Connected surface slugs the step reads; an absent surface never appears here. */
  reads: string[];
  /** Connected surface slugs the step writes. */
  writes: string[];
  kind: PlanStepKind;
  /** One line from the judgement, for the card and the record. */
  reason?: string;
}

/**
 * The declared obligations of an approved plan: one row per step and the
 * plan's word on the ticket state. The gates read these, never the prose.
 * Absent on a plan drafted in mock mode, before this field existed, or when
 * neither the planner nor the judgement supplied them; a gate then skips the
 * obligations it cannot see.
 */
export interface PlanObligations {
  /** One row per plan step, in step order. */
  steps: PlanStepObligation[];
  transition: PlanTransition;
  /** The one-based step that carries the transition, or null when none does. */
  transitionStep: number | null;
  /** Who settled the fields: the judgement, or the planner when the judgement could not be reached. */
  basis: 'judgement' | 'planner';
  /** Why the judgement was not reached, when the planner's fields stand unchecked. */
  failedOpen?: string;
  /** The judgement's one-line reason for the transition. */
  reason?: string;
  /**
   * The planner's own word on the ticket state when it differed from the
   * judgement's. The judgement's `transition` says what the closing set
   * must carry; the hold reads both, so a state change either reading
   * leaves to the manager waits for the manager.
   */
  plannerTransition?: PlanTransition;
}

/** The plan the manager approves before a run: its summary, steps, expected output and risk notes. */
export interface ExecutionPlan {
  summary: string;
  steps: string[];
  expectedOutputType:
    | 'message'
    | 'doc-update'
    | 'spreadsheet-update'
    | 'ticket-update'
    | 'draft-document';
  riskNotes: string;
  reversibility: string;
  estimatedMinutes: number;
  /**
   * One-based steps the precondition audit flagged as checks of a candidate
   * property nothing asked for, kept after the planner's one repair. The
   * executor reports them, never gates on them.
   */
  advisorySteps?: number[];
  /** The declared obligations the gates verify against the ledger; see `PlanObligations`. */
  obligations?: PlanObligations;
  /**
   * Why the judgement could not settle the obligations when the planner
   * supplied none either: the plan then declares nothing, the gates owe
   * nothing they cannot see, and the run keeps its closing phase so nothing
   * is prewritten on the strength of an unread ledger. Absent on a plan
   * drafted in mock mode or before the field existed.
   */
  obligationsFailedOpen?: string;
  /**
   * The kept corrections (`corrections` ids) the planner applied, real mode
   * only. `setPlan` keeps only the employee's own active ones; the executor
   * carries these and no other.
   */
  appliedCorrections?: string[];
  /** Set when the corrections the planner saw were scrubbed without the span model. */
  correctionsRedaction?: 'structural-only';
  /**
   * The working agreements (`workingAgreements` ids) the planner applied, real mode only (13-W).
   * `setPlan` keeps only active ones that bind this employee; the executor carries these and no
   * other.
   */
  appliedAgreements?: string[];
  /** Set when the agreements the planner saw were scrubbed without the span model. */
  agreementsRedaction?: 'structural-only';
  /**
   * The statements of the working agreements the plan was drafted with that no longer bound the
   * employee when it was stored or approved (retired, refused or held meanwhile; W15-R35): the
   * steps may still follow them, so the card says so. Written by `setPlan` and the approval.
   */
  agreementsLeftOut?: string[];
  /**
   * The documentation each step follows, real mode only (wave 14, 14-R): the cite lines the
   * planner named for a step, each with the stored blocks under it in the planner's selection.
   * The closing phase refuses to run on a plan whose cited block is gone.
   */
  cites?: PlanCite[];
}

/**
 * What a cite is disputed by (wave 15, 15-A): a conflict the manager confirmed between the cited
 * page and another of equal trust, under one heading. The selection tags such a cite line
 * `[conflict]`, and a plan that cites one waits for the manager.
 */
export interface CiteConflict {
  /** The relation (`docRelations` id) the manager confirmed. */
  readonly relationId: string;
  /** The heading the two pages disagree under. */
  readonly heading: string;
  /** The two pages, each by its title and its source's label. */
  readonly pages: readonly [CiteConflictPage, CiteConflictPage];
}

/** One page of a disputed cite. */
export interface CiteConflictPage {
  readonly title: string;
  readonly source: string;
}

/** One cite of a plan step: the cite line's words and the stored blocks under it. */
export interface PlanCite {
  /** The one-based step that follows the cited documentation. */
  readonly step: number;
  /** The words inside the brackets of the cite line, `<source>/<page>#<heading path>`. */
  readonly label: string;
  /** The source the cited page is of (`docSources` id), since two sources may share a label (W14-R27). */
  readonly sourceId?: string;
  /** The cited page's ref within its source. */
  readonly pageRef?: string;
  readonly blocks: readonly CitedBlock[];
  /** Set when the cited passage was disputed as the plan was drafted (`CiteConflict`). */
  readonly conflict?: CiteConflict;
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

/** Every tool an executor may emit: the mock-office verbs and the two surface verbs. */
export const ACTION_TOOLS = [...MOCK_ACTION_TOOLS, ...SURFACE_ACTION_TOOLS] as const;

/** One of the mock-office verbs. */
export type MockActionTool = (typeof MOCK_ACTION_TOOLS)[number];

/**
 * What a write did to the mock environment. `changed: false` is the honest
 * answer when the action named a surface that does not exist, or asked for a
 * patch with nothing in it: the mutation resolved, and the work environment is
 * exactly as it was. The executor completes a work item on `changed`, never on
 * "the promise did not reject".
 */
export interface MockWriteResult {
  changed: boolean;
  reason?: string;
}

/** One of the two verbs that reach a discovered real surface. */
export type SurfaceActionTool = (typeof SURFACE_ACTION_TOOLS)[number];
/** Any tool an executor may emit. */
export type ActionTool = (typeof ACTION_TOOLS)[number];

/** The flat argument bag every action carries, one optional field per verb and argument. */
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

/** One action as an executor emits it: a tool and its arguments. */
export interface MockAction {
  tool: ActionTool;
  args: MockActionArgs;
  /**
   * On a message, the places in its own set of the earlier writes it reports as made, as the run
   * declared them (the wave 13 review's D-5 (b)). The apply binds the message to them. Null where
   * the run declared none (a message whose words then report a write is a tripwire finding,
   * W14-R8); absent on a mock verb that carries no message and on every action written before the
   * field.
   */
  reports?: number[] | null;
}

/** Legacy mock-mode accounting row retained byte-for-byte for the hosted comparison. */
export interface MockProcedureTrailAttestation {
  trailId: string;
  actionIndex: number | null;
  inapplicabilityReason: string | null;
}

/** Real-mode accounting states for one trail parsed from loaded procedures. */
export type RealProcedureTrailAttestation =
  | { trailId: string; state: 'mapped'; actionIndex: number }
  | { trailId: string; state: 'inapplicable'; reason: string }
  | {
      trailId: string;
      state: 'deferred';
      reason: string;
      dependsOnActionIndex?: number | null;
      dependsOnField?: string | null;
    };

/** An executor's account of one runtime procedure trail, in the mock or the real shape. */
export type ProcedureTrailAttestation =
  | MockProcedureTrailAttestation
  | RealProcedureTrailAttestation;

/** A matcher boundary that could not prove or disprove one real transport effect. */
export interface ProcedureTrailLimitation {
  trailId: string;
  actionIndex: number;
  kind: 'unresolved-transport-payload';
  transport: SurfaceActionTool;
  surface: string;
  detail: string;
}

/** A closing action the executor could not emit yet, with the reason and the read it waits on. */
export interface DeferredActionDependency {
  description: string;
  reason: string;
  dependsOnActionIndex: number | null;
  dependsOnField: string | null;
}

/**
 * One bounded argument repair made before a write was held: the probed
 * schema of the tool refused the argument names the executor wrote, the
 * model re-authored them once, and the held payload is the corrected one.
 * `repaired` is false when the repair produced nothing the schema accepts
 * and the first attempt stands, so the manager sees why before deciding.
 */
export interface ArgumentRepairAttempt {
  /** The action's index in the phase it was held with. */
  index: number;
  /** Why the probed schema refused the first attempt. */
  reason: string;
  /** The first attempt's arguments, as written. */
  toolArgsJson: string;
  repaired: boolean;
}

/** One answer the manager gave when approving the plan, as the executor reads it. */
export interface ManagerAnswer {
  question: string;
  answer: string;
}

/**
 * A write an earlier run of this work item landed, with the ledger row that
 * recorded it: the retry's prompts list these, and a comment or message on
 * a target one of them already carries is reused rather than sent again.
 */
export interface LandedWrite {
  action: MockAction;
  applied: AppliedAction;
  /**
   * Later writes in other words that reused this one and stand for it (wave 13 item 8): a reuse is
   * folded into the row it reused, one row per write the provider holds, and keeps its own words
   * here, so a retry's copy in those words on a part-landed target is reused rather than sent.
   */
  reusedAs?: MockAction[];
}

/**
 * A write an earlier run of this work item attempted that the manager,
 * checking the provider before the retry, answered was not sent (wave 12
 * review W12-R13): the retry sends it afresh, and the landed write that
 * shares its target no longer stands in for every write to that target.
 */
export interface UnsentWrite {
  readonly action: MockAction;
  /** The keys its ledger row was recorded under: the row's own and, for a reuse, the row it reused. */
  readonly idempotencyKeys: readonly string[];
}

/**
 * An action an audit withheld after its one repair: never sent, kept on the
 * row with the reason so the manager can read what was written against why
 * it was turned away, while the rest of the response went on.
 */
export interface WithheldAction {
  action: MockAction;
  reason: string;
}

/**
 * A question the run put to the manager while the approved plan left writes
 * to the manager's answer: those writes were withheld, and the run stops with
 * the question as its reason once the rest of its set has settled.
 */
export interface OpenQuestion {
  question: string;
  /** The one-based plan steps that wait on the answer. */
  steps: number[];
}

/**
 * The question the executor declared its set waits on, in its `openQuestion`
 * field (decision N20): the text as it put it to the manager, in the manager
 * DM or, with no chat surface, in its notes; null when it declared none.
 * Real mode only. Absent on a set authored before the field existed, whose
 * question the model judgement reads instead.
 */
export type DeclaredQuestion = string | null;

/** A run's output as the executor returns it and the row stores it: draft, notes, actions and their ledger. */
export interface ExecutionOutput extends WorkDoneFields {
  /** Closing actions outside the parsed trail inventory; absent on older persisted outputs. */
  deferredActions?: DeferredActionDependency[] | null;
  /** Actions the evidence invariant withheld after its one repair; see `WithheldAction`. */
  withheldActions?: WithheldAction[];
  /** Server-derived: the question to the manager this set's withheld writes wait on; see `OpenQuestion`. */
  openQuestion?: OpenQuestion;
  /** See `DeclaredQuestion`. */
  declaredQuestion?: DeclaredQuestion;
  /**
   * Server-derived, real mode: the question a manager message landed by an
   * earlier run of this item asks, as the model judgement read it, or null
   * when none asks. Kept so the closing phase and a closing round read it
   * without asking again; absent when nothing waited on an answer.
   */
  earlierQuestion?: string | null;
  /** Writes earlier runs of this item landed; server-derived on a retry, absent on a first run. */
  landedWrites?: LandedWrite[];
  /**
   * Writes the earlier run attempted that the manager answered were not sent;
   * server-derived on the retry that follows the reconciliation, absent otherwise.
   */
  unsentWrites?: UnsentWrite[];
  draft: string;
  notes: string;
  actions: MockAction[];
  /** The one repair each held write earned before the hold; absent when none was needed. */
  argumentRepairs?: ArgumentRepairAttempt[];
  /** Required by the current provider schema; optional only for persisted pre-contract rows. */
  procedureTrails?: ProcedureTrailAttestation[];
  /** Server-derived real-transport ambiguities; absent from model-authored schemas. */
  procedureTrailLimitations?: ProcedureTrailLimitation[];
  /**
   * The emitted actions are prerequisites only; their actual ledger must be
   * available before the run authors its final, result-dependent actions.
   * Optional for rows and test fixtures written before dependent phases.
   */
  needsDependentPhase?: boolean;
}

/**
 * The closing set a runbook prescribes once the results exist: the audit
 * comment on the originating issue, its state change, the manager DM, the
 * reply into the source thread, and one read-back of what landed.
 */
export const CLOSING_SET_CAP = 5;

/**
 * Room for a documented sequence phase one legitimately deferred because a
 * value in it comes from a phase-one read. The longest such sequence in the
 * runbooks is the six-step tile refresh: navigate, sign in, fill, click,
 * save, snapshot. Granted only when phase one declared a deferral.
 */
export const DEFERRED_SEQUENCE_ALLOWANCE = 6;

/** The fixed upper bound on the one result-dependent phase of a run: the closing set plus one deferred sequence. */
export const DEPENDENT_ACTION_CAP = CLOSING_SET_CAP + DEFERRED_SEQUENCE_ALLOWANCE;

/** The charter clause lists a closing decision can be taken under. */
export const CHARTER_CLAUSE_FIELDS = ['willDo', 'willNotDo', 'escalationTriggers'] as const;

/**
 * A charter clause a closing-phase decision was taken under (backlog step 4):
 * the clause as the approved charter words it, which list it is in, and the
 * version of the charter the executor read. Only a clause the charter carries
 * is kept; the model's quote is checked against it.
 */
export interface CharterClauseRef {
  field: (typeof CHARTER_CLAUSE_FIELDS)[number];
  text: string;
  charterVersion: string;
}

/** How one approved plan step is accounted for after real action results exist. */
export interface PlanStepOutcome {
  /** One-based position in the approved plan. */
  step: number;
  /**
   * `not-verifiable` is an advisory step, or a check of a property the
   * ledger cannot carry: reported, never a reason to withhold the work.
   */
  status: 'satisfied' | 'blocked' | 'not-verifiable';
  /** A ledger effect, provider failure or explicit reason the step could not run. */
  evidence: string;
  /** The charter clause the closing phase decided this step under, when one did; see `CharterClauseRef`. */
  charterClause?: CharterClauseRef;
  /**
   * What the evidence rests on. Absent means the ledger; `manager-feedback`
   * means a fact the manager stated in a rejection reason or retry note,
   * which the run carries as authenticated feedback and the gate checks for.
   */
  basis?: 'manager-feedback';
}

/**
 * A closing set a gate refused before anything in it reached a surface,
 * kept on the row with the reason so the manager can read what was
 * written against why it was turned away, and the retry can correct it
 * from the same ledger rather than author phase one again.
 */
export interface RefusedClosing {
  actions: MockAction[];
  planStepOutcomes: PlanStepOutcome[];
  draft: string;
  notes: string;
  reason: string;
  at: number;
  /** Actions the evidence check withheld from the set before the gate refused it; see `WithheldAction`. */
  withheldActions?: WithheldAction[];
}

/** Output authored once, after the initial action ledger has settled. */
export interface DependentExecutionOutput extends WorkDoneFields {
  draft: string;
  notes: string;
  actions: MockAction[];
  /** Actions the evidence invariant withheld after its one repair; see `WithheldAction`. */
  withheldActions?: WithheldAction[];
  /** Server-derived: the question to the manager this set's withheld writes wait on; see `OpenQuestion`. */
  openQuestion?: OpenQuestion;
  /** See `DeclaredQuestion`. */
  declaredQuestion?: DeclaredQuestion;
  /** Server-derived: as `ExecutionOutput.earlierQuestion`, when the closing phase read it. */
  earlierQuestion?: string | null;
  /** The one repair each held write earned before the hold; absent when none was needed. */
  argumentRepairs?: ArgumentRepairAttempt[];
  /** Required by the current provider schema; optional only for persisted pre-contract rows. */
  procedureTrails?: ProcedureTrailAttestation[];
  /** Server-derived real-transport ambiguities; absent from model-authored schemas. */
  procedureTrailLimitations?: ProcedureTrailLimitation[];
  planStepOutcomes: PlanStepOutcome[];
}

/** The three answers a run gives to whether the work its item asked for was done (decision D-1 (b)). */
export const WORK_DONE_ANSWERS = ['done', 'partial', 'not-done'] as const;

/**
 * Whether the work an item asked for was done, as the run answers it: `done` (all of it),
 * `partial` (some of it) or `not-done` (none of it).
 */
export type WorkDoneAnswer = (typeof WORK_DONE_ANSWERS)[number];

/**
 * The fields a run reports on its own work, model-authored from v0.16.0 in both phases and both
 * modes. Optional on a persisted output: a row, a fixture or a trace recorded before the release
 * carries neither, and is read by the rule in `src/work/work-done.ts`.
 */
export interface WorkDoneFields {
  /** The run's answer; see `WorkDoneAnswer`. */
  workDone?: WorkDoneAnswer;
  /** One line, in the run's own words, of why it answered so. */
  workDoneWhy?: string;
  /**
   * Server-derived: the run answered `done` twice while its own words said the work was not done
   * (the tripwire), so its close waits for the manager; the clause the words said it in.
   */
  closeAgainstWords?: string;
}

/** The mock office as the executor reads it: guides, team docs, sheets, channels, tweets and tickets. */
export interface MockSurfaceSnapshot {
  /** Available how-to-update guides - agent reads these to know action shape. */
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
  /**
   * What the documentation selection chose for this snapshot's guides and team documents
   * (wave 14, 14-R): present only when a real-mode caller asked for a selection; mock mode and
   * the frozen evaluation read the whole mirror and carry none (R3).
   */
  documentation?: DocumentationSelectionRecord;
}

/** A stored block a cite line stands for, as it read when it was cited. */
export interface CitedBlock {
  /** The `docBlocks` row id. */
  readonly id: string;
  /** The block's hash then (`docBlocks.hash`): a block rewritten in place keeps its id, not this. */
  readonly hash?: string;
}

/** One cite line of a selection: its words and the stored blocks under it. */
export interface DocumentationCitation {
  /** The words inside the brackets of `[cite: <source>/<page>#<heading path>]`. */
  readonly label: string;
  /** The source the page is of (`docSources` id); absent for an office page with no source. */
  readonly sourceId?: string;
  /** The page's ref within its source. */
  readonly pageRef?: string;
  readonly blocks: readonly CitedBlock[];
  /** Set when the cite line was printed `[conflict]`: what the passage is disputed by. */
  readonly conflict?: CiteConflict;
}

/** What one documentation selection put in a prompt, for the record and the plan's cites. */
export interface DocumentationSelectionRecord {
  /** The model call site the selection was made for (`DOCUMENTATION_SITES`). */
  readonly site: 'plan' | 'execute' | 'closing';
  /** Every stored block the prompt carries, in prompt order. */
  readonly blockIds: readonly string[];
  /** The documentation's characters as the prompt renders it. */
  readonly chars: number;
  readonly citations: readonly DocumentationCitation[];
}

/** How many items an employee works at once while the autonomy switch is off. */
export const COLD_START_WIP_LIMIT = 1;
/** How many items an employee works at once with the autonomy switch on. */
export const AUTONOMOUS_WIP_LIMIT = 3;
/** The value score below which the evaluator skips a candidate as not worth the work. */
export const VALUE_THRESHOLD = 30;

/** Prefix of the skip reason the quality-fit filter writes. */
export const QUALITY_FIT_SKIP_PREFIX = 'quality-fit-fail: ';
/** Prefix of the skip reason the scope judgement writes. */
export const OUT_OF_SCOPE_SKIP_PREFIX = 'out-of-scope: ';
/** The defer reason of an item whose scope call gave no judgement (E-70). */
export const SCOPE_JUDGEMENT_UNAVAILABLE = 'scope-judgement-unavailable';
/** Prefix of the skip reason for an item another employee of the owner holds. */
export const CLAIMED_BY_COLLEAGUE_SKIP_PREFIX = 'claimed-by-colleague: ';
