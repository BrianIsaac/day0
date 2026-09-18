import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSurfaceAction, type ParsedSurfaceAction } from '../../../src/surfaces/policy';
import type { MockAction } from '../../../src/work/types';
import {
  browserFieldId,
  documentedBrowserFields,
  heldElsewhereLines,
  heldItemReplyFindings,
  plannedWriteTargets,
  providerItemKey,
  withHeldItemsSaid,
  withheldByClaim,
  withheldByClaimReason,
  writeTargetIds,
  type ClaimKeySurface,
  type HeldExternalItem,
} from '../../../src/work/claim-key';

const linear: ClaimKeySurface = {
  slug: 'linear',
  class: 'kanban',
  path: 'mcp',
  endpoint: 'https://mcp.linear.app/mcp',
};

const slack = (workspace: string, slug = 'slack'): ClaimKeySurface => ({
  slug,
  class: 'chat',
  path: 'documented-api',
  endpoint: 'https://slack.com/api/',
  providerWorkspaceId: workspace,
});

const jira: ClaimKeySurface = {
  slug: 'jira',
  class: 'kanban',
  path: 'documented-api',
  endpoint: 'https://acme.atlassian.net/rest/api/3',
};

const ISSUE = '6f1c2d3e-4b5a-4c6d-8e7f-9a0b1c2d3e4f';
const ASK = 'C0OPSREQ:1789000000.000100';

describe('providerItemKey', (): void => {
  it('keys a Linear issue by its provider id', (): void => {
    expect(providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real')).toBe(
      `linear:${ISSUE}`,
    );
  });

  it('gives one Linear issue one key whatever the surface is called', (): void => {
    const finance = { ...linear, slug: 'linear-finance' };
    const key = providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real');
    expect(key).toBeDefined();
    expect(providerItemKey(finance, { sourceSystem: 'linear-finance', externalId: ISSUE }, 'real')).toBe(key);
  });

  it('gives one Linear issue one key whichever Linear API the surface reads it over', (): void => {
    const graphql = { slug: 'linear-api', class: 'kanban', path: 'documented-api', endpoint: 'https://api.linear.app/graphql' };
    expect(providerItemKey(graphql, { sourceSystem: 'linear-api', externalId: ISSUE }, 'real')).toBe(
      `linear:${ISSUE}`,
    );
    const lookalike = { ...graphql, endpoint: 'https://linear.app.example.com/graphql' };
    expect(providerItemKey(lookalike, { sourceSystem: 'linear-api', externalId: ISSUE }, 'real')).toBe(
      `https://linear.app.example.com|${ISSUE}`,
    );
  });

  it('keys a Slack message by its workspace, channel and timestamp', (): void => {
    expect(providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real')).toBe(
      `slack:T0COMPANY:${ASK}`,
    );
  });

  it('never lets two Slack workspaces collide on one channel and timestamp', (): void => {
    const first = providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    const second = providerItemKey(slack('T0PARTNER'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    expect(first).toBeDefined();
    expect(second).toBeDefined();
    expect(first).not.toBe(second);
  });

  it('gives one Slack message one key on two surfaces of the same workspace', (): void => {
    const key = providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real');
    expect(key).toBeDefined();
    expect(
      providerItemKey(slack('T0COMPANY', 'slack-ops'), { sourceSystem: 'slack-ops', externalId: ASK }, 'real'),
    ).toBe(key);
  });

  it('gives one Slack message one key over its API and browser surface', (): void => {
    const browser = {
      ...slack('T0COMPANY', 'slack-browser'),
      path: 'browser-driven',
      endpoint: 'https://app.slack.com/client/T0COMPANY/C0OPSREQ',
    };
    expect(providerItemKey(browser, { sourceSystem: 'slack-browser', externalId: ASK }, 'real')).toBe(
      `slack:T0COMPANY:${ASK}`,
    );
  });

  it('keys any other surface by its endpoint origin and the external id', (): void => {
    expect(providerItemKey(jira, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'real')).toBe(
      'https://acme.atlassian.net|OPS-12',
    );
    const agile = { ...jira, slug: 'jira-agile', endpoint: 'https://acme.atlassian.net/rest/agile/1.0' };
    expect(providerItemKey(agile, { sourceSystem: 'jira-agile', externalId: 'OPS-12' }, 'real')).toBe(
      'https://acme.atlassian.net|OPS-12',
    );
  });

  it('falls back to the slug when the surface has no endpoint or is gone', (): void => {
    const unlisted = { slug: 'tracker', class: 'kanban' };
    expect(providerItemKey(unlisted, { sourceSystem: 'tracker', externalId: 'T-1' }, 'real')).toBe(
      'slug:tracker|T-1',
    );
    expect(providerItemKey(undefined, { sourceSystem: 'tracker', externalId: 'T-1' }, 'real')).toBe(
      'slug:tracker|T-1',
    );
  });

  it('keeps the kinds of key apart', (): void => {
    const keys = [
      providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'real'),
      providerItemKey(undefined, { sourceSystem: 'linear', externalId: ISSUE }, 'real'),
      providerItemKey(jira, { sourceSystem: 'jira', externalId: ISSUE }, 'real'),
      providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'real'),
      providerItemKey(undefined, { sourceSystem: 'slack', externalId: `T0COMPANY:${ASK}` }, 'real'),
    ];
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keys nothing in mock mode', (): void => {
    expect(providerItemKey(linear, { sourceSystem: 'linear', externalId: ISSUE }, 'mock')).toBeUndefined();
    expect(providerItemKey(slack('T0COMPANY'), { sourceSystem: 'slack', externalId: ASK }, 'mock')).toBeUndefined();
    expect(providerItemKey(jira, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'mock')).toBeUndefined();
    expect(providerItemKey(undefined, { sourceSystem: 'jira', externalId: 'OPS-12' }, 'mock')).toBeUndefined();
  });
});

