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
import type { ConnectionEventType, EventType } from '../events/contract';
import type { AcceptedHandover } from '../metrics/tenure';
import { sha256OfText } from '../lib/sha256';

/** The format name every trace carries, so a file says what it is. */
export const TRACE_FORMAT = 'day0-trace';

/**
 * The trace format's version: 2 is the paged trace with a manifest; 3 adds
 * the delivery records of Day0's own messages and the event contract's types;
 * 4 adds the employee's accepted handovers to the manifest, so a recompute
 * from traces cuts each manager's figures by tenure, each owner key as a
 * salted digest ({@link ownerKeyDigest}); 5 adds the organisation's ledger
 * lines about the connections the employee's cards use (wave 11, F17); 6 adds
 * the decision requests a newer one replaced (wave 12, 12-M; F2 D14); 7 adds the
 * owner's people graph, its people, identities and edges (wave 13, 13-P); 8 adds the employee's
 * reorientation cards and the talks about them (wave 16), and is the version of the owner export
 * ({@link OwnerExport}), which carries every employee's trace and the owner's rows in one file.
 */
export const TRACE_VERSION = 8;

/** A trace version this release reads. */
export type TraceVersion = 2 | 3 | 4 | 5 | 6 | 7 | typeof TRACE_VERSION;

/**
 * The earlier versions this release still reads: a version 2 trace has no
 * delivery records, neither 2 nor 3 carries the handovers, none before 6
 * the replaced decision requests, none before 7 the people graph, and none before 8 the
 * reorientation cards.
 */
const READABLE_VERSIONS: ReadonlySet<unknown> = new Set([2, 3, 4, 5, 6, 7, TRACE_VERSION]);

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
  'replacedRequests',
  'people',
  'personIdentities',
  'relationships',
  'reorientations',
  'reorientationTalks',
  'events',
] as const;

/** The sections a version 2 trace did not carry, read from one as empty. */
const ADDED_IN_VERSION_3: readonly TraceSection[] = ['managerNotes', 'decisionNotices'];

/** The sections a trace before version 6 did not carry, read from one as empty. */
const ADDED_IN_VERSION_6: readonly TraceSection[] = ['replacedRequests'];

/** The sections a trace before version 7 did not carry, read from one as empty. */
const ADDED_IN_VERSION_7: readonly TraceSection[] = ['people', 'personIdentities', 'relationships'];

/** The sections a trace before version 8 did not carry, read from one as empty. */
const ADDED_IN_VERSION_8: readonly TraceSection[] = ['reorientations', 'reorientationTalks'];

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
  /**
   * Each decision request a newer one replaced or a path took back, with the code that replaced
   * it and the result of the one edit that marked its message (12-M; F2 D14).
   */
  replacedRequests: Doc<'replacedDecisionRequests'>[];
  /**
   * The owner's people graph as the employee's owner holds it at the export (wave 13, 13-P): every
   * person with their evidence and standing, proposals and dismissals included, each identity, and
   * every edge with when it held. Only the exporting owner's: after a handover none of the old
   * owner's.
   */
  people: Doc<'people'>[];
  personIdentities: Doc<'personIdentities'>[];
  relationships: Doc<'relationships'>[];
  /** The employee's reorientation cards, in every standing (wave 16; 16-K's table). */
  reorientations: Doc<'reorientations'>[];
  /** The talks the manager had with the employee about a card (wave 16, Discuss). */
  reorientationTalks: Doc<'reorientationTalks'>[];
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
  readonly version: TraceVersion;
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
   * The employee's accepted handovers, oldest first: who held it before and after each, as
   * digests of their owner keys ({@link ownerKeyDigest}), and when the named manager accepted. A trace is exported by the manager who holds the employee
   * now and carries its whole history, so a recompute cuts each manager's figures at these, as
   * `metrics:forOwner` cuts them (D12). Absent before version 4, where the history is read as
   * the present holder's.
   */
  readonly handovers?: readonly TraceHandover[];
}

/**
 * One accepted handover as a trace's manifest carries it: the two owner keys as digests
 * ({@link ownerKeyDigest}), so the file names no manager's account, and the acceptance.
 */
