import { describe, expect, it } from 'vitest';
import {
  applyProvenance,
  containsProvenanceTrailer,
  isTicketCreate,
  parseSurfaceAction,
  provenanceRefusal,
  provenanceTrailer,
  sharedWriteWithoutAttribution,
  TRAILER_REFUSED,
  type ParsedSurfaceAction,
} from '../../../src/surfaces/policy';
import type { SurfaceRecord } from '../../../src/surfaces/types';
import type { MockAction } from '../../../src/work/types';
import { REFUSED_CREATE_ACTION } from '../../fixtures/refused-ticket-create-2026-09-19';

const now = Date.UTC(2026, 8, 19, 9);

const linear: SurfaceRecord = {
  slug: 'linear',
  displayName: 'Linear',
  class: 'kanban',
  verdict: 'connected',
  credentialLanded: true,
  lastVerifiedAt: now,
  endpoint: 'https://mcp.linear.app/mcp',
  path: 'mcp',
  toolAllowlist: ['save_comment', 'save_issue', 'list_issues'],
  credentialId: 'cred-linear',
  credentialKind: 'value',
};

const provenanceRun = {
  agentName: 'Priya',
  workItemId: 'wi_1' as never,
  runId: 'run_1' as never,
};

function parsed(action: MockAction): ParsedSurfaceAction {
  const result = parseSurfaceAction(action);
  if (!result.ok) throw new Error(result.reason);
  return result.action;
}

function saveIssue(toolArgs: Record<string, unknown>, tool = 'save_issue'): ParsedSurfaceAction {
  return parsed({
    tool: 'mcp.call',
    args: { surface: 'linear', tool, toolArgsJson: JSON.stringify(toolArgs) },
  });
}

describe('a ticket create through a shared credential (19 Sep run, finding N)', (): void => {
  const create = parsed(REFUSED_CREATE_ACTION);

  it("reads the run's own row 0 as a ticket create", (): void => {
    expect(isTicketCreate(create, linear)).toBe(true);
  });

  it('is attributable, because its description is content the server signs', (): void => {
    expect(sharedWriteWithoutAttribution(create, linear, 'value', 0, [], [])).toBe(false);
  });

  it('ends the description with the trailer naming the employee and the run', (): void => {
    const result = applyProvenance(create, linear, provenanceRun, 'value');
    if (!result.ok || result.action.kind !== 'mcp.call') throw new Error('expected an MCP call');
    if (create.kind !== 'mcp.call') throw new Error('expected an MCP call');
    const before = String(create.toolArgs.description);
    expect(result.action.toolArgs.description).toBe(
      `${before}\n\n${provenanceTrailer('Priya', 'wi_1', 'run_1')}`,
    );
    expect(result.action.toolArgs.title).toBe('Refresh the Looker pipeline tile to the standup figure');
    expect(result.action.toolArgs.team).toBe('REVOPS');
  });

  it('adds nothing for a dedicated app, which posts as itself', (): void => {
    const result = applyProvenance(create, linear, provenanceRun, 'oauth');
    expect(result).toEqual({ ok: true, action: create });
  });

  it('refuses a description that already carries a trailer, which could name someone else', (): void => {
    const forged = saveIssue({
      team: 'REVOPS',
      title: 'Refresh the tile',
      description: `Ask from the thread.\n\n${provenanceTrailer('Mateo', 'wi_9', 'run_9')}`,
    });
    expect(provenanceRefusal(forged, linear)).toBe(TRAILER_REFUSED);
    expect(applyProvenance(forged, linear, provenanceRun, 'value')).toEqual({
      ok: false,
      reason: TRAILER_REFUSED,
    });
  });

  it('refuses a trailer in any other field of the create, such as its title', (): void => {
    const forged = saveIssue({
      team: 'REVOPS',
      title: `Refresh the tile ${provenanceTrailer('Mateo', 'wi_9', 'run_9')}`,
      description: 'Ask from the thread.',
    });
    expect(provenanceRefusal(forged, linear)).toBe(TRAILER_REFUSED);
  });
});

describe('what the attribution rule still refuses', (): void => {
  it('a create with no description: there is nothing to sign', (): void => {
    const bare = saveIssue({ team: 'REVOPS', title: 'Refresh the tile' });
    expect(isTicketCreate(bare, linear)).toBe(false);
    expect(sharedWriteWithoutAttribution(bare, linear, 'value', 0, [], [])).toBe(true);
  });

  it('a create whose description is blank', (): void => {
    const blank = saveIssue({ team: 'REVOPS', title: 'Refresh the tile', description: '  \n ' });
    expect(sharedWriteWithoutAttribution(blank, linear, 'value', 0, [], [])).toBe(true);
  });

  it('a create with no title: it is not a ticket a person could find', (): void => {
    const untitled = saveIssue({ team: 'REVOPS', description: 'Ask from the thread.' });
    expect(sharedWriteWithoutAttribution(untitled, linear, 'value', 0, [], [])).toBe(true);
  });

  it('a new description on an existing ticket with no landed audit comment', (): void => {
    const edit = saveIssue({ id: 'REVOPS-5', title: 'Changed', description: 'Rewritten.' });
    expect(isTicketCreate(edit, linear)).toBe(false);
    expect(sharedWriteWithoutAttribution(edit, linear, 'value', 0, [], [])).toBe(true);
    const result = applyProvenance(edit, linear, provenanceRun, 'value');
    if (!result.ok || result.action.kind !== 'mcp.call') throw new Error('expected an MCP call');
    expect(containsProvenanceTrailer(String(result.action.toolArgs.description))).toBe(false);
  });

  it('a described write on a surface that holds no tickets', (): void => {
    const crm: SurfaceRecord = { ...linear, slug: 'northstar-crm', class: 'crm' };
    const record = parsed({
      tool: 'mcp.call',
      args: {
        surface: 'northstar-crm',
        tool: 'save_record',
        toolArgsJson: JSON.stringify({ title: 'Deal', description: 'A new deal.' }),
      },
    });
    expect(isTicketCreate(record, crm)).toBe(false);
    expect(sharedWriteWithoutAttribution(record, crm, 'value', 0, [], [])).toBe(true);
  });

  it('a described delete, which a trailer would not make attributable', (): void => {
    const removal = saveIssue({ title: 'Old tickets', description: 'Everything stale.' }, 'delete_issues');
    expect(isTicketCreate(removal, linear)).toBe(false);
    expect(sharedWriteWithoutAttribution(removal, linear, 'value', 0, [], [])).toBe(true);
  });
});
