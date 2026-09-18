/**
 * The company bed's Linear calls, over the rehearsal's GraphQL client.
 *
 * The bed owns exactly what carries its marker: an issue whose description
 * ends with `day0-demo-key: <key>`, and the label seed created (its
 * description says so). Everything here reads or writes by id with the ids as
 * variables, so the key never travels in a query string and a test double can
 * answer each named document.
 */

import { endsWithProvenanceTrailer } from '../../src/surfaces/policy';
import { LinearClient } from '../rehearsal/linear';

export { LinearClient };

/** The line that makes an issue the bed's, and names which ticket it is. */
export const MARKER_PREFIX = 'day0-demo-key: ';
/** What the label seed creates says about itself, so teardown removes only its own. */
export const LABEL_DESCRIPTION = 'Day0 company bed: created by pnpm bed:company seed, removed by teardown.';
const MARKER_LINE = /(?:^|\n)day0-demo-key: ([a-z0-9-]+)\s*$/;
const PAGE_SIZE = 100;
const MAX_PAGES = 20;

export interface WorkspaceTeam {
  id: string;
  key: string;
  name: string;
  states: Array<{ id: string; name: string }>;
  projects: Array<{ id: string; name: string }>;
}

export interface Workspace {
  viewer: { id: string; name: string };
  organization: string;
  teams: WorkspaceTeam[];
}

export interface BedIssue {
  id: string;
  identifier: string;
  key: string;
  title: string;
  description: string;
  archived: boolean;
  teamId: string;
  projectId: string | null;
  stateId: string;
  stateName: string;
  assigneeId: string | null;
  labelIds: string[];
}

export interface ProjectIssue {
  id: string;
  identifier: string;
  title: string;
  projectName: string;
}

/** A ticket a Day0 run filed: its description ends with the server's provenance trailer. */
export interface RunIssue {
  id: string;
  identifier: string;
  title: string;
  /** When Linear says it was created, as an ISO timestamp. */
  createdAt: string;
}

export interface BedLabel {
  id: string;
  description: string | null;
}

const WORKSPACE = `query BedWorkspace($keys: [String!]!) {
  viewer { id name }
  organization { name }
  teams(filter: { key: { in: $keys } }) {
    nodes {
      id
      key
      name
      states { nodes { id name } }
      projects(first: 100) { nodes { id name } }
    }
  }
}`;

const LABELS = `query BedLabels($name: String!) {
  issueLabels(filter: { name: { eq: $name } }) { nodes { id description } }
}`;

const LABEL_CREATE = `mutation BedLabelCreate($input: IssueLabelCreateInput!) {
  issueLabelCreate(input: $input) { success issueLabel { id } }
}`;

const LABEL_DELETE = `mutation BedLabelDelete($id: String!) {
  issueLabelDelete(id: $id) { success }
}`;