const parsedCall = (tool: string, toolArgs: Record<string, unknown>): ParsedSurfaceAction => {
  const parsed = parseSurfaceAction({ tool: 'mcp.call', args: { surface: 'linear', tool, toolArgsJson: JSON.stringify(toolArgs) } });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.action;
};

const parsedPost = (body: Record<string, unknown>): ParsedSurfaceAction => {
  const parsed = parseSurfaceAction({
    tool: 'http.request',
    args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', body: JSON.stringify(body) },
  });
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.action;
};

describe('writeTargetIds', (): void => {
  it('names the ticket a comment or a state change addresses, as intake stores it', (): void => {
    expect(writeTargetIds(parsedCall('save_comment', { issueId: 'FIN-1', body: 'note' }), linear)).toEqual(['FIN-1', 'fin-1']);
    expect(writeTargetIds(parsedCall('save_issue', { id: 'fin-1', state: 'Done' }), linear)).toEqual(['fin-1', 'FIN-1']);
  });

  it('names the message a thread reply sits under, and nothing for a top-level post', (): void => {
    const chat = slack('T0COMPANY');
    expect(writeTargetIds(parsedPost({ channel: 'C0OPSREQ', thread_ts: '1789000000.000100', text: 'hello' }), chat)).toEqual([ASK]);
    expect(writeTargetIds(parsedPost({ channel: 'C0OPSREQ', text: 'hello' }), chat)).toEqual([]);
  });

  it('reads a documented-API ticket write from its path and from its body, nested as GraphQL nests it', (): void => {
    const request = (path: string, body: Record<string, unknown>): ParsedSurfaceAction => {
      const parsed = parseSurfaceAction({
        tool: 'http.request',
        args: { surface: 'jira', method: 'POST', path, body: JSON.stringify(body) },
      });
      if (!parsed.ok) throw new Error(parsed.reason);
      return parsed.action;
    };
    expect(writeTargetIds(request('/rest/api/3/issue/OPS-12/comment?expand=x', { body: 'note' }), jira)).toContain('OPS-12');
    const graphql = request('/graphql', { query: 'mutation', variables: { input: { issueId: ISSUE, body: 'note' } } });
    expect(writeTargetIds(graphql, jira)).toContain(ISSUE);
  });

  it('offers a ticket reference in both cases, since a model may print a UUID in capitals', (): void => {
    const id = ['3f2a9c1e', '7b4d', '4e8a', '9c1f', '0a1b2c3d4e5f'].join('-');
    expect(writeTargetIds(parsedCall('save_comment', { issueId: id.toUpperCase(), body: 'note' }), linear)).toContain(id);
    expect(writeTargetIds(parsedCall('save_comment', { issueId: 'fin-1', body: 'note' }), linear)).toContain('FIN-1');
  });

  it('names nothing for a read or a write that addresses no item', (): void => {
    expect(writeTargetIds(parsedCall('get_issue', { id: 'FIN-1' }), linear)).toEqual([]);
    expect(writeTargetIds(parsedCall('list_issues', { team: 'FIN' }), linear)).toEqual([]);
    expect(writeTargetIds(parsedCall('create_project', { name: 'Close' }), linear)).toEqual([]);
  });
});

