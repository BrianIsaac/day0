/**
 * Recompute one owner's supervision and pilot figures (A9) with the
 * product's own functions (`convex/metrics.ts`), from the owner's exported
 * traces:
 *
 *   pnpm metrics:recompute <trace.json>... [--owner <subject>] [--expect <file.json>] [--json]
 *
 * Each trace is one employee's, as `scripts/export-trace.ts` writes it from
 * the paged export: redacted, dated in the agent's zone, stamped with the
 * release and commit. The owner's employees are chosen as `metrics:forOwner`
 * chooses them (evaluation agents, which a trace flags, and baseline arms
 * left out), so the JSON printed first is the shape the query returns, field
 * for field. A recording made before the trace existed is read from its
 * Convex snapshot export instead (`<export.zip | export-directory>`), the
 * unredacted database, and the output says so.
 *
 * After the figures: the line saying when this recompute ran and what it
 * read (each trace's export date, zone, release and commit), then the event
 * timeline, anchored on the owner's first documentation sync where a
 * snapshot has one and on the first named event otherwise, offsets floored to
 * the second. `--json` emits only the figures so stdout can be saved as a
 * valid JSON file.
 *
 * `--owner` defaults to the traces' own owner, or to the no-auth subject
 * every local bed runs as for a snapshot. With `--expect`, every field the
 * file names must equal the recomputed one; a file holding the query's whole
 * result compares every field. Exit 0: the figures (and every expectation)
 * hold; 1: an expectation differs, each difference printed; 2: usage, or an
 * input that is neither a trace nor a readable export.
 */
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { DEV_NO_AUTH_SUBJECT } from '../convex/devAuth';
import {
  byWriteOrder,
  computeCompanyMetrics,
  isEvaluationAgent,
  selectCompanyEmployees,
  type EmployeeRecords,
  type OwnerMetrics,
} from '../convex/metrics';
import { exportEntries, exportRows } from './convex-export';
import { isAgentTrace, type AgentTrace, type TraceManifest } from '../src/export/trace';
import { isEventType, type EventType } from '../src/events/contract';

const USAGE =
  'Usage: pnpm metrics:recompute <trace.json>... | <export.zip|export-directory> [--owner <subject>] [--expect <file.json>] [--json]';

const METRIC_TABLES = ['agents', 'events', 'workItems', 'charters'] as const;
const TIMELINE_TABLES = ['docSources', 'docSyncRuns'] as const;

