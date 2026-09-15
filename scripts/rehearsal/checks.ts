/**
 * The five checks, each a pure function over the work item as the backend
 * stores it, reading the same rows the replay test asserts
 * (`tests/convex/real-mode-replay.test.ts`).
 */

export interface LedgerRow {
  tool: string;
  ok: boolean;
  held?: boolean;
  awaitingApproval?: boolean;
  authority?: string;
  effect?: string;
  reason?: string;
  providerId?: string;
  repair?: { reason: string; toolArgsJson: string };
}

export interface ActionView {
  tool: string;
  args: { surface?: string; tool?: string; toolArgsJson?: string; path?: string; body?: string };
}

export interface WorkItemView {
  state: string;
  plan?: { steps: string[]; advisorySteps?: number[] };
  actionVerdicts?: Array<{ disposition: 'auto' | 'held' | 'refused' }>;
  output?: {
    actions?: ActionView[];
    applied?: LedgerRow[];
    initial?: { actions?: ActionView[]; applied?: LedgerRow[] };
    planStepOutcomes?: Array<{ status: string }>;
  };
}

export interface CheckResult {
  check: string;
  passed: boolean;
  detail: string;
  /** The rows the verdict was read from, written beside the summary. */
  rows: unknown;
}

/** A verification verb paired with a property the data may not carry. */
export const OWNERSHIP_GATE =
  /\b(confirm|verify|check|ensure|validate|make sure|establish)\b[^.]*\b(owned|owner|ownership|assigned|assignee|prioriti[sz]ed|priority)\b/i;

const BROWSER_ORDER = [
  'browser_navigate',
  'browser_fill_form',
  'browser_click',
  'browser_fill_form',
  'browser_click',
  'browser_snapshot',
];

function mcpTool(action: ActionView | undefined): string | undefined {
  return action?.tool === 'mcp.call' ? action.args.tool : undefined;
}

function mcpArgs(action: ActionView | undefined): Record<string, unknown> {
  try {
    return JSON.parse(action?.args.toolArgsJson ?? '{}') as Record<string, unknown>;
  } catch {
    return {};
  }
}

/**
 * Check 1: the drafted plan carries no verification of a candidate property.
 *
 * Args:
 *   item: The work item at `plan-pending` or later.
 *
 * Returns:
 *   The verdict.
 */
export function checkPlanWithoutOwnershipGate(item: WorkItemView): CheckResult {
  const check = 'plan-without-ownership-gate';
  const plan = item.plan;
  if (!plan) return { check, passed: false, detail: 'no plan on the item', rows: null };
  const gated = plan.steps
    .map((step: string, index: number): number => (OWNERSHIP_GATE.test(step) ? index + 1 : 0))
    .filter(Boolean);
  if (gated.length > 0) {
    return {
      check,
      passed: false,
      detail: `step ${gated.join(', ')} verifies a candidate property: "${plan.steps[gated[0]! - 1]}"`,
      rows: plan,
    };
  }
  if (plan.advisorySteps?.length) {
    return {
      check,
      passed: false,
      detail: `the audit had to mark step ${plan.advisorySteps.join(', ')} advisory after its one repair`,
      rows: plan,
    };
  }
  return {
    check,
    passed: true,
    detail: `${plan.steps.length} plan steps, none verifying ownership or priority, none advisory`,
    rows: plan,
  };
}

export interface BrowserRow {
  index: number;
  tool: string;
  disposition: string;
}

/**
 * The phase-one actions on the browser-driven surface with their verdicts.
 *
 * Args:
 *   item: The parked work item.
 *   tileSlug: The surface's slug.
 *
 * Returns:
 *   One row per action on that surface, in emitted order.
 */
export function browserSequenceOf(item: WorkItemView, tileSlug: string): BrowserRow[] {
  const actions = item.output?.actions ?? [];
  return actions.flatMap((action: ActionView, index: number): BrowserRow[] =>
    action.tool === 'mcp.call' && action.args.surface === tileSlug
      ? [
          {
            index,
            tool: action.args.tool ?? '',
            disposition: item.actionVerdicts?.[index]?.disposition ?? 'unknown',
          },
        ]
      : [],
  );
}

/**
 * Check 2: phase one holds the whole tile sequence behind the read.
 *
 * Args:
 *   item: The work item parked at `actions-pending` after phase one.
 *   tileSlug: The browser-driven surface's slug.
 *
 * Returns:
 *   The verdict.
 */
export function checkBrowserBatchHeldWhole(item: WorkItemView, tileSlug: string): CheckResult {
  const check = 'browser-batch-held-whole';
  const rows = browserSequenceOf(item, tileSlug);
  const evidence = { rows, verdicts: item.actionVerdicts ?? [] };
  if (rows.length === 0) {
    return { check, passed: false, detail: `phase one emitted no action on ${tileSlug}`, rows: evidence };
  }
  const notHeld = rows.filter((row: BrowserRow): boolean => row.disposition !== 'held');
  if (notHeld.length > 0) {
    return {
      check,
      passed: false,
      detail: `${notHeld.length} of ${rows.length} tile actions not held (${notHeld.map((row) => `${row.tool}: ${row.disposition}`).join(', ')})`,
      rows: evidence,
    };
  }
  const tools = rows.map((row: BrowserRow): string => row.tool);
  const runbookOrder = BROWSER_ORDER.every((tool: string, index: number): boolean => tools[index] === tool);
  if (!runbookOrder) {
    return {
      check,
      passed: false,
      detail: `tile actions held but not the runbook sequence: ${tools.join(', ')}`,
      rows: evidence,
    };
  }
  return {
    check,
    passed: true,
    detail: `${rows.length} tile actions held as one browser session behind the auto read`,
    rows: evidence,
  };
}