const BED_ISSUES = `query BedIssues($after: String) {
  issues(
    filter: { description: { contains: "${MARKER_PREFIX}" } }
    includeArchived: true
    first: ${PAGE_SIZE}
    after: $after
  ) {
    nodes {
      id
      identifier
      title
      description
      archivedAt
      team { id }
      project { id }
      state { id name }
      assignee { id }
      labels { nodes { id } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const PROJECT_ISSUES = `query BedProjectIssues($projectIds: [ID!]!, $after: String) {
  issues(filter: { project: { id: { in: $projectIds } } }, first: ${PAGE_SIZE}, after: $after) {
    nodes { id identifier title description project { name } }
    pageInfo { hasNextPage endCursor }
  }
}`;

/** What every provenance trailer contains; the filter narrows the read, the last line decides. */
const TRAILER_FRAGMENT = '(Day0) · run ';

const RUN_ISSUES = `query BedRunIssues($teamIds: [ID!]!, $after: String) {
  issues(
    filter: { team: { id: { in: $teamIds } }, description: { contains: "${TRAILER_FRAGMENT}" } }
    first: ${PAGE_SIZE}
    after: $after
  ) {
    nodes { id identifier title description createdAt }
    pageInfo { hasNextPage endCursor }
  }
}`;

const ISSUE_CREATE = `mutation BedIssueCreate($input: IssueCreateInput!) {
  issueCreate(input: $input) { success issue { id identifier } }
}`;

const ISSUE_UPDATE = `mutation BedIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) { success }
}`;

const ISSUE_ARCHIVE = `mutation BedIssueArchive($id: String!) {
  issueArchive(id: $id) { success }
}`;

const ISSUE_UNARCHIVE = `mutation BedIssueUnarchive($id: String!) {
  issueUnarchive(id: $id) { success }
}`;

/**
 * The description a bed ticket carries: its own words, then the marker line.
 *
 * Args:
 *   description: The ticket's words as tracked.
 *   key: The ticket's key.
 *
 * Returns:
 *   The description to write.
 */
export function markedDescription(description: string, key: string): string {
  return `${description.trim()}\n\n${MARKER_PREFIX}${key}`;
}

/**
 * The bed key an issue's description is marked with.
 *
 * Args:
 *   description: The issue's description.
 *
 * Returns:
 *   The key, or undefined when the issue is not the bed's.
 */
export function markerKey(description: string | null | undefined): string | undefined {
  return MARKER_LINE.exec(description ?? '')?.[1];
}

/**
 * The key's user, the workspace, and the teams the bed names.
 *
 * Args:
 *   client: The client.
 *   keys: Team keys.
 *
 * Returns:
 *   What exists; a team missing from the answer does not exist.
 */
export async function readWorkspace(client: LinearClient, keys: readonly string[]): Promise<Workspace> {
  const data = await client.request<{
    viewer: { id: string; name: string };
    organization: { name: string };
    teams: {
      nodes: Array<{
        id: string;
        key: string;
        name: string;
        states: { nodes: Array<{ id: string; name: string }> };
        projects: { nodes: Array<{ id: string; name: string }> };
      }>;
    };
  }>(WORKSPACE, { keys: [...keys] });
  return {
    viewer: data.viewer,
    organization: data.organization.name,
    teams: data.teams.nodes.map(
      (team): WorkspaceTeam => ({
        id: team.id,
        key: team.key,
        name: team.name,
        states: team.states.nodes,
        projects: team.projects.nodes,
      }),
    ),
  };
}

/** The workspace label with this exact name, if there is one. */
export async function readLabel(client: LinearClient, name: string): Promise<BedLabel | undefined> {
  const data = await client.request<{ issueLabels: { nodes: BedLabel[] } }>(LABELS, { name });
  return data.issueLabels.nodes[0];
}

/** Create the bed's workspace label, saying in its description that seed made it. */
export async function createLabel(client: LinearClient, name: string): Promise<string> {
  const data = await client.request<{ issueLabelCreate: { success: boolean; issueLabel: { id: string } | null } }>(
    LABEL_CREATE,
    { input: { name, description: LABEL_DESCRIPTION, color: '#5e6ad2' } },
  );
  if (!data.issueLabelCreate.success || !data.issueLabelCreate.issueLabel) {
    throw new Error(`Linear issueLabelCreate ${name} did not succeed.`);
  }
  return data.issueLabelCreate.issueLabel.id;
}

/** Delete one label. */
export async function deleteLabel(client: LinearClient, id: string): Promise<void> {
  const data = await client.request<{ issueLabelDelete: { success: boolean } }>(LABEL_DELETE, { id });
  if (!data.issueLabelDelete.success) throw new Error(`Linear issueLabelDelete ${id} did not succeed.`);
}

/**
 * Every issue carrying the bed's marker, archived ones included.
 *
 * Args:
 *   client: The client.
 *
 * Returns:
 *   The bed's issues; an issue whose description only mentions the prefix
 *   without ending in a marker line is not one of them.
 */
export async function readBedIssues(client: LinearClient): Promise<BedIssue[]> {
  const issues: BedIssue[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request<{
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          description: string | null;
          archivedAt: string | null;
          team: { id: string };
          project: { id: string } | null;
          state: { id: string; name: string };
          assignee: { id: string } | null;
          labels: { nodes: Array<{ id: string }> };
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(BED_ISSUES, { after: after ?? null });
    for (const node of data.issues.nodes) {
      const key = markerKey(node.description);
      if (!key) continue;
      issues.push({
        id: node.id,
        identifier: node.identifier,
        key,
        title: node.title,
        description: node.description ?? '',
        archived: node.archivedAt !== null,
        teamId: node.team.id,
        projectId: node.project?.id ?? null,
        stateId: node.state.id,
        stateName: node.state.name,
        assigneeId: node.assignee?.id ?? null,
        labelIds: node.labels.nodes.map((label) => label.id),
      });
    }
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`Linear listed more than ${MAX_PAGES * PAGE_SIZE} marked issues; refusing to guess which are the bed's.`);
}

