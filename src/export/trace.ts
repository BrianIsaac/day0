/**
 * The shape of an agent's exported trace (decisions Q14, A9 and N10): what
 * the export action returns one bounded page at a time, and the one file an
 * assembler writes from the pages.
 *
 * The pinned backend image refuses any returned array past 8,192 elements,
 * and an agent's events pass that in one bed import, so nothing is returned
 * whole: the first call returns the head (the manifest, the agent and the
 * owner section), and each later call one page of one section, at most
 * `TRACE_PAGE_ROWS` rows, with the cursor of the next.
 */
import type { Doc } from '../../convex/_generated/dataModel';
import type { EventType } from '../events/contract';
import type { AcceptedHandover } from '../metrics/tenure';

/** The format name every trace carries, so a file says what it is. */
export const TRACE_FORMAT = 'day0-trace';

/**
 * The trace format's version: 2 is the paged trace with a manifest; 3 adds
 * the delivery records of Day0's own messages and the event contract's types;
 * 4 adds the employee's accepted handovers to the manifest, so a recompute
 * from traces cuts each manager's figures by tenure.
 */
export const TRACE_VERSION = 4;

/**
 * The earlier versions this release still reads: a version 2 trace has no
 * delivery records, and neither 2 nor 3 carries the handovers.
 */
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([2, 3, TRACE_VERSION]);

/** The most rows one page returns, far inside the backend's 8,192-element bound. */
export const TRACE_PAGE_ROWS = 100;

/** The sections a trace carries after its head, in the order they are paged. */
export const TRACE_SECTIONS = [
  'charters',
  'workItems',
  'skills',
  'questions',
  'corrections',
  'surfaces',
  'managerNotes',
  'decisionNotices',
  'events',
] as const;

/** The sections a version 2 trace did not carry, read from one as empty. */
const ADDED_IN_VERSION_3: readonly TraceSection[] = ['managerNotes', 'decisionNotices'];

/** One section of a trace. */
export type TraceSection = (typeof TRACE_SECTIONS)[number];

/** The rows of each section, redacted as the export redacts them. */
export interface TraceRows {
  charters: Doc<'charters'>[];
  workItems: Doc<'workItems'>[];
  skills: Doc<'skills'>[];
  questions: Doc<'managerQuestions'>[];
  corrections: Doc<'corrections'>[];
  surfaces: Doc<'surfaces'>[];
  /**
   * What the gate told the manager about each finished run, sent one per run
   * or in a digest: the delivery record, with the provider's timestamp when it
   * landed and the failure when it did not (Q14).
   */
  managerNotes: Doc<'managerNotes'>[];
  /** Each acknowledgement Day0 posted of a reply the manager gave a decision request. */
  decisionNotices: Doc<'managerDecisionNotices'>[];
  events: Doc<'events'>[];
}

/** Where the next page starts: a section, and the cursor inside it (null at its start). */
export interface TraceCursor {
  readonly section: TraceSection;
  readonly cursor: string | null;
}

/**
 * The agent as the trace names it. The manager's address is not carried; the
 * evaluation flag it was needed for is (P9-9), so the recompute can set
 * evaluation agents aside from the trace alone.
 */
export interface TraceAgent {
  readonly id: string;
  readonly name: string;
  readonly userId?: string;
  readonly state: Doc<'agents'>['state'];
  readonly arm?: Doc<'agents'>['arm'];
  /** The surface mode the agent was deployed under, when the row carries it. */
  readonly mode?: Doc<'agents'>['mode'];
  /** The zone the agent's day is measured in, the row's or the deployment's. */
  readonly zone: string;
  readonly evaluation: boolean;
  readonly createdAt: number;
  /** The row's creation time, which orders employees deployed in one millisecond. */
  readonly creationTime: number;
}

/** One retired employee of the owner, as a version 2 trace carried it: its tombstone event's payload. */
export interface TombstoneRetirement {
  readonly agentId: string;
  readonly retiredAt: number;
  readonly payload: Record<string, unknown>;
}

/**
 * One retired employee of the owner: its `retirements` row without the
 * owner's subject, redacted as the export redacts, or in a version 2 trace
 * its tombstone event.
 */
export type TraceRetirement = Omit<Doc<'retirements'>, 'userId'> | TombstoneRetirement;

/**
 * Who and what the trace is of, and where it came from: the release and
 * commit the deployment was stamped with, the moment of the export and its
 * date in the agent's zone.
 */
export interface TraceManifest {
  readonly format: typeof TRACE_FORMAT;
  /** This release's version, or the earlier one a file read from an older export keeps. */
  readonly version: 2 | 3 | typeof TRACE_VERSION;
  readonly exportedAt: number;
  /** The export's date, `YYYY-MM-DD`, in the agent's zone. */
  readonly exportedOn: string;
  readonly zone: string;
  /** The deployment's release stamp, or null on a deployment the upgrade never stamped. */
  readonly release: string | null;
  readonly commit: string | null;
  readonly pageRows: number;
  /**
   * The event types the exporting release writes, from the event contract, so
   * a reader of the events section knows the vocabulary it was written in.
   * Absent from a version 2 trace.
   */
  readonly eventTypes?: readonly EventType[];
  /**
   * The employee's accepted handovers, oldest first: who held it before and after each, and
   * when the named manager accepted. A trace is exported by the manager who holds the employee
   * now and carries its whole history, so a recompute cuts each manager's figures at these, as
   * `metrics:forOwner` cuts them (D12). Absent before version 4, where the history is read as
   * the present holder's.
   */
  readonly handovers?: readonly AcceptedHandover[];
}