export interface TraceHandover {
  readonly agentId: string;
  /** The digest of the owner key that held the employee before. */
  readonly fromOwnerDigest: string;
  /** The digest of the owner key that holds it from the acceptance. */
  readonly toOwnerDigest: string;
  /** When the named manager accepted: the boundary between the two tenures. */
  readonly acceptedAt: number;
}

/**
 * An owner key as a trace's manifest carries it (decision 2; the wave 10 review, M6): a SHA-256
 * digest salted with the trace's own export time. The export strips every manager address from
 * the file and keeps no account key but the exporter's own, and a trace is made to be shared, so
 * a handover names its two managers only this way. A recompute that knows a key (the `--owner`
 * it is asked about, the employee's present holder) digests it with the same salt and finds its
 * spans ({@link handoversForRecompute}); a key nobody names stays a digest.
 *
 * @param ownerKey - The owner key (`agents.userId`).
 * @param exportedAt - The trace's `manifest.exportedAt`, the salt.
 */
export function ownerKeyDigest(ownerKey: string, exportedAt: number): string {
  return `sha256:${sha256OfText(`day0-trace-owner\u0000${exportedAt}\u0000${ownerKey}`)}`;
}

/**
 * The manifest's handovers with every digest of a known owner key read back as the key, for the
 * tenure windows a recompute cuts (`tenureWindowsOf`); a digest no known key answers stays as it
 * is, an owner that is neither of them.
 *
 * @param manifest - The trace's manifest.
 * @param knownOwnerKeys - The keys the recompute knows: the owner it is asked about and the
 *   employee's present holder.
 */
export function handoversForRecompute(
  manifest: Pick<TraceManifest, 'exportedAt' | 'handovers'>,
  knownOwnerKeys: readonly string[],
): AcceptedHandover[] {
  const byDigest = new Map(
    knownOwnerKeys.map((key): [string, string] => [ownerKeyDigest(key, manifest.exportedAt), key]),
  );
  const read = (digest: string): string => byDigest.get(digest) ?? digest;
  return (manifest.handovers ?? []).map(
    (handover): AcceptedHandover => ({
      agentId: handover.agentId,
      fromOwnerKey: read(handover.fromOwnerDigest),
      toOwnerKey: read(handover.toOwnerDigest),
      acceptedAt: handover.acceptedAt,
    }),
  );
}

/**
 * One line of the organisation's ledger (`connectionEvents`, F17) as a trace carries it: a line
 * about a connection the employee's cards use, redacted as the export redacts, with the
 * administrator's address left out (the file names no account but the exporter's own).
 */
