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

/** The format name every trace carries, so a file says what it is. */
export const TRACE_FORMAT = 'day0-trace';

/** The trace format's version: 2 is the paged trace with a manifest. */
export const TRACE_VERSION = 2;

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
  'events',
] as const;

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

/** One retired employee of the owner, as its tombstone event records it. */
export interface TraceRetirement {
  readonly agentId: string;
  readonly retiredAt: number;
  readonly payload: Record<string, unknown>;
}

/**
 * Who and what the trace is of, and where it came from: the release and
 * commit the deployment was stamped with, the moment of the export and its
 * date in the agent's zone.
 */
export interface TraceManifest {
  readonly format: typeof TRACE_FORMAT;
  readonly version: typeof TRACE_VERSION;
  readonly exportedAt: number;
  /** The export's date, `YYYY-MM-DD`, in the agent's zone. */
  readonly exportedOn: string;
  readonly zone: string;
  /** The deployment's release stamp, or null on a deployment the upgrade never stamped. */
  readonly release: string | null;
  readonly commit: string | null;
  readonly pageRows: number;
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
 * Args:
 *   agentId: The agent to export.
 *   call: One call of the export: the head for a request with no page, one
 *     page otherwise. The command line passes `npx convex run`; a test passes
 *     the harness.
 *
 * Returns:
 *   The trace with every section in full and the counts in the manifest.
 *
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
  const sections: Record<TraceSection, unknown[]> = {
    charters: [],
    workItems: [],
    skills: [],
    questions: [],
    corrections: [],
    surfaces: [],
    events: [],
  };
  let next: TraceCursor | null = head.next;
  while (next !== null) {
    const page: TracePage = await call.page({ agentId, page: next });
    if (page.section !== next.section) {
      throw new Error(`asked for ${next.section}, the export answered ${page.section}`);
    }
    sections[page.section].push(...page.rows);
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
 * Whether a parsed file is an assembled trace of this version.
 *
 * @returns True when the value carries this format's manifest and sections.
 */
export function isAgentTrace(value: unknown): value is AgentTrace {
  if (value === null || typeof value !== 'object') return false;
  const { manifest, agent, sections } = value as Record<string, unknown>;
  return (
    manifest !== null &&
    typeof manifest === 'object' &&
    (manifest as Record<string, unknown>).format === TRACE_FORMAT &&
    (manifest as Record<string, unknown>).version === TRACE_VERSION &&
    agent !== null &&
    typeof agent === 'object' &&
    sections !== null &&
    typeof sections === 'object' &&
    TRACE_SECTIONS.every((section) => Array.isArray((sections as Record<string, unknown>)[section]))
  );
}