/** The first call's answer: everything but the paged sections, and where they start. */
export interface TraceHead {
  readonly manifest: TraceManifest;
  readonly agent: TraceAgent;
  /** The owner section (N1, Q15): the owner's retired employees. */
  readonly owner: { readonly retired: readonly TraceRetirement[] };
  readonly credentialNames: ReadonlyArray<{ readonly label: string }>;
  readonly next: TraceCursor;
}

/** One later call's answer: one page of one section. */
export interface TracePage<Section extends TraceSection = TraceSection> {
  readonly section: Section;
  readonly rows: TraceRows[Section];
  /** Where the next page starts, or null after the last page of the last section. */
  readonly next: TraceCursor | null;
}

/** The assembled trace: the head, every section in full, and the rows each section holds. */
export interface AgentTrace {
  readonly manifest: TraceManifest & { readonly counts: Readonly<Record<TraceSection, number>> };
  readonly agent: TraceAgent;
  readonly owner: TraceHead['owner'];
  readonly credentialNames: TraceHead['credentialNames'];
  readonly sections: TraceRows;
}

/** A request for one call of the paged export: the head when `page` is absent. */
export interface TraceRequest {
  readonly agentId: string;
  readonly page?: TraceCursor;
}

/**
 * The section after the given one, or undefined after the last.
 *
 * @returns The next section in `TRACE_SECTIONS` order.
 */
export function sectionAfter(section: TraceSection): TraceSection | undefined {
  return TRACE_SECTIONS[TRACE_SECTIONS.indexOf(section) + 1];
}

/**
 * Assemble a whole trace by calling the paged export until nothing is left.
 *
 * @param agentId - The agent to export.
 * @param call - One call of the export: the head for a request with no page, one
 *   page otherwise. The command line passes `npx convex run`; a test passes the harness.
 * @returns The trace with every section in full and the counts in the manifest.
 * @throws Error when a page answers for a section other than the one asked for.
 */
export async function assembleTrace(
  agentId: string,
  call: {
    head(request: TraceRequest): Promise<TraceHead>;
    page(request: TraceRequest & { page: TraceCursor }): Promise<TracePage>;
  },
): Promise<AgentTrace> {
  const head = await call.head({ agentId });
  const sections = Object.fromEntries(
    TRACE_SECTIONS.map((section): [TraceSection, unknown[]] => [section, []]),
  ) as Record<TraceSection, unknown[]>;
  const seen = new Set<string>();
  let next: TraceCursor | null = head.next;
  while (next !== null) {
    const page: TracePage = await call.page({ agentId, page: next });
    if (page.section !== next.section) {
      throw new Error(`asked for ${next.section}, the export answered ${page.section}`);
    }
    // A row read twice across pages is one row.
    for (const row of page.rows) {
      const id = (row as { _id?: unknown })._id;
      if (seen.has(`${page.section}:${String(id)}`)) continue;
      seen.add(`${page.section}:${String(id)}`);
      sections[page.section].push(row);
    }
    next = page.next;
  }
  const counts = Object.fromEntries(
    Object.entries(sections).map(([section, rows]) => [section, rows.length]),
  ) as Record<TraceSection, number>;
  return {
    manifest: { ...head.manifest, counts },
    agent: head.agent,
    owner: head.owner,
    credentialNames: head.credentialNames,
    sections: sections as unknown as TraceRows,
  };
}

/**
 * A parsed file as an assembled trace of this version, or undefined when it is
 * not a day0 trace this release reads. A version 2 trace is read with the
 * sections it did not carry as empty.
 *
 * @param value - The parsed file.
 * @returns The trace, its manifest's version the one it was written with.
 */
export function readAgentTrace(value: unknown): AgentTrace | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { manifest, agent, sections } = value as Record<string, unknown>;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    (manifest as Record<string, unknown>).format !== TRACE_FORMAT ||
    !READABLE_VERSIONS.has((manifest as Record<string, unknown>).version) ||
    agent === null ||
    typeof agent !== 'object' ||
    sections === null ||
    typeof sections !== 'object'
  ) {
    return undefined;
  }
  const version = (manifest as Record<string, unknown>).version;
  const carried = sections as Record<string, unknown>;
  const complete = TRACE_SECTIONS.every(
    (section) =>
      Array.isArray(carried[section]) ||
      (version === 2 && ADDED_IN_VERSION_3.includes(section) && carried[section] === undefined),
  );
  if (!complete) return undefined;
  const filled = Object.fromEntries(
    TRACE_SECTIONS.map((section) => [section, carried[section] ?? []]),
  ) as unknown as TraceRows;
  return { ...(value as AgentTrace), sections: filled };
}

/**
 * Whether a parsed file is an assembled trace this release reads.
 *
 * @returns True when `readAgentTrace` reads it.
 */
export function isAgentTrace(value: unknown): value is AgentTrace {
  return readAgentTrace(value) !== undefined;
}