export interface TraceLedgerLine {
  readonly type: ConnectionEventType;
  readonly organisationConnectionId: string;
  readonly createdAt: number;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** The first call's answer: everything but the paged sections, and where they start. */
export interface TraceHead {
  readonly manifest: TraceManifest;
  readonly agent: TraceAgent;
  /** The owner section (N1, Q15): the owner's retired employees. */
  readonly owner: { readonly retired: readonly TraceRetirement[] };
  readonly credentialNames: ReadonlyArray<{ readonly label: string }>;
  /**
   * The organisation's ledger lines about the connections the employee's cards use, oldest first:
   * each connection's landing, rotations and revoke, and the vendor calls made with its secret to
   * end this employee's access, never another employee's. Empty before version 5.
   */
  readonly organisationLedger: readonly TraceLedgerLine[];
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
  readonly organisationLedger: TraceHead['organisationLedger'];
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
 * A walk's guard against a cursor the export answers twice (W17-R28): a walk ends at a null
 * cursor, and a backend that handed back one it had already given would have the walk read the
 * same pages for ever. Each cursor asked is remembered by its printed form.
 *
 * @param what - What the walk reads, as the error names it ("the owner’s agents").
 * @returns A check of the next cursor, which throws when it was asked before.
 */
function cursorWalk(what: (cursor: unknown) => string): (cursor: unknown) => void {
  const asked = new Set<string>();
  return (cursor) => {
    const printed = JSON.stringify(cursor);
    if (asked.has(printed)) {
      throw new Error(`the export answered the same cursor of ${what(cursor)} twice`);
    }
    asked.add(printed);
  };
}

/**
 * Assemble a whole trace by calling the paged export until nothing is left.
 *
 * @param agentId - The agent to export.
 * @param call - One call of the export: the head for a request with no page, one
 *   page otherwise. The command line passes `npx convex run`; a test passes the harness.
 * @param skip - Sections not to read, left empty in the trace: the owner export carries the
 *   owner's people graph once rather than in every employee's trace.
 * @returns The trace with every section in full and the counts in the manifest.
 * @throws Error when a page answers for a section other than the one asked for, or a cursor it
 *   gave before.
 */
export async function assembleTrace(
  agentId: string,
  call: TraceCalls,
  skip: ReadonlySet<TraceSection> = new Set(),
): Promise<AgentTrace> {
  const head = await call.head({ agentId });
  const sections = Object.fromEntries(
    TRACE_SECTIONS.map((section): [TraceSection, unknown[]] => [section, []]),
  ) as Record<TraceSection, unknown[]>;
  const seen = new Set<string>();
  const once = cursorWalk((cursor) => `the trace’s ${(cursor as TraceCursor).section}`);
  let next: TraceCursor | null = head.next;
  while (next !== null) {
    if (skip.has(next.section)) {
      // A section left to another part of the file is never read: it is carried there once.
      const following = sectionAfter(next.section);
      next = following === undefined ? null : { section: following, cursor: null };
      continue;
    }
    once(next);
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
    organisationLedger: head.organisationLedger,
    sections: sections as unknown as TraceRows,
  };
}

/**
 * A parsed file as an assembled trace of this version, or undefined when it is
 * not a day0 trace this release reads. A trace is read with the sections its
 * version did not carry yet as empty.
 *
 * @param value - The parsed file.
 * @returns The trace, its manifest's version the one it was written with.
 */
export function readAgentTrace(value: unknown): AgentTrace | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { manifest, agent, sections, organisationLedger } = value as Record<string, unknown>;
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
      (carried[section] === undefined &&
        ((version === 2 && ADDED_IN_VERSION_3.includes(section)) ||
          (typeof version === 'number' && version < 6 && ADDED_IN_VERSION_6.includes(section)) ||
          (typeof version === 'number' && version < 7 && ADDED_IN_VERSION_7.includes(section)) ||
          (typeof version === 'number' && version < 8 && ADDED_IN_VERSION_8.includes(section)))),
  );
  if (!complete) return undefined;
  const filled = Object.fromEntries(
    TRACE_SECTIONS.map((section) => [section, carried[section] ?? []]),
  ) as unknown as TraceRows;
  // A trace before version 5 carried no organisation ledger: read as none.
  const ledger = Array.isArray(organisationLedger)
    ? (organisationLedger as AgentTrace['organisationLedger'])
    : [];
  return { ...(value as AgentTrace), organisationLedger: ledger, sections: filled };
}

/**
 * Whether a parsed file is an assembled trace this release reads.
 *
 * @returns True when `readAgentTrace` reads it.
 */
export function isAgentTrace(value: unknown): value is AgentTrace {
  return readAgentTrace(value) !== undefined;
}

/** The format name of the owner export, the one file of every employee's trace and the owner's rows. */
export const OWNER_EXPORT_FORMAT = 'day0-owner-export';

/**
 * The owner's own rows an owner export carries once, in the order they are paged (wave 16, 16-F;
 * the wave file's 5.4): the retired employees and the employees handed to another manager (wave
 * 9), the documentation's sources by their labels and trust, the pages by their status and the
 * relations between them, never a page's text (wave 15), the skill library (wave 10), and the
 * people graph with the working agreements (wave 13). Organisation connections and their ledger
 * are the administrator's, not an owner's.
 */
export const OWNER_SECTIONS = [
  'retirements',
  'departures',
  'docSources',
  'docPages',
  'docRelations',
  'skillVersions',
  'people',
  'personIdentities',
  'relationships',
  'workingAgreements',
] as const;

/** One section of the owner's rows. */
export type OwnerSection = (typeof OWNER_SECTIONS)[number];

/**
 * The sections of an employee's trace that are the owner's rows (the people graph, read under the
 * employee's owner scope): an owner export carries them once among the owner's rows, and leaves
 * them empty in each employee's trace ({@link employeeTracesOf} fills them back).
 */
export const OWNER_SCOPED_SECTIONS: ReadonlySet<TraceSection> = new Set<TraceSection>([
  'people',
  'personIdentities',
  'relationships',
]);

