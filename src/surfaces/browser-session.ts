import type { MockAction } from '../work/types';
import {
  isCredentialField,
  isInterstitialControl,
  isLoginNameField,
  NEXT_CONTROL,
  SIGN_IN_CONTROL,
} from './browser';
import { parseSurfaceAction } from './policy';
import type {
  ActionAuthority,
  AppliedAction,
  SessionRecipeStep,
  SessionRestoreStep,
} from './types';

export type { SessionRecipeStep } from './types';

export class IncompleteSignInError extends Error {
  constructor() {
    super('incomplete sign-in');
  }
}

/**
 * Re-establishing a browser session in a new apply invocation.
 *
 * A run's phases are separate apply invocations, and each one opens a new MCP
 * session, which the driver under `--isolated` answers with a new browser
 * context: blank and signed out. The page a person would still have open is
 * rebuilt from the run's own landed rows on the surface: the navigate before
 * a completed sign-in, the credential form and its submit control, and the
 * page the run last navigated to.
 */

/** Earlier rows of a run, actions and their ledger rows index-aligned. */
export interface EarlierRows {
  actions: readonly (MockAction | undefined)[];
  applied: readonly (AppliedAction | undefined)[];
}

/** `{{secret}}`, or its qualified form, in a credential field's value. */
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
 * The run's own rows, once each, in the order they were sent. A retry's
 * prerequisite ledger carries earlier runs' landed writes; those must not
 * lend a new run their sign-in authority. A retry that resumes at the closing
 * phase adopts the prerequisite ledger it carries as its own, so the runs
 * that ledger was landed under count as this run's. A resumed closing set
 * carries those rows twice (as landed writes and as its ledger), so
 * duplicate keys are ignored.
 */
function ownRunRows(rows: readonly BrowserRow[], runIds: ReadonlySet<string>): BrowserRow[] {
  const byKey = new Map<string, BrowserRow>();
  for (const row of rows) if (runIds.has(row.runId) && !byKey.has(row.key)) byKey.set(row.key, row);
  return [...byKey.values()].sort((a, b) => a.index - b.index || a.sub - b.sub);
}

/**
 * The runs a ledger's rows were landed under, read from their keys.
 *
 * Args:
 *   applied: A ledger's rows.
 *
 * Returns:
 *   Each run id once, in the order first seen.
 */
export function ledgerRunIds(applied: readonly (AppliedAction | undefined)[]): string[] {
  const runIds = new Set<string>();
  for (const row of applied) {
    const position = row ? keyPosition(row.idempotencyKey) : undefined;
    if (position) runIds.add(position.runId);
  }
  return [...runIds];
}

const isNavigate = (row: BrowserRow): boolean => row.tool === 'browser_navigate';
/** Calls that look at the page and change nothing on it, so the replay steps past them. */
const BROWSER_READS = new Set(['browser_snapshot', 'browser_hover', 'browser_wait_for']);
const isCredentialFill = (row: BrowserRow): boolean =>
  signsIn(row.action, String(row.action.args.surface));
/** A fill of a login form's fields, with or without the credential: the first page of a two-page sign-in. */
const isLoginFill = (row: BrowserRow): boolean =>
  loginFill(row.action, String(row.action.args.surface)) !== undefined;

function directlyAfter(before: BrowserRow | undefined, after: BrowserRow | undefined): boolean {
  if (!before || !after || before.runId !== after.runId) return false;
  if (Number.isFinite(before.sub)) {
    return after.index === before.index && after.sub === before.sub + 1;
  }
  return after.sub === Number.POSITIVE_INFINITY && after.index === before.index + 1;
}