/** The events the timeline names: the run's milestones, as page 12 quotes them. */
const TIMELINE_EVENTS: ReadonlySet<EventType> = new Set<EventType>([
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

/** What a recompute read: the owner's traces, or a snapshot of the whole database. */
export type RecomputeSource =
  | {
      kind: 'traces';
      traces: Array<
        Pick<TraceManifest, 'exportedAt' | 'exportedOn' | 'zone' | 'release' | 'commit'> & {
          employee: string;
        }
      >;
    }
  | { kind: 'snapshot' };

export interface Recomputed {
  owner: string;
  figures: OwnerMetrics;
  /** The first documentation sync of the owner's sources, else the first named event. */
  anchor: { at: number; source: 'documentation sync' | 'first event' } | null;
  timeline: TimelineRow[];
  /** When this recompute ran, which is not when the recording was made. */
  recomputedAt: number;
  source: RecomputeSource;
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
 *   options: `owner`, the subject whose company is recomputed, the no-auth
 *     subject when absent; `now`, the recompute's own time, the clock's when absent.
 *
 * Returns:
 *   The figures as `metrics:forOwner` returns them, and the timeline.
 *
 * Raises:
 *   Error: The path is not a readable Convex export, or lacks a table the
 *     figures are computed from.
 */
export function recomputeFromExport(
  path: string,
  options: { owner?: string; now?: number } = {},
): Recomputed {
  const owner = options.owner ?? DEV_NO_AUTH_SUBJECT;
  const entries = exportEntries(path, new Set([...METRIC_TABLES, ...TIMELINE_TABLES, 'surfaces']));
  const required = <Row>(table: (typeof METRIC_TABLES)[number]): Row[] => {
    const rows = exportRows(entries, table);
    if (!rows) throw new Error(`the export has no ${table} table; is this a Convex export?`);
    return rows as Row[];
  };
  const agents = required<Doc<'agents'>>('agents');
  const events = groupByAgent(required<Doc<'events'>>('events'));
  const workItems = groupByAgent(required<Doc<'workItems'>>('workItems'));
  const charters = groupByAgent(required<Doc<'charters'>>('charters'));

  const selection = selectCompanyEmployees(agents, owner, isEvaluationAgent);
  const surfaces = groupByAgent((exportRows(entries, 'surfaces') ?? []) as Doc<'surfaces'>[]);
  const records: EmployeeRecords[] = selection.employees.map((agent) => ({
    agent,
    events: events.get(agent._id) ?? [],
    workItems: workItems.get(agent._id) ?? [],
    charters: charters.get(agent._id) ?? [],
    surfaces: surfaces.get(agent._id) ?? [],
  }));
  const figures = computeCompanyMetrics(records, selection);

  const sources = (exportRows(entries, 'docSources') ?? []) as Doc<'docSources'>[];
  const ownSources = new Set(sources.filter((row) => row.userId === owner).map((row) => row._id));
  const syncStarts = ((exportRows(entries, 'docSyncRuns') ?? []) as Doc<'docSyncRuns'>[])
    .filter((run) => ownSources.has(run.sourceId))
    .map((run) => run.createdAt);
  return {
    owner,
    figures,
    ...timelineOf(records, syncStarts),
    recomputedAt: options.now ?? Date.now(),
    source: { kind: 'snapshot' },
  };
}

/** The named events of the employees, in write order, anchored on the first sync or event. */
function timelineOf(
  records: readonly EmployeeRecords[],
  syncStarts: readonly number[],
): Pick<Recomputed, 'anchor' | 'timeline'> {
  const named = records
    .flatMap((record) =>
      record.events
        .filter((event) => isEventType(event.type) && TIMELINE_EVENTS.has(event.type))
        .map((event) => ({ event, employee: record.agent.name })),
    )
    .sort((left, right) => byWriteOrder(left.event, right.event));
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
  return { anchor, timeline };
}

/**
 * Recompute the figures of one owner's company from the employees' traces.
 *
 *
 * @param traces - Each employee's assembled trace.
 * @param options - `owner`, the subject whose company is recomputed, the traces'
 *   own owner when absent; `now`, the recompute's own time.
 * @returns The figures as `metrics:forOwner` returns them, the timeline and what was read.
 * @throws Error when the traces belong to more than one owner and none was named.
 */
export function recomputeFromTraces(
  traces: readonly AgentTrace[],
  options: { owner?: string; now?: number } = {},
): Recomputed {
  const owners = [...new Set(traces.flatMap((trace) => trace.agent.userId ?? []))];
  if (options.owner === undefined && owners.length > 1) {
    throw new Error(`the traces belong to ${owners.length} owners; name one with --owner`);
  }
  const owner = options.owner ?? owners[0] ?? DEV_NO_AUTH_SUBJECT;
  const agents = traces.map((trace) => ({
    _id: trace.agent.id as Id<'agents'>,
    _creationTime: trace.agent.creationTime,
    userId: trace.agent.userId,
    name: trace.agent.name,
    createdAt: trace.agent.createdAt,
    evaluation: trace.agent.evaluation || trace.agent.arm === 'baseline',
    trace,
  }));
  const selection = selectCompanyEmployees(agents, owner, (agent) => agent.evaluation);
  const records: EmployeeRecords[] = selection.employees.map(({ trace, ...agent }) => ({
    agent,
    events: trace.sections.events,
    workItems: trace.sections.workItems,
    charters: trace.sections.charters,
    surfaces: trace.sections.surfaces,
  }));
  return {
    owner,
    figures: computeCompanyMetrics(records, selection),
    ...timelineOf(records, []),
    recomputedAt: options.now ?? Date.now(),
    source: {
      kind: 'traces',
      traces: traces.map(({ agent, manifest }) => ({
        employee: agent.name,
        exportedAt: manifest.exportedAt,
        exportedOn: manifest.exportedOn,
        zone: manifest.zone,
        release: manifest.release,
        commit: manifest.commit,
      })),
    },
  };
}

/**
 * Read the command line's inputs: one or more trace files, or one snapshot export.
 *
 * Raises:
 *   Error: A JSON file is not a trace of this version, or traces and a snapshot are mixed.
 */
export function recompute(
  paths: readonly string[],
  options: { owner?: string; now?: number } = {},
): Recomputed {
  const traces = paths.filter((path) => statSync(path).isFile() && path.endsWith('.json'));
  if (traces.length === 0 && paths.length === 1) return recomputeFromExport(paths[0], options);
  if (traces.length !== paths.length) {
    throw new Error('pass trace files, or one snapshot export, not both');
  }
  return recomputeFromTraces(
    traces.map((path) => {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!isAgentTrace(parsed)) {
        throw new Error(
          `${path} is not a day0 trace (version 2); export it with scripts/export-trace.ts`,
        );
      }
      return parsed;
    }),
    options,
  );
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

/** When the recompute ran and what it read, beside the recording's own date. */
function sourceLine({ recomputedAt, source }: Recomputed): string {
  const ran = `recomputed ${new Date(recomputedAt).toISOString()}`;
  if (source.kind === 'snapshot') {
    return `${ran} from a snapshot export (the unredacted database, for a recording made before the trace)`;
  }
  const read = source.traces.map(
    (trace) =>
      `${trace.employee} exported ${trace.exportedOn} (${trace.zone}) at release ${trace.release ?? 'unstamped'}, commit ${trace.commit ?? 'unknown'}`,
  );
  return `${ran} from ${count(source.traces.length, 'trace')}: ${read.join('; ')}`;
}

function timelineLines(recomputed: Recomputed): string[] {
  const { owner, figures, anchor, timeline } = recomputed;
  const utc = (at: number): string => new Date(at).toISOString().slice(11, 23);
  const width = Math.max(0, ...timeline.map((row) => row.employee.length));
  return [
    sourceLine(recomputed),
    `owner ${owner}: ${count(figures.company.employees, 'employee')}, ${count(figures.excludedAgents, 'evaluation agent')} set aside, ${figures.omittedEmployees} omitted`,
    anchor
      ? `anchor ${new Date(anchor.at).toISOString()} (${anchor.source}): the recording's own time`
      : 'anchor none: no documentation sync and no named event',
    ...timeline.map((row) =>
      `${utc(row.at)} ${clock(row.offsetMs).padStart(5)} ${row.employee.padEnd(width)} ${row.eventId.slice(0, 8)} ${row.type.padEnd(26)} ${row.tag}`.trimEnd(),
    ),
  ];
}

function parseArguments(
  argv: readonly string[],
): { paths: string[]; owner?: string; expect?: string; json: boolean } | undefined {
  const paths: string[] = [];
  let owner: string | undefined;
  let expect: string | undefined;
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--json') json = true;
    else if (argument === '--owner' || argument === '--expect') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (argument === '--owner') owner = value;
      else expect = value;
      index += 1;
    } else if (argument.startsWith('--')) {
      return undefined;
    } else {
      paths.push(argument);
    }
  }
  return paths.length === 0 ? undefined : { paths, owner, expect, json };
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
    recomputed = recompute(options.paths, { owner: options.owner });
    if (options.expect !== undefined) expected = JSON.parse(readFileSync(options.expect, 'utf8'));
  } catch (error) {
    io.error(`Recompute failed: ${(error as Error).message}`);
    return 2;
  }
  io.log(JSON.stringify(recomputed.figures, null, 2));
  if (!options.json) for (const line of timelineLines(recomputed)) io.log(line);
  if (options.expect === undefined) return 0;
  const differences = expectationDifferences(expected, recomputed.figures);
  for (const line of differences) io.error(line);
  if (differences.length > 0) return 1;
  if (!options.json) io.log(`every figure in ${options.expect} holds`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runRecompute(process.argv.slice(2));
}