/**
 * One documentation source as the owner export carries it: its label, kind and trust, and where
 * it stands, never its locator or its secret.
 */
export interface OwnerDocSource {
  readonly _id: string;
  readonly _creationTime: number;
  readonly label: string;
  readonly kind: Doc<'docSources'>['kind'];
  readonly authority?: Doc<'docSources'>['authority'];
  readonly defaultStatus?: Doc<'docSources'>['defaultStatus'];
  readonly status: Doc<'docSources'>['status'];
  readonly lastSyncAt?: number;
  readonly createdAt: number;
}

/**
 * A page as the owner export names it from elsewhere: its source and the opaque key its own row
 * in the file's `docPages` carries as `page`, never its ref, which for a list of URLs is the
 * address itself (W16-R18).
 */
export interface OwnerPageRef {
  readonly sourceId: string;
  readonly page: string;
}

/**
 * One stored page as the owner export carries it: its title and status with what decided it,
 * never its text, its keyed hash, the words a marker was read from, who decided it, or its ref
 * and address (W16-R18: a locator, which for a list of URLs carries any query-string
 * credential); it carries an opaque key in their place, and the page that superseded it is named
 * by that page's key.
 */
export type OwnerDocPage = Omit<
  Doc<'docPages'>,
  'markdown' | 'contentHash' | 'marker' | 'decidedBy' | 'ref' | 'url' | 'supersededBy'
> & {
  /** The page's opaque key in this owner's exports, which a relation's ends and a successor name. */
  readonly page: string;
  readonly marker?: Omit<NonNullable<Doc<'docPages'>['marker']>, 'quote'>;
  readonly supersededBy?: OwnerPageRef;
};

/** One relation between pages as the owner export carries it: its ends by their pages' keys. */
export type OwnerDocRelation = Omit<Doc<'docRelations'>, 'decidedBy' | 'from' | 'to'> & {
  readonly from: OwnerPageRef;
  readonly to: OwnerPageRef;
};

/**
 * One employee the owner handed to another manager (wave 9): when it was asked and accepted. Its
 * records since are the other manager's, so the file carries none of them and names neither
 * manager; a recompute that should count the employee within the owner's span reads the other
 * manager's trace of it beside this file.
 */
export interface OwnerDeparture {
  /** The handover request's id. */
  readonly _id: string;
  readonly agentId: string;
  readonly agentName: string;
  readonly state: Doc<'managerTransfers'>['state'];
  readonly requestedAt: number;
  readonly decidedAt?: number;
}

/** The owner's rows, section by section, redacted as the export redacts. */
export interface OwnerRows {
  retirements: Array<Omit<Doc<'retirements'>, 'userId'>>;
  departures: OwnerDeparture[];
  docSources: OwnerDocSource[];
  docPages: OwnerDocPage[];
  docRelations: OwnerDocRelation[];
  skillVersions: Doc<'skillVersions'>[];
  people: Doc<'people'>[];
  personIdentities: Doc<'personIdentities'>[];
  relationships: Doc<'relationships'>[];
  workingAgreements: Doc<'workingAgreements'>[];
}

/** Where the next page of the owner's rows starts: a section, and the cursor inside it. */
export interface OwnerCursor {
  readonly section: OwnerSection;
  readonly cursor: string | null;
}

/**
 * Who and what an owner export is of: the release and commit, the moment of the export and its
 * date in the deployment's zone, and the employees it carries.
 */
export interface OwnerManifest {
  readonly format: typeof OWNER_EXPORT_FORMAT;
  readonly version: typeof TRACE_VERSION;
  readonly exportedAt: number;
  /** The export's date, `YYYY-MM-DD`, in {@link OwnerManifest.zone}. */
  readonly exportedOn: string;
  /** The deployment's zone: an owner has no zone of its own, each employee's trace carries its. */
  readonly zone: string;
  readonly release: string | null;
  readonly commit: string | null;
  readonly pageRows: number;
  /** The owner key the export was made under: the one account the file names. */
  readonly ownerKey: string;
}

/**
 * One page of the owner's agents, in deploy order: the employees whose traces follow, by id, and
 * the agents set aside (evaluation agents and baseline arms, named only, as a trace names an
 * agent, so the figures set them aside as `metrics:forOwner` does).
 */