function clickName(row: BrowserRow | undefined): string | undefined {
  if (row?.tool !== 'browser_click') return undefined;
  try {
    const args: unknown = JSON.parse(row.toolArgsJson);
    if (!args || typeof args !== 'object') return undefined;
    const element = (args as Record<string, unknown>).element;
    return typeof element === 'string' ? element.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a `browser_fill_form` on the surface types into a login form, or
 * undefined when it fills anything else.
 *
 * Every field is the form's account field or its credential field, and the
 * credential sits only in a credential field: the same names the apply admits
 * `{{secret}}` into, so a fill it would refuse is never taken for a sign-in.
 */
function loginFill(
  action: MockAction | undefined,
  slug: string,
): { carriesSecret: boolean } | undefined {
  if (!action) return undefined;
  const parsed = parseSurfaceAction(action);
  if (
    !parsed.ok ||
    parsed.action.kind !== 'mcp.call' ||
    parsed.action.surface !== slug ||
    parsed.action.tool !== 'browser_fill_form'
  )
    return undefined;
  const fields = parsed.action.toolArgs.fields;
  if (!Array.isArray(fields) || fields.length === 0) return undefined;
  let carriesSecret = false;
  for (const field of fields) {
    if (!field || typeof field !== 'object' || Array.isArray(field)) return undefined;
    const name = (field as Record<string, unknown>).name;
    const value = (field as Record<string, unknown>).value;
    if (typeof value !== 'string') return undefined;
    const secret = SECRET_PLACEHOLDER.test(value);
    if (isCredentialField(name)) carriesSecret ||= secret;
    else if (secret || !isLoginNameField(name)) return undefined;
  }
  return { carriesSecret };
}

/**
 * Whether an action types the surface's credential into a login form.
 *
 * Args:
 *   action: The action, if any.
 *   slug: The browser-driven surface.
 *
 * Returns:
 *   True for a `browser_fill_form` on the surface whose credential field
 *   carries `{{secret}}` and whose other fields name the account.
 */
export function signsIn(action: MockAction | undefined, slug: string): boolean {
  return loginFill(action, slug)?.carriesSecret === true;
}

/**
 * The positions of the run's last completed sign-in. A two-page sign-in may
 * have a Next control after a fill of the account field; its final control
 * must submit the login. A run that signed in twice restores the later one.
 */
function lastSignIn(rows: readonly BrowserRow[]): number[] {
  let last = -1;
  rows.forEach((row, position): void => {
    if (
      isCredentialFill(row) &&
      directlyAfter(row, rows[position + 1]) &&
      SIGN_IN_CONTROL.test(clickName(rows[position + 1]) ?? '')
    ) {
      last = position;
    }
  });
  if (last < 0) return [];
  const picked = [last, last + 1];
  let first = last;
  while (
    first >= 2 &&
    directlyAfter(rows[first - 2], rows[first - 1]) &&
    directlyAfter(rows[first - 1], rows[first]) &&
    NEXT_CONTROL.test(clickName(rows[first - 1]) ?? '') &&
    isLoginFill(rows[first - 2]!)
  ) {
    first -= 2;
    picked.unshift(first, first + 1);
  }
  return picked;
}

/**
 * The clicks that carried a sign-in to the page the run went on to open.
 *
 * A login often ends on a cookie banner, a "stay signed in" question or a
 * notice the run dismissed before it navigated; without them the replayed
 * session stops on that page. Every landed click on such a control
 * (`INTERSTITIAL_CONTROL`) after the sign-in and before the last navigate is
 * replayed, with any navigate between them so each click meets the page it
 * was made on, until the run's first write of its own: a fill, a keystroke
 * or a click on any other control (an Approve, an Archive, a Save) is work,
 * and replaying it would do that work again with nobody asked.
 */
function clicksAfterSignIn(
  rows: readonly BrowserRow[],
  signedInAt: number,
  lastNavigate: number,
): number[] {
  const steps: number[] = [];
  for (let position = signedInAt + 1; position < lastNavigate; position += 1) {
    const row = rows[position]!;
    if (isNavigate(row) || isInterstitialControl(clickName(row) ?? '')) steps.push(position);
    else if (!BROWSER_READS.has(row.tool)) break;
  }
  return steps;
}

/**
 * What re-establishes a browser page in a new invocation of a run.
 *
 * Read from the run's earlier rows on one browser-driven surface, landed
 * only: the `browser_navigate` immediately before the last completed sign-in,
 * its credential fills and login controls, the clicks that carried it on to
 * the next page (`clicksAfterSignIn`), and the last `browser_navigate` when it
 * came after the sign-in. With no earlier navigate the surface's
 * endpoint is opened first. An incomplete sign-in refuses restoration rather
 * than typing a credential into a page without submitting it.
 *
 * Args:
 *   slug: The browser-driven surface.
 *   earlier: The run's earlier rows, from its prerequisite ledger and the
 *     rows this phase carries before the action that needs the page.
 *   endpoint: The surface's documented page.
 *   runId: The run being applied; rows from earlier attempts are excluded.
 *   resumedRunIds: The runs whose prerequisite ledger this run resumed at
 *     its closing phase; their rows count as this run's.
 *
 * Returns:
 *   The calls to replay, in order, each with the row it repeats.
 */
export function sessionRecipe(
  slug: string,
  earlier: EarlierRows,
  endpoint: string | undefined,
  runId: string,
  resumedRunIds: readonly string[] = [],
): SessionRecipeStep[] {
  const rows = ownRunRows(landedBrowserRows(slug, earlier), new Set([runId, ...resumedRunIds]));
  const signIn = lastSignIn(rows);
  if (signIn.length === 0 && rows.some(isCredentialFill)) {
    throw new IncompleteSignInError();
  }
  let navigateBefore = -1;
  if (signIn.length > 0) {
    for (let position = signIn[0]! - 1; position >= 0; position -= 1) {
      if (isNavigate(rows[position]!)) {
        navigateBefore = position;
        break;
      }
    }
  }
  const signedInAt = signIn.at(-1) ?? -1;
  let lastNavigate = -1;
  rows.forEach((row, position): void => {
    if (isNavigate(row)) lastNavigate = position;
  });
  const navigatesAfter = lastNavigate > signedInAt && lastNavigate !== navigateBefore;
  const positions = [
    ...(navigateBefore >= 0 ? [navigateBefore] : []),
    ...signIn,
    ...(signIn.length > 0 && navigatesAfter
      ? clicksAfterSignIn(rows, signedInAt, lastNavigate)
      : []),
    ...(navigatesAfter ? [lastNavigate] : []),
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
        args: {
          surface: slug,
          tool: 'browser_navigate',
          toolArgsJson: JSON.stringify({ url: endpoint }),
        },
      },
    },
    ...steps,
  ];
}
