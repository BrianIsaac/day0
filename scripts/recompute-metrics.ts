/**
 * Recompute one owner's supervision figures from a Convex snapshot export,
 * with the product's own functions (`convex/metrics.ts`):
 *
 *   pnpm metrics:recompute <export.zip | export-directory> [--owner <subject>] [--expect <file.json>]
 *
 * The rows are grouped by agent and the owner's employees are chosen as
 * `metrics:forOwner` chooses them (evaluation agents and baseline arms left
 * out), so the JSON printed first is the shape the query returns, field for
 * field. The event timeline follows, anchored on the owner's first
 * documentation sync, offsets floored to the second.
 *
 * `--owner` defaults to the no-auth subject every local bed runs as. With
 * `--expect`, every field the file names must equal the recomputed one; a
 * file holding the query's whole result compares every field. Exit 0: the
 * figures (and every expectation) hold; 1: an expectation differs, each
 * difference printed; 2: usage, or an input that is not a readable export.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Doc } from '../convex/_generated/dataModel';
import { DEV_NO_AUTH_SUBJECT } from '../convex/devAuth';
import {
  computeCompanyMetrics,
  selectCompanyEmployees,
  type EmployeeRecords,
  type OwnerMetrics,
} from '../convex/metrics';
import { exportEntries, exportRows } from './convex-export';

const USAGE =
  'Usage: pnpm metrics:recompute <export.zip|export-directory> [--owner <subject>] [--expect <file.json>]';

const METRIC_TABLES = ['agents', 'events', 'workItems', 'charters'] as const;
const TIMELINE_TABLES = ['docSources', 'docSyncRuns'] as const;

/** The events the timeline names: the run's milestones, as page 12 quotes them. */
const TIMELINE_EVENTS = new Set([
  'agent.deployed',
  'charter.drafted',
  'charter.approved',
  'surface.connected',
  'skill.registered',
  'skill.failed',
  'work.plan-approved',
  'agent.autonomy-changed',
  'work.failed',
  'work.retry',
  'work.actions-approved',
  'work.completed',
  'work.provider-reconciled',
]);

export interface TimelineRow {
  at: number;
  /** Milliseconds after the anchor. */
  offsetMs: number;
  employee: string;
  eventId: string;
  type: string;
  /** The skill, work item or scope the event is about, when it names one. */
  tag: string;
}

export interface Recomputed {
  owner: string;
  figures: OwnerMetrics;
  /** The first documentation sync of the owner's sources, else the first named event. */
  anchor: { at: number; source: 'documentation sync' | 'first event' } | null;
  timeline: TimelineRow[];
}

interface Io {
  log(line: string): void;
  error(line: string): void;
}

function groupByAgent<Row extends { agentId: string }>(rows: readonly Row[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>();
  for (const row of rows) groups.set(row.agentId, [...(groups.get(row.agentId) ?? []), row]);
  return groups;
}

function eventTag(event: Doc<'events'>): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const name = typeof payload.name === 'string' ? payload.name : undefined;
  const workItemId = typeof payload.workItemId === 'string' ? payload.workItemId : undefined;
  const scope = typeof payload.scope === 'string' ? payload.scope : undefined;
  return name ?? workItemId?.slice(0, 8) ?? scope ?? '';
}

/**
 * Recompute the figures of one owner's company from an export.
 *
 * Args:
 *   path: The export ZIP or its extracted directory.
 *   options: `owner`, the subject whose company is recomputed; the no-auth
 *     subject when absent.
 *
 * Returns:
 *   The figures as `metrics:forOwner` returns them, and the timeline.
 *
 * Raises:
 *   Error: The path is not a readable Convex export, or lacks a table the
 *     figures are computed from.
 */