describe('withheldByClaimReason', (): void => {
  const holder = { target: 'FIN-1', holderName: 'Mateo', sameEmployee: true, title: 'Post the note', state: 'completed' };

  it('names the holder, its state and the comment it landed', (): void => {
    expect(withheldByClaimReason({ ...holder, landedComment: 'c-1' })).toBe(
      'withheld for another work item\'s claim: FIN-1 is held by this employee\'s work item "Post the note" (completed), which landed comment c-1 on it; one work item writes an external item, so this write is not sent',
    );
  });

  it('names a colleague by name', (): void => {
    expect(withheldByClaimReason({ ...holder, sameEmployee: false, state: 'executing' })).toContain(
      'held by Mateo\'s work item "Post the note" (executing);',
    );
  });

  it('says where the write will be made when the holder has not claimed the item yet', (): void => {
    const waiting = { ...holder, state: 'discovered', unclaimed: true };
    expect(withheldByClaimReason(waiting)).toBe(
      'withheld for another work item\'s claim: FIN-1 has its own work item with this employee, "Post the note" (discovered); it will be written there, and one work item writes an external item, so this write is not sent',
    );
    expect(withheldByClaimReason({ ...waiting, sameEmployee: false })).toContain('has its own work item with Mateo, "Post the note"');
    expect(withheldByClaim({ held: true, reason: withheldByClaimReason(waiting) })).toBe(true);
  });
});

/**
 * Finding M of the second full run (19 September): the tile's one documented
 * field, read from the tracked runbook the bed syncs, and the run's own
 * action shapes.
 */