export interface OwnerAgentsPage {
  readonly employees: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly setAside: readonly TraceAgent[];
  /** Where the next page of the owner's agents starts, or null after the last. */
  readonly moreAgents: string | null;
}

/**
 * The first call's answer: the manifest, the first page of the owner's agents (every one the
 * owner holds is named, the rest through {@link OwnerAgentsPage}'s cursor, so none is left out:
 * wave 17, W16-R32), and where the owner's rows start.
 */
export interface OwnerExportHead extends OwnerAgentsPage {
  readonly manifest: OwnerManifest;
  readonly next: OwnerCursor;
}

/** One later call's answer: one page of one section of the owner's rows. */
export interface OwnerPage<Section extends OwnerSection = OwnerSection> {
  readonly section: Section;
  readonly rows: OwnerRows[Section];
  readonly next: OwnerCursor | null;
}

/**
 * The owner export assembled (decision F-1, one JSON file): the manifest with the counts, the
 * owner's rows, and every employee's trace without the sections the owner's rows carry.
 */
export interface OwnerExport {
  readonly manifest: OwnerManifest & {
    readonly counts: Readonly<Record<OwnerSection, number>> & { readonly employees: number };
  };
  readonly owner: OwnerRows;
  readonly employees: readonly AgentTrace[];
  readonly setAside: readonly TraceAgent[];
  /**
   * How many of the owner's agents the head named and the file carries neither as a trace nor as
   * set aside: none, since the head names every agent by pages and each employee's trace follows
   * (wave 17; before it the head read at most five hundred and counted one past them).
   */
  readonly omittedAgents: number;
}

/** The owner export versions this release reads: 8 is the first, and a later one keeps it. */
const OWNER_READABLE_VERSIONS: ReadonlySet<unknown> = new Set([TRACE_VERSION]);

/** The owner section after the given one, or undefined after the last. */
export function ownerSectionAfter(section: OwnerSection): OwnerSection | undefined {
  return OWNER_SECTIONS[OWNER_SECTIONS.indexOf(section) + 1];
}

/** The calls of one employee's paged export, as {@link assembleTrace} takes them. */
export interface TraceCalls {
  head(request: TraceRequest): Promise<TraceHead>;
  page(request: TraceRequest & { page: TraceCursor }): Promise<TracePage>;
}

/** The calls of the owner's paged export: its head, its later pages of agents, its rows. */
export interface OwnerExportCalls {
  head(): Promise<OwnerExportHead>;
  /** One later page of the owner's agents, from the cursor the head or the page before gave. */
  agents(cursor: string): Promise<OwnerAgentsPage>;
  page(cursor: OwnerCursor): Promise<OwnerPage>;
  readonly employee: TraceCalls;
}

/**
 * Every agent of the owner, read from the head's page and the pages after it until none is left,
 * each named once.
 *
 * @param head - The head, which holds the first page.
 * @param agents - One later page, from a cursor.
 */
async function everyOwnerAgent(
  head: OwnerAgentsPage,
  agents: OwnerExportCalls['agents'],
): Promise<Pick<OwnerAgentsPage, 'employees' | 'setAside'>> {
  const employees = new Map(head.employees.map((employee) => [employee.id, employee]));
  const setAside = new Map(head.setAside.map((agent) => [agent.id, agent]));
  const once = cursorWalk(() => 'the owner’s agents');
  let more = head.moreAgents;
  while (more !== null) {
    once(more);
    const page = await agents(more);
    for (const employee of page.employees) employees.set(employee.id, employee);
    for (const agent of page.setAside) setAside.set(agent.id, agent);
    more = page.moreAgents;
  }
  return { employees: [...employees.values()], setAside: [...setAside.values()] };
}

/** Where the owner export is written, a piece at a time: the file a browser or the command saves. */
export interface OwnerExportSink {
  /** Write the next piece of the file; the export waits for it before it reads on. */
  write(chunk: string): Promise<void>;
}

/** How far a streamed export has got: the employees whose traces are written, of those it names. */
export interface OwnerExportProgress {
  readonly written: number;
  readonly employees: number;
}