export function recomputeFromExport(path: string, options: { owner?: string } = {}): Recomputed {
  const owner = options.owner ?? DEV_NO_AUTH_SUBJECT;
  const entries = exportEntries(path, new Set([...METRIC_TABLES, ...TIMELINE_TABLES]));
  const required = <Row>(table: (typeof METRIC_TABLES)[number]): Row[] => {
    const rows = exportRows(entries, table);
    if (!rows) throw new Error(`the export has no ${table} table; is this a Convex export?`);
    return rows as Row[];
  };
  const agents = required<Doc<'agents'>>('agents');
  const events = groupByAgent(required<Doc<'events'>>('events'));
  const workItems = groupByAgent(required<Doc<'workItems'>>('workItems'));
  const charters = groupByAgent(required<Doc<'charters'>>('charters'));

  const selection = selectCompanyEmployees(agents, owner);
  const records: EmployeeRecords[] = selection.employees.map((agent) => ({
    agent,
    events: events.get(agent._id) ?? [],
    workItems: workItems.get(agent._id) ?? [],
    charters: charters.get(agent._id) ?? [],
  }));
  const figures = computeCompanyMetrics(records, selection);

  const sources = (exportRows(entries, 'docSources') ?? []) as Doc<'docSources'>[];
  const ownSources = new Set(sources.filter((row) => row.userId === owner).map((row) => row._id));
  const syncStarts = ((exportRows(entries, 'docSyncRuns') ?? []) as Doc<'docSyncRuns'>[])
    .filter((run) => ownSources.has(run.sourceId))
    .map((run) => run.createdAt);
  const named = records
    .flatMap((record) =>
      record.events
        .filter((event) => TIMELINE_EVENTS.has(event.type))
        .map((event) => ({ event, employee: record.agent.name })),
    )
    .sort(
      (left, right) =>
        left.event.createdAt - right.event.createdAt || (left.event._id < right.event._id ? -1 : 1),
    );
  const anchor =
    syncStarts.length > 0
      ? { at: Math.min(...syncStarts), source: 'documentation sync' as const }
      : named.length > 0
        ? { at: named[0].event.createdAt, source: 'first event' as const }
        : null;
  const timeline = named.map(({ event, employee }) => ({
    at: event.createdAt,
    offsetMs: event.createdAt - (anchor?.at ?? event.createdAt),
    employee,
    eventId: event._id,
    type: event.type,
    tag: eventTag(event),
  }));
  return { owner, figures, anchor, timeline };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Every field an expectation names that the recomputed figures do not match.
 *
 * Objects are compared on the keys the expectation names; arrays must have
 * the expected length and match element by element; anything else must be
 * identical.
 *
 * Args:
 *   expected: The expectation, or the part of it under `path`.
 *   actual: The recomputed value at the same path.
 *   path: The dotted path so far.
 *
 * Returns:
 *   One line per differing field, empty when every field holds.
 */
export function expectationDifferences(expected: unknown, actual: unknown, path = ''): string[] {
  const at = path === '' ? '(root)' : path;
  const child = (key: string | number): string => (path === '' ? String(key) : `${path}.${key}`);
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return [`${at}: expected a list, got ${JSON.stringify(actual)}`];
    if (expected.length !== actual.length) {
      return [`${at}: expected ${expected.length} entries, got ${actual.length}`];
    }
    return expected.flatMap((value, index) =>
      expectationDifferences(value, actual[index], child(index)),
    );
  }
  if (isRecord(expected)) {
    if (!isRecord(actual)) return [`${at}: expected an object, got ${JSON.stringify(actual)}`];
    return Object.keys(expected).flatMap((key) =>
      Object.hasOwn(actual, key)
        ? expectationDifferences(expected[key], actual[key], child(key))
        : [`${child(key)}: expected ${JSON.stringify(expected[key])}, not in the figures`],
    );
  }
  return Object.is(expected, actual)
    ? []
    : [`${at}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`];
}

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1_000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

function timelineLines({ owner, figures, anchor, timeline }: Recomputed): string[] {
  const utc = (at: number): string => new Date(at).toISOString().slice(11, 23);
  const width = Math.max(0, ...timeline.map((row) => row.employee.length));
  return [
    `owner ${owner}: ${count(figures.company.employees, 'employee')}, ${count(figures.excludedAgents, 'evaluation agent')} set aside, ${figures.omittedEmployees} omitted`,
    anchor
      ? `anchor ${new Date(anchor.at).toISOString()} (${anchor.source})`
      : 'anchor none: no documentation sync and no named event',
    ...timeline.map((row) =>
      `${utc(row.at)} ${clock(row.offsetMs).padStart(5)} ${row.employee.padEnd(width)} ${row.eventId.slice(0, 8)} ${row.type.padEnd(26)} ${row.tag}`.trimEnd(),
    ),
  ];
}

function parseArguments(
  argv: readonly string[],
): { path: string; owner?: string; expect?: string } | undefined {
  let path: string | undefined;
  let owner: string | undefined;
  let expect: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--owner' || argument === '--expect') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (argument === '--owner') owner = value;
      else expect = value;
      index += 1;
    } else if (argument.startsWith('--') || path !== undefined) {
      return undefined;
    } else {
      path = argument;
    }
  }
  return path === undefined ? undefined : { path, owner, expect };
}

/**
 * Run the command line.
 *
 * Args:
 *   argv: The arguments after the script's own path.
 *   io: Where the figures and the timeline go (`log`) and where refusals and
 *     differences go (`error`).
 *
 * Returns:
 *   The exit code: 0 held, 1 an expectation differs, 2 usage or input.
 */
export function runRecompute(argv: readonly string[], io: Io = console): number {
  const options = parseArguments(argv);
  if (!options) {
    io.error(USAGE);
    return 2;
  }
  let recomputed: Recomputed;
  let expected: unknown;
  try {
    recomputed = recomputeFromExport(options.path, { owner: options.owner });
    if (options.expect !== undefined) expected = JSON.parse(readFileSync(options.expect, 'utf8'));
  } catch (error) {
    io.error(`Recompute failed: ${(error as Error).message}`);
    return 2;
  }
  io.log(JSON.stringify(recomputed.figures, null, 2));
  for (const line of timelineLines(recomputed)) io.log(line);
  if (options.expect === undefined) return 0;
  const differences = expectationDifferences(expected, recomputed.figures);
  for (const line of differences) io.error(line);
  if (differences.length > 0) return 1;
  io.log(`every figure in ${options.expect} holds`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runRecompute(process.argv.slice(2));
}
