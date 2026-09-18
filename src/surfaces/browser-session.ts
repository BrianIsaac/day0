import type { MockAction } from '../work/types';
import { parseSurfaceAction } from './policy';
import type { ActionAuthority, AppliedAction, SessionRecipeStep, SessionRestoreStep } from './types';

export type { SessionRecipeStep } from './types';

/**
 * Re-establishing a browser session in a new apply invocation.
 *
 * A run's phases are separate apply invocations, and each one opens a new MCP
 * session, which the driver under `--isolated` answers with a new browser
 * context: blank and signed out. The page a person would still have open is
 * rebuilt from the run's own landed rows on the surface, and from nothing
 * else: the navigate before the sign-in, the sign-in itself, and the page the
 * run last navigated to. Nothing that changed the system is ever replayed.
 */

/** Earlier rows of a run, actions and their ledger rows index-aligned. */
export interface EarlierRows {
  actions: readonly (MockAction | undefined)[];
  applied: readonly (AppliedAction | undefined)[];
}

/** `{{secret}}`, or its qualified form, anywhere in a tool's arguments. */
const SECRET_PLACEHOLDER = /\{\{\s*secret(?:[:.][A-Za-z0-9_-]+)?\s*\}\}/;

interface BrowserRow {
  action: MockAction;
  tool: string;
  toolArgsJson: string;
  key: string;
  runId: string;
  index: number;
  /** Order within the index: a replay step before the row it preceded. */
  sub: number;
  replayOf: string;
  authority?: ActionAuthority;
}

function landed(row: AppliedAction | undefined): row is AppliedAction {
  return row?.ok === true && row.held !== true && row.awaitingApproval !== true;
}

/** The run and the durable position a run key names: `<item>:<run>:<index>[.session-<n>]`. */
function keyPosition(key: string): { runId: string; index: number; sub: number } | undefined {
  const parts = key.split(':');
  if (parts.length !== 3 || parts[1] === '') return undefined;
  const position = /^(\d+)(?:\.session-(\d+))?$/.exec(parts[2]!);
  if (!position) return undefined;
  return {
    runId: parts[1]!,
    index: Number(position[1]),
    sub: position[2] === undefined ? Number.POSITIVE_INFINITY : Number(position[2]),
  };
}

function browserRow(
  slug: string,
  action: MockAction | undefined,
  row: AppliedAction | undefined,
  replayOf?: string,
): BrowserRow | undefined {
  if (!action || !landed(row)) return undefined;
  const parsed = parseSurfaceAction(action);
  if (!parsed.ok || parsed.action.kind !== 'mcp.call' || parsed.action.surface !== slug) {
    return undefined;
  }
  const position = keyPosition(row.idempotencyKey);
  if (!position) return undefined;
  return {
    action,
    tool: parsed.action.tool,
    toolArgsJson: action.args.toolArgsJson ?? '',
    key: row.idempotencyKey,
    ...position,
    replayOf: replayOf ?? row.idempotencyKey,
    ...(row.authority ? { authority: row.authority } : {}),
  };
}

/**
 * The landed browser rows on one surface, a replay an earlier invocation
 * recorded counted as the calls it made.
 */
function landedBrowserRows(slug: string, earlier: EarlierRows): BrowserRow[] {
  const rows: BrowserRow[] = [];
  earlier.applied.forEach((row, index): void => {
    for (const step of (row?.sessionRestore?.steps ?? []) as SessionRestoreStep[]) {
      const replayed = browserRow(slug, step.action, step, step.replayOf);
      if (replayed) rows.push(replayed);
    }
    const own = browserRow(slug, earlier.actions[index], row);
    if (own) rows.push(own);
  });
  return rows;
}

/**
 * The rows of the run that last touched the surface, once each, in the order
 * they were sent. A retry's prerequisite ledger carries an earlier run's
 * landed writes ahead of its own rows, and a resumed closing set carries the
 * previous attempt's rows twice; either read in input order would replay a
 * sign-in onto a page that is not there.
 */
function latestRunRows(rows: readonly BrowserRow[]): BrowserRow[] {
  const latest = rows.at(-1)?.runId;
  if (latest === undefined) return [];
  const byKey = new Map<string, BrowserRow>();
  for (const row of rows) if (row.runId === latest && !byKey.has(row.key)) byKey.set(row.key, row);
  return [...byKey.values()].sort((a, b) => a.index - b.index || a.sub - b.sub);
}