describe('a documented page field of a browser-driven surface', (): void => {
  const SLUG = 'looker-pipeline-tile';
  const runbook = readFileSync(join(process.cwd(), 'bed/company/folder/revops/runbooks/how-to-refresh-the-tile.md'), 'utf8');
  const system = readFileSync(join(process.cwd(), 'bed/company/folder/systems/looker-pipeline-tile.md'), 'utf8');
  const tileSurface: ClaimKeySurface = { slug: SLUG, class: 'analytics', path: 'browser-driven', endpoint: 'http://looker-tile:8080/' };
  const tile = (tool: string, toolArgs: Record<string, unknown>): MockAction => ({
    tool: 'mcp.call', args: { surface: SLUG, tool, toolArgsJson: JSON.stringify(toolArgs) },
  });
  const parsedOf = (action: MockAction): ParsedSurfaceAction => {
    const result = parseSurfaceAction(action);
    if (!result.ok) throw new Error(result.reason);
    return result.action;
  };
  const signIn = tile('browser_fill_form', { fields: [{ name: 'Username', value: 'revops' }, { name: 'Password', value: '{{secret}}' }] });
  const fill = tile('browser_fill_form', { fields: [{ name: 'Pipeline coverage', value: '74%' }] });
  const save = tile('browser_click', { element: 'Save' });

  it('reads the fields from the documented action shapes, never the sign-in form, and nothing for another surface', (): void => {
    expect(documentedBrowserFields([{ body: system }, { body: runbook }], SLUG)).toEqual(['Pipeline coverage']);
    expect(documentedBrowserFields([{ body: runbook }], 'looker')).toEqual([]);
    expect(documentedBrowserFields([{ body: '```json\n{ not json\n```\n```json\n{"args":{"surface":"x"}}\n```' }], SLUG)).toEqual([]);
  });

  it('is taken by a plan that declares an unconditional write to the surface, not by one that writes only if a read says so', (): void => {
    const pages = [{ body: runbook }];
    const surfaces = [tileSurface, linear];
    const write = { steps: [{ kind: 'write', writes: [SLUG] }, { kind: 'write', writes: ['linear'] }] };
    expect(plannedWriteTargets(write, surfaces, pages)).toEqual([{ surfaceSlug: SLUG, field: 'Pipeline coverage' }]);
    expect(plannedWriteTargets({ steps: [{ kind: 'conditional-write', writes: [SLUG] }, { kind: 'read', writes: [] }] }, surfaces, pages)).toEqual([]);
    expect(plannedWriteTargets(undefined, surfaces, pages)).toEqual([]);
    expect(plannedWriteTargets(write, surfaces, [])).toEqual([]);
  });

  it('is what a fill addresses, under one key whatever the case; the sign-in, a click and a read address nothing', (): void => {
    expect(writeTargetIds(parsedOf(fill), tileSurface)).toEqual(['pipeline coverage']);
    expect(writeTargetIds(parsedOf(tile('browser_fill_form', { fields: [{ name: ' PIPELINE Coverage ', value: '74%' }] })), tileSurface)).toEqual(['pipeline coverage']);
    expect(writeTargetIds(parsedOf(signIn), tileSurface)).toEqual([]);
    expect(writeTargetIds(parsedOf(save), tileSurface)).toEqual([]);
    expect(writeTargetIds(parsedOf(tile('browser_snapshot', {})), tileSurface)).toEqual([]);
    expect(providerItemKey(tileSurface, { sourceSystem: SLUG, externalId: browserFieldId('Pipeline coverage') }, 'real')).toBe(
      'http://looker-tile:8080|pipeline coverage',
    );
  });

  const held: HeldExternalItem = {
    externalId: 'Pipeline coverage', sourceSystem: SLUG, holderName: 'Priya', sameEmployee: true,
    title: 'Refresh the Looker pipeline tile', state: 'executing', pageField: true,
  };

  it('is listed for the other work items with the rule that they read the page', (): void => {
    const text = heldElsewhereLines([held]).join('\n');
    expect(text).toContain(`${SLUG} · page field "Pipeline coverage" · this employee · "Refresh the Looker pipeline tile" (executing) · that work item writes it; read the page for its value`);
    expect(text).toContain('A page field listed here is filled and saved by its holder alone');
    // A list of tickets alone reads as it did before.
    expect(heldElsewhereLines([{ ...held, pageField: undefined }]).join('\n')).not.toContain('page field');
  });

  it('owes the reply whose work the field is, as a held ticket does', (): void => {
    const surfaces = [tileSurface, slack('T1')];
    const reply = (text: string): MockAction => ({
      tool: 'http.request',
      args: { surface: 'slack', method: 'POST', path: '/chat.postMessage', headersJson: '{}', body: JSON.stringify({ channel: 'C0BSF04TZ19', thread_ts: '1789761481.815889', text }) },
    });
    const said = 'Pipeline coverage is confirmed at 74% on the Looker pipeline tile.';
    const [finding] = heldItemReplyFindings([signIn, fill, save, reply(said)], [held], surfaces);
    expect(finding!.issue).toContain('this set fills "Pipeline coverage" on looker-pipeline-tile');
    const completed = withHeldItemsSaid([signIn, fill, save, reply(said)], [finding!], surfaces, { channel: 'C0BSF04TZ19', threadTs: '1789761481.815889' });
    expect(JSON.parse(String(completed[3]!.args.body)).text).toBe(
      `${said}\n\nPipeline coverage on looker-pipeline-tile is refreshed by its own work item ("Refresh the Looker pipeline tile"); it was not written from this request.`,
    );
    // A set that only reads the tile owes nothing.
    expect(heldItemReplyFindings([signIn, tile('browser_snapshot', {}), reply(said)], [held], surfaces)).toEqual([]);
  });
});

