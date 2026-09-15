/**
 * What the rehearsal reads from the bed's backend, through the same public
 * queries the dashboard renders from, and the pure selections over those rows
 * every wait and check is written against.
 */
import type { WorkItemView } from './checks';

export interface AgentRow {
  _id: string;
  name: string;
  state: string;
  createdAt: number;
}

export interface CharterRow {
  _id: string;
  approved: boolean;
}

export interface SurfaceRow {
  _id: string;
  slug: string;
  displayName: string;
  class: string;
  verdict: string;
  credentialLanded: boolean;
  managerApprovedAt?: number;
  itApprovedAt?: number;
  reason?: string;
}

export interface DocSourceRow {
  _id: string;
  label: string;
  status: string;
  pageCount: number;
  lastError?: string;
}

export interface SkillRow {
  _id: string;
  name: string;
  state: string;
  proposedFor?: string;
}

export interface WorkItemRow extends WorkItemView {
  _id: string;
  sourceSystem: string;
  externalId: string;
  title: string;
  skipReason?: string;
  verdict?: { decision?: string; reason?: string };
  proposedSkillId?: string;
}

export interface EventRow {
  _id: string;
  type: string;
  payload: unknown;
  createdAt: number;
}

/** The reads the rehearsal makes; a test hands in rows, the run hands in the client. */
export interface BackendReader {
  agents(): Promise<AgentRow[]>;
  charter(agentId: string): Promise<CharterRow | null>;
  surfaces(agentId: string): Promise<SurfaceRow[]>;
  docSources(): Promise<DocSourceRow[]>;
  skills(agentId: string, state: 'proposed' | 'registered'): Promise<SkillRow[]>;
  workItems(agentId: string): Promise<WorkItemRow[]>;
  workItem(id: string): Promise<WorkItemRow | null>;
  events(agentId: string, limit: number): Promise<EventRow[]>;
}

/**
 * A reader over the bed's deployment as the local boss.
 *
 * Args:
 *   url: The backend's URL on the host.
 *   signingKey: The bed's `DEV_NO_AUTH_SIGNING_KEY`, which mints the token.
 *
 * Returns:
 *   The reader, plus the raw client for the export action.
 */
export async function connectBackend(
  url: string,
  signingKey: string,
): Promise<{ reader: BackendReader; exportForAgent: (agentId: string) => Promise<unknown> }> {
  process.env.DEV_NO_AUTH_SIGNING_KEY = signingKey;
  const { ConvexHttpClient } = await import('convex/browser');
  const { mintDevNoAuthToken } = await import('../../src/lib/dev-auth-token');
  const { api } = await import('../../convex/_generated/api');
  type Id<T extends string> = string & { __tableName: T };
  const client = new ConvexHttpClient(url, { skipConvexDeploymentUrlCheck: true, logger: false });
  client.setAuth(await mintDevNoAuthToken());
  const agentId = (id: string): Id<'agents'> => id as Id<'agents'>;
  const reader: BackendReader = {
    agents: async () => (await client.query(api.agents.listForUser, {})) as AgentRow[],
    charter: async (id) =>
      (await client.query(api.charters.latest, { agentId: agentId(id) })) as CharterRow | null,
    surfaces: async (id) =>
      (await client.query(api.surfaces.listForAgent, { agentId: agentId(id) })) as SurfaceRow[],
    docSources: async () => (await client.query(api.docSources.listMine, {})) as DocSourceRow[],
    skills: async (id, state) =>
      (await client.query(state === 'proposed' ? api.skills.proposed : api.skills.registered, {
        agentId: agentId(id),
      })) as SkillRow[],
    workItems: async (id) =>
      (await client.query(api.work.listForAgent, { agentId: agentId(id) })) as WorkItemRow[],
    workItem: async (id) =>
      (await client.query(api.work.get, { workItemId: id as Id<'workItems'> })) as WorkItemRow | null,
    events: async (id, limit) =>
      (await client.query(api.events.recent, { agentId: agentId(id), limit })) as EventRow[],
  };
  return {
    reader,
    exportForAgent: async (id) =>
      await client.action(api.exportActions.exportForAgent, { agentId: agentId(id) }),
  };
}

/** The ticket the rehearsal works. */
export const TICKET = 'REVOPS-7';

/** The browser-driven surface the runbook refreshes. */
export const TILE_SLUG = 'looker-pipeline-tile';

/** The surfaces the run lands and approves, by slug, with the credential each takes. */
export const CARDS: ReadonlyArray<{ slug: string; credential: 'linear' | 'slack' | 'none' }> = [
  { slug: 'linear', credential: 'linear' },
  { slug: TILE_SLUG, credential: 'none' },
  { slug: 'slack', credential: 'slack' },
];