const isNavigate = (row: BrowserRow): boolean => row.tool === 'browser_navigate';
const isCredentialFill = (row: BrowserRow): boolean =>
  row.tool === 'browser_fill_form' && SECRET_PLACEHOLDER.test(row.toolArgsJson);

/**
 * Whether an action types the surface's credential into a form: a sign-in.
 *
 * Args:
 *   action: The action, if any.
 *   slug: The browser-driven surface.
 *
 * Returns:
 *   True for a `browser_fill_form` on the surface that carries `{{secret}}`.
 */
export function signsIn(action: MockAction | undefined, slug: string): boolean {
  if (!action) return false;
  const parsed = parseSurfaceAction(action);
  return (
    parsed.ok &&
    parsed.action.kind === 'mcp.call' &&
    parsed.action.surface === slug &&
    parsed.action.tool === 'browser_fill_form' &&
    SECRET_PLACEHOLDER.test(action.args.toolArgsJson ?? '')
  );
}

/**
 * The positions of the run's last sign-in: its credential fills, each with
 * the click directly after it. A sign-in that spans two pages is one run of
 * fill and click pairs; a run that signed in twice restores the later one.
 */
function lastSignIn(rows: readonly BrowserRow[]): number[] {
  let last = -1;
  rows.forEach((row, position): void => {
    if (isCredentialFill(row)) last = position;
  });
  if (last < 0) return [];
  const withClick = (fill: number): number[] =>
    rows[fill + 1]?.tool === 'browser_click' ? [fill, fill + 1] : [fill];
  const picked = withClick(last);
  let first = last;
  while (first >= 2 && rows[first - 1]!.tool === 'browser_click' && isCredentialFill(rows[first - 2]!)) {
    first -= 2;
    picked.unshift(first, first + 1);
  }
  return picked;
}

/**
 * What re-establishes a browser page in a new invocation of a run.
 *
 * Read from the run's earlier rows on one browser-driven surface, landed
 * only: the `browser_navigate` immediately before the sign-in, every
 * `browser_fill_form` that carries the `{{secret}}` placeholder and the
 * `browser_click` directly after each, and the last `browser_navigate` when
 * it came after the sign-in. With no earlier navigate the surface's endpoint
 * is opened first. Never a fill without the placeholder, never another click,
 * never a snapshot: nothing that changed the system is sent twice.
 *
 * Args:
 *   slug: The browser-driven surface.
 *   earlier: The run's earlier rows, from its prerequisite ledger and the
 *     rows this phase carries before the action that needs the page.
 *   endpoint: The surface's documented page.
 *
 * Returns:
 *   The calls to replay, in order, each with the row it repeats.
 */
export function sessionRecipe(
  slug: string,
  earlier: EarlierRows,
  endpoint: string | undefined,
): SessionRecipeStep[] {
  const rows = latestRunRows(landedBrowserRows(slug, earlier));
  const signIn = lastSignIn(rows);
  let navigateBefore = -1;
  if (signIn.length > 0) {
    for (let position = signIn[0]! - 1; position >= 0; position -= 1) {
      if (isNavigate(rows[position]!)) {
        navigateBefore = position;
        break;
      }
    }
  }
  const lastReplayed = signIn.at(-1) ?? -1;
  let lastNavigate = -1;
  rows.forEach((row, position): void => {
    if (isNavigate(row)) lastNavigate = position;
  });
  const positions = [
    ...(navigateBefore >= 0 ? [navigateBefore] : []),
    ...signIn,
    ...(lastNavigate > lastReplayed && lastNavigate !== navigateBefore ? [lastNavigate] : []),
  ];
  const steps: SessionRecipeStep[] = positions.map((position): SessionRecipeStep => {
    const row = rows[position]!;
    return {
      action: row.action,
      replayOf: row.replayOf,
      ...(row.authority ? { authority: row.authority } : {}),
    };
  });
  const opensPage = steps[0] !== undefined && steps[0].action.args.tool === 'browser_navigate';
  if (opensPage || !endpoint) return steps;
  return [
    {
      action: {
        tool: 'mcp.call',
        args: { surface: slug, tool: 'browser_navigate', toolArgsJson: JSON.stringify({ url: endpoint }) },
      },
    },
    ...steps,
  ];
}