/**
 * Check 3: a read the provider refused for its arguments was repaired once,
 * when that happened at all.
 *
 * Args:
 *   item: The work item parked after phase one.
 *
 * Returns:
 *   The verdict; passing with "not needed" when every read landed first time.
 */
export function checkWrongKeyReadRepaired(item: WorkItemView): CheckResult {
  const check = 'wrong-key-read-repaired-once';
  const actions = item.output?.actions ?? [];
  const applied = item.output?.applied ?? [];
  const reads = applied.flatMap((row: LedgerRow, index: number) => {
    const tool = mcpTool(actions[index]);
    return tool && /^(get|list|read|fetch|show)_/.test(tool) ? [{ index, tool, row }] : [];
  });
  const repaired = reads.filter((read) => read.row.repair);
  const failed = reads.filter((read) => !read.row.ok && !read.row.held);
  if (failed.length > 0) {
    return {
      check,
      passed: false,
      detail: `${failed.map((read) => `${read.tool}: ${read.row.reason ?? 'failed'}`).join('; ')}`,
      rows: reads,
    };
  }
  if (repaired.length > 1) {
    return { check, passed: false, detail: `${repaired.length} reads carry a repair; one is the bound`, rows: reads };
  }
  if (repaired.length === 1) {
    const read = repaired[0]!;
    return {
      check,
      passed: true,
      detail: `${read.tool} repaired once after the provider refused ${read.row.repair!.toolArgsJson} (${read.row.repair!.reason}); landed under ${read.row.authority ?? 'unknown'} authority`,
      rows: reads,
    };
  }
  return {
    check,
    passed: true,
    detail: `not needed: ${reads.length} read(s) landed with the probed key first time`,
    rows: reads,
  };
}

export interface ReadBack {
  figure: string;
  auditLine: string;
}

/**
 * The figure and audit line the tile snapshot read back, out of the phase-one ledger.
 *
 * Args:
 *   item: The work item parked at the closing phase.
 *
 * Returns:
 *   The read-back, or undefined when no snapshot row carries both.
 */
export function readBackOf(item: WorkItemView): ReadBack | undefined {
  const initial = item.output?.initial;
  const actions = initial?.actions ?? [];
  const applied = initial?.applied ?? [];
  for (let index = applied.length - 1; index >= 0; index -= 1) {
    if (mcpTool(actions[index]) !== 'browser_snapshot') continue;
    const effect = applied[index]?.effect ?? '';
    const figure = /visible figure\s*([0-9]+(?:\.[0-9]+)?%)/i.exec(effect)?.[1];
    const auditLine = /Last updated by [^\n]*?\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/.exec(effect)?.[0];
    if (figure && auditLine) return { figure, auditLine };
  }
  return undefined;
}

/**
 * Check 4: the closing phase holds a ticket comment quoting the read-back.
 *
 * Args:
 *   item: The work item parked at the closing phase.
 *
 * Returns:
 *   The verdict.
 */
export function checkClosingCommentQuotesReadBack(item: WorkItemView): CheckResult {
  const check = 'closing-comment-quotes-read-back';
  const readBack = readBackOf(item);
  const actions = item.output?.actions ?? [];
  const comments = actions.flatMap((action: ActionView, index: number) =>
    mcpTool(action) === 'save_comment'
      ? [{ index, body: String(mcpArgs(action).body ?? ''), disposition: item.actionVerdicts?.[index]?.disposition }]
      : [],
  );
  const rows = { readBack, comments };
  if (!readBack) {
    return { check, passed: false, detail: 'the phase-one snapshot row carries no visible figure and audit line', rows };
  }
  if (comments.length === 0) {
    return { check, passed: false, detail: 'the closing set holds no save_comment', rows };
  }
  const quoting = comments.find(
    (comment) => comment.body.includes(readBack.figure) && comment.body.includes(readBack.auditLine),
  );
  if (!quoting) {
    return {
      check,
      passed: false,
      detail: `no closing comment quotes both "${readBack.figure}" and "${readBack.auditLine}"`,
      rows,
    };
  }
  if (quoting.disposition !== 'held') {
    return {
      check,
      passed: false,
      detail: `the quoting save_comment is ${quoting.disposition ?? 'undecided'}, not held for the manager`,
      rows,
    };
  }
  return {
    check,
    passed: true,
    detail: `held save_comment quotes ${readBack.figure} and "${readBack.auditLine}"`,
    rows,
  };
}

/**
 * Check 5: the run completed and the ticket shows it.
 *
 * Args:
 *   item: The work item after the closing actions applied.
 *   linear: The ticket as read back from Linear: its state and the comments the run added.
 *
 * Returns:
 *   The verdict.
 */
export function checkCompletion(
  item: WorkItemView,
  linear: { stateName: string; newComments: readonly string[] },
): CheckResult {
  const check = 'completion';
  const outcomes = item.output?.planStepOutcomes ?? [];
  const rows = { state: item.state, planStepOutcomes: outcomes, linear };
  if (item.state !== 'completed') {
    return { check, passed: false, detail: `work item state is ${item.state}`, rows };
  }
  const blocked = outcomes.filter((row) => row.status === 'blocked').length;
  if (blocked > 0) return { check, passed: false, detail: `${blocked} plan step(s) blocked`, rows };
  if (linear.stateName !== 'Done') {
    return { check, passed: false, detail: `REVOPS-7 is ${linear.stateName} in Linear, not Done`, rows };
  }
  if (linear.newComments.length === 0) {
    return { check, passed: false, detail: 'REVOPS-7 carries no new comment in Linear', rows };
  }
  return {
    check,
    passed: true,
    detail: `completed; ${outcomes.length} plan step(s) accounted for; REVOPS-7 Done in Linear with ${linear.newComments.length} new comment(s)`,
    rows,
  };
}