/**
 * The newest agent with a name.
 *
 * Args:
 *   agents: The boss's agents, newest first.
 *   name: The name deployed.
 *
 * Returns:
 *   The agent, or undefined.
 */
export function agentNamed(agents: readonly AgentRow[], name: string): AgentRow | undefined {
  return agents.find((agent: AgentRow): boolean => agent.name === name);
}

/**
 * Whether every linked source has synced with at least one page.
 *
 * Args:
 *   sources: The boss's sources.
 *
 * Returns:
 *   True when there is at least one source and none is still linking or in error.
 */
export function allSourcesSynced(sources: readonly DocSourceRow[]): boolean {
  return (
    sources.length > 0 &&
    sources.every((source: DocSourceRow): boolean => source.status === 'synced' && source.pageCount > 0)
  );
}

/**
 * The source that failed, for the record.
 *
 * Args:
 *   sources: The boss's sources.
 *
 * Returns:
 *   The first source in error, or undefined.
 */
export function failedSource(sources: readonly DocSourceRow[]): DocSourceRow | undefined {
  return sources.find((source: DocSourceRow): boolean => source.status === 'error');
}

/** A surface by slug. */
export function surfaceBySlug(surfaces: readonly SurfaceRow[], slug: string): SurfaceRow | undefined {
  return surfaces.find((surface: SurfaceRow): boolean => surface.slug === slug);
}

/**
 * Whether orientation has finished: no surface is still `declared`, and the
 * three cards the run needs are proposed.
 *
 * Args:
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   True when the cards can be acted on.
 */
export function orientationDone(surfaces: readonly SurfaceRow[]): boolean {
  if (surfaces.length === 0) return false;
  if (surfaces.some((surface: SurfaceRow): boolean => surface.verdict === 'declared')) return false;
  return CARDS.every((card) => surfaceBySlug(surfaces, card.slug) !== undefined);
}

/**
 * One line per surface, for the record.
 *
 * Args:
 *   surfaces: The agent's surfaces.
 *
 * Returns:
 *   `slug: verdict` joined with commas.
 */
export function surfaceSummary(surfaces: readonly SurfaceRow[]): string {
  return surfaces
    .map((surface: SurfaceRow): string => `${surface.slug}: ${surface.verdict}`)
    .join(', ');
}

/**
 * The work item for the ticket.
 *
 * Args:
 *   items: The agent's work items.
 *   identifier: The ticket identifier.
 *
 * Returns:
 *   The item whose external id is the ticket, or undefined before intake.
 */
export function ticketItem(items: readonly WorkItemRow[], identifier: string = TICKET): WorkItemRow | undefined {
  return items.find(
    (item: WorkItemRow): boolean =>
      item.externalId === identifier || item.externalId.endsWith(`/${identifier}`) || item.title.startsWith(identifier),
  );
}

/**
 * Other items holding an open claim, which under the cold-start cap of one
 * would keep the ticket from being claimed.
 *
 * Args:
 *   items: The agent's work items.
 *   ticketId: The ticket's item id.
 *
 * Returns:
 *   The items in an open state that are not the ticket.
 */
export function competingClaims(items: readonly WorkItemRow[], ticketId: string): WorkItemRow[] {
  const open = new Set(['claimed', 'plan-pending', 'plan-approved', 'executing', 'actions-pending']);
  return items.filter((item: WorkItemRow): boolean => item._id !== ticketId && open.has(item.state));
}

export type SkipKind = 'quality-fit' | 'out-of-scope' | 'other';

/**
 * Why an item was skipped, in the three classes the run treats differently.
 *
 * Args:
 *   item: A skipped item.
 *
 * Returns:
 *   `quality-fit` (the card's Retry waives the filter), `out-of-scope` (the
 *   charter wording defect; a recorded stop), or `other`.
 */
export function skipKind(item: Pick<WorkItemRow, 'skipReason'>): SkipKind {
  const reason = item.skipReason ?? '';
  if (reason.startsWith('quality-fit-fail:')) return 'quality-fit';
  if (reason.startsWith('out-of-scope')) return 'out-of-scope';
  return 'other';
}

/**
 * Whether the parked item's phase-one batch is waiting for the manager.
 *
 * Args:
 *   item: The item.
 *
 * Returns:
 *   True at `actions-pending` with at least one held verdict.
 */
export function batchHeld(item: Pick<WorkItemRow, 'state' | 'actionVerdicts'>): boolean {
  return (
    item.state === 'actions-pending' &&
    (item.actionVerdicts ?? []).some((verdict): boolean => verdict.disposition === 'held')
  );
}