/** What a streamed export is told beside its calls and its sink. */
export interface OwnerExportOptions {
  /** Aborted to cancel: the export stops before its next call or write ({@link OwnerExportCancelled}). */
  readonly signal?: AbortSignal;
  /** Told once the owner's rows are written and again after each employee's trace. */
  readonly onProgress?: (progress: OwnerExportProgress) => void;
}

/** A streamed export stopped by its signal: nothing more was read or written, and the file is not whole. */
export class OwnerExportCancelled extends Error {
  /** A cancelled export, said in the words a caller that shows it reads. */
  constructor() {
    super('the export was cancelled');
    this.name = 'OwnerExportCancelled';
  }
}

/** The indent of one level of the file, as `JSON.stringify(file, null, 2)` prints it. */
const FILE_INDENT = '  ';

/** A value as `JSON.stringify(value, null, 2)` prints it at a depth inside the file. */
function printedAt(value: unknown, depth: number): string {
  // A string's own line breaks are escaped, so every line break here is the printer's.
  return JSON.stringify(value, null, 2).replace(/\n/g, `\n${FILE_INDENT.repeat(depth)}`);
}

/** What the first piece of the file is written from, beside the calls and the sink. */
interface OwnerRowsRequest {
  readonly head: OwnerExportHead;
  /** How many employees' traces follow, for the manifest's counts. */
  readonly employees: number;
  /** Throws once the export is cancelled. */
  readonly live: () => void;
}

/**
 * Read the owner's rows page by page and write the file's first piece: the manifest, which
 * carries their counts, the rows, and the opening of the employees' list. The rows are this
 * function's own, so they are let go when it returns, before the first employee is read: on the
 * wave 17 bed they were 8 MB of an 11 MB file, held to the export's end while they were the
 * stream's.
 *
 * @returns The manifest as written.
 * @throws Error when a page answers for a section other than the one asked for, or a cursor it
 *   gave before.
 */
async function writeOwnerRows(
  call: OwnerExportCalls,
  sink: OwnerExportSink,
  { head, employees, live }: OwnerRowsRequest,
): Promise<OwnerExport['manifest']> {
  const owner = Object.fromEntries(
    OWNER_SECTIONS.map((section): [OwnerSection, unknown[]] => [section, []]),
  ) as Record<OwnerSection, unknown[]>;
  const seen = new Set<string>();
  const once = cursorWalk((cursor) => `the owner’s ${(cursor as OwnerCursor).section}`);
  let next: OwnerCursor | null = head.next;
  while (next !== null) {
    live();
    once(next);
    const page: OwnerPage = await call.page(next);
    if (page.section !== next.section) {
      throw new Error(`asked for ${next.section}, the export answered ${page.section}`);
    }
    for (const row of page.rows) {
      const id = String((row as { _id?: unknown })._id);
      if (seen.has(`${page.section}:${id}`)) continue;
      seen.add(`${page.section}:${id}`);
      owner[page.section].push(row);
    }
    next = page.next;
  }
  const counts = Object.fromEntries(
    OWNER_SECTIONS.map((section) => [section, owner[section].length]),
  ) as Record<OwnerSection, number>;
  const manifest: OwnerExport['manifest'] = {
    ...head.manifest,
    counts: { ...counts, employees },
  };
  live();
  await sink.write(
    `{\n${FILE_INDENT}"manifest": ${printedAt(manifest, 1)},\n${FILE_INDENT}"owner": ${printedAt(owner, 1)},\n${FILE_INDENT}"employees": [`,
  );
  return manifest;
}

/**
 * Write the owner export to a sink as it is read (wave 17, 17-F; decision F-1): the head and the
 * rest of the owner's agents, the owner's rows page by page, then each employee's trace through
 * the employee's own export, its owner-scoped sections left to the owner's rows. The owner's rows
 * are held until they are written, since the manifest that goes first carries their counts, and
 * let go before the first employee is read ({@link writeOwnerRows}): they hold no stored page's
 * text, and the skill library's bodies are the heaviest thing among them.
 * An employee's trace is written the moment it is whole and let go before the next is read, so
 * the export holds one trace however many employees there are. The pieces together are the file
 * `JSON.stringify(file, null, 2)` and a line break would print of the whole {@link OwnerExport},
 * byte for byte.
 *
 * @param call - The owner export's head and pages, and one employee's (as {@link assembleTrace}
 *   takes them).
 * @param sink - Where each piece of the file goes, in order.
 * @param options - The signal that cancels the export, and who hears how far it has got.
 * @returns The file's manifest, with its counts.
 * @throws OwnerExportCancelled when the signal is aborted; the sink then holds part of a file.
 * @throws Error when a page answers for a section other than the one asked for, or a cursor it
 *   gave before.
 */