/**
 * The open issues in the bed's projects that are not the bed's own.
 *
 * Intake reads every issue in a documented project, so one of these is work
 * a new deployment would take up beside the bed's tickets.
 *
 * Args:
 *   client: The client.
 *   projectIds: The bed's projects.
 *
 * Returns:
 *   The unmarked issues, unarchived only.
 */
export async function readForeignIssues(
  client: LinearClient,
  projectIds: readonly string[],
): Promise<ProjectIssue[]> {
  if (projectIds.length === 0) return [];
  const issues: ProjectIssue[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request<{
      issues: {
        nodes: Array<{
          id: string;
          identifier: string;
          title: string;
          description: string | null;
          project: { name: string } | null;
        }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(PROJECT_ISSUES, { projectIds: [...projectIds], after: after ?? null });
    for (const node of data.issues.nodes) {
      if (markerKey(node.description)) continue;
      issues.push({
        id: node.id,
        identifier: node.identifier,
        title: node.title,
        projectName: node.project?.name ?? '',
      });
    }
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`Linear listed more than ${MAX_PAGES * PAGE_SIZE} issues in the bed's projects.`);
}

/**
 * The unarchived tickets in the bed's teams that a Day0 run filed.
 *
 * An employee whose charter says to triage asks into tickets files one under
 * the shared key, and the server signs its description. Such a ticket carries
 * no bed marker and may sit in no project, so neither other read finds it.
 *
 * Args:
 *   client: The client.
 *   teamIds: The bed's teams.
 *
 * Returns:
 *   The tickets whose description ends with a provenance trailer and carries
 *   no bed marker; one that only quotes a trailer is not among them.
 */
export async function readRunIssues(client: LinearClient, teamIds: readonly string[]): Promise<RunIssue[]> {
  if (teamIds.length === 0) return [];
  const issues: RunIssue[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await client.request<{
      issues: {
        nodes: Array<{ id: string; identifier: string; title: string; description: string | null; createdAt: string }>;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
      };
    }>(RUN_ISSUES, { teamIds: [...teamIds], after: after ?? null });
    for (const node of data.issues.nodes) {
      if (markerKey(node.description) || !endsWithProvenanceTrailer(node.description ?? '')) continue;
      issues.push({ id: node.id, identifier: node.identifier, title: node.title, createdAt: node.createdAt });
    }
    if (!data.issues.pageInfo.hasNextPage || !data.issues.pageInfo.endCursor) return issues;
    after = data.issues.pageInfo.endCursor;
  }
  throw new Error(`Linear listed more than ${MAX_PAGES * PAGE_SIZE} run-filed issues in the bed's teams.`);
}

/** Create one issue and return its id and identifier. */
export async function createIssue(
  client: LinearClient,
  input: Record<string, unknown>,
): Promise<{ id: string; identifier: string }> {
  const data = await client.request<{
    issueCreate: { success: boolean; issue: { id: string; identifier: string } | null };
  }>(ISSUE_CREATE, { input });
  if (!data.issueCreate.success || !data.issueCreate.issue) {
    throw new Error('Linear issueCreate did not succeed.');
  }
  return data.issueCreate.issue;
}

/** Update the named fields of one issue. */
export async function updateIssue(
  client: LinearClient,
  id: string,
  input: Record<string, unknown>,
): Promise<void> {
  const data = await client.request<{ issueUpdate: { success: boolean } }>(ISSUE_UPDATE, { id, input });
  if (!data.issueUpdate.success) throw new Error(`Linear issueUpdate on ${id} did not succeed.`);
}

/** Archive one issue. */
export async function archiveIssue(client: LinearClient, id: string): Promise<void> {
  const data = await client.request<{ issueArchive: { success: boolean } }>(ISSUE_ARCHIVE, { id });
  if (!data.issueArchive.success) throw new Error(`Linear issueArchive on ${id} did not succeed.`);
}

/** Bring one archived issue back. */
export async function unarchiveIssue(client: LinearClient, id: string): Promise<void> {
  const data = await client.request<{ issueUnarchive: { success: boolean } }>(ISSUE_UNARCHIVE, { id });
  if (!data.issueUnarchive.success) throw new Error(`Linear issueUnarchive on ${id} did not succeed.`);
}