export async function streamOwnerExport(
  call: OwnerExportCalls,
  sink: OwnerExportSink,
  options: OwnerExportOptions = {},
): Promise<OwnerExport['manifest']> {
  const live = (): void => {
    if (options.signal?.aborted === true) throw new OwnerExportCancelled();
  };
  live();
  const head = await call.head();
  const named = await everyOwnerAgent(head, async (cursor) => {
    live();
    return await call.agents(cursor);
  });
  const employees = named.employees.length;
  const manifest = await writeOwnerRows(call, sink, { head, employees, live });
  options.onProgress?.({ written: 0, employees });
  const guarded: TraceCalls = {
    head: async (request) => {
      live();
      return await call.employee.head(request);
    },
    page: async (request) => {
      live();
      return await call.employee.page(request);
    },
  };
  let written = 0;
  // One employee at a time, each written before the next is read: one trace is held, never two.
  for (const { id } of named.employees) {
    const piece = `${written === 0 ? '' : ','}\n${FILE_INDENT.repeat(2)}${printedAt(await assembleTrace(id, guarded, OWNER_SCOPED_SECTIONS), 2)}`;
    live();
    await sink.write(piece);
    written += 1;
    options.onProgress?.({ written, employees });
  }
  live();
  await sink.write(
    `${written === 0 ? '' : `\n${FILE_INDENT}`}],\n${FILE_INDENT}"setAside": ${printedAt(named.setAside, 1)},\n${FILE_INDENT}"omittedAgents": ${employees - written}\n}\n`,
  );
  return manifest;
}

/**
 * The owner export assembled whole in memory, for a file small enough to hold (a test, a bed of a
 * few employees): {@link streamOwnerExport}'s pieces, read back as the file they make. A browser
 * and the command write the pieces to a file as they arrive instead.
 *
 * @param call - The owner export's head and pages, and one employee's (as {@link assembleTrace}
 *   takes them).
 * @returns The one file's contents, with the counts in its manifest.
 * @throws Error when a page answers for a section other than the one asked for, or a cursor it
 *   gave before.
 */
export async function assembleOwnerExport(call: OwnerExportCalls): Promise<OwnerExport> {
  const pieces: string[] = [];
  await streamOwnerExport(call, {
    write: async (chunk) => {
      pieces.push(chunk);
      await Promise.resolve();
    },
  });
  return JSON.parse(pieces.join('')) as OwnerExport;
}

/**
 * A parsed file as an owner export this release reads, or undefined: its format, its version,
 * every owner section, and every employee a trace this release reads.
 *
 * @param value - The parsed file.
 */
export function readOwnerExport(value: unknown): OwnerExport | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const { manifest, owner, employees, setAside } = value as Record<string, unknown>;
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    (manifest as Record<string, unknown>).format !== OWNER_EXPORT_FORMAT ||
    !OWNER_READABLE_VERSIONS.has((manifest as Record<string, unknown>).version) ||
    owner === null ||
    typeof owner !== 'object' ||
    !OWNER_SECTIONS.every((section) =>
      Array.isArray((owner as Record<string, unknown>)[section]),
    ) ||
    !Array.isArray(employees) ||
    !Array.isArray(setAside)
  ) {
    return undefined;
  }
  const traces = employees.map(readAgentTrace);
  if (traces.some((trace) => trace === undefined)) return undefined;
  return { ...(value as OwnerExport), employees: traces as AgentTrace[] };
}

/**
 * Each employee's trace of an owner export with the owner's people graph filled back into it, so
 * it reads as that employee's own export would.
 *
 * @param file - The owner export.
 */
export function employeeTracesOf(file: OwnerExport): AgentTrace[] {
  return file.employees.map((trace) => ({
    ...trace,
    sections: {
      ...trace.sections,
      people: file.owner.people,
      personIdentities: file.owner.personIdentities,
      relationships: file.owner.relationships,
    },
  }));
}
