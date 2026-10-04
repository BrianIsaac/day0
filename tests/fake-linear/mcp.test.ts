import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LIST_ISSUES_SELECTABLE_FIELDS,
  MCP_INVALID_TOKEN,
  MCP_WITHOUT_BEARER,
} from '../fixtures/linear/linear-oauth-2026-10-02';
import { WALK_SHARED_APP_USER } from '../fixtures/linear/linear-walks-2026-10-03';
import { LINEAR_MCP_REVOKED_TOKEN_ERROR } from '../fixtures/real-vendor-walk-2026-10-03';
import type { FakeLinear } from '../../fake-linear/linear';
import {
  LEO,
  SAM_KEY,
  appActorToken,
  call,
  installPair,
  linear,
  revoke,
  type Answer,
} from './double';

const MCP = 'https://mcp.linear.app/mcp';

/** The Linear surface's tools as the run of 17 September recorded them: name and argument names. */
const RECORDED = (
  JSON.parse(
    readFileSync(new URL('../fixtures/recording-2026-09-17-trace.json', import.meta.url), 'utf8'),
  ) as {
    sections: {
      surfaces: { slug: string; toolArguments: { tool: string; arguments: string[] }[] }[];
    };
  }
).sections.surfaces.find((surface) => surface.slug === 'linear')!.toolArguments;

/** The nine tools the walks saw listed to an app actor alone (R41V-7). */
const DIFF_TOOLS = RECORDED.map((entry) => entry.tool).filter((name) => /diff/.test(name));

let sequence = 0;

/** One JSON-RPC request to the MCP endpoint, as the MCP client sends it. */
async function rpc(
  fake: FakeLinear,
  token: string | undefined,
  method: string,
  params: Record<string, unknown> = {},
): Promise<Answer> {
  sequence += 1;
  return await call(fake, MCP, {
    ...(token === undefined ? {} : { bearer: token }),
    json: { jsonrpc: '2.0', id: sequence, method, params },
  });
}

/** A tool's result, its first text block parsed. */
async function tool(
  fake: FakeLinear,
  token: string,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string; value: unknown }> {
  const answer = await rpc(fake, token, 'tools/call', { name, arguments: args });
  const result = (answer.body as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  const text = result.content[0]?.text ?? '';
  let value: unknown = text;
  try {
    value = JSON.parse(text);
  } catch {
    // A refusal's words, kept as text.
  }
  return { isError: result.isError === true, text, value };
}

/** A ticket filed with the bed key, delegated to an app user. */
async function delegatedTicket(fake: FakeLinear, delegate: string): Promise<string> {
  const created = await tool(fake, SAM_KEY, 'save_issue', {
    team: 'REVOPS',
    title: '[w11 walk] Delegated to Day0 Leo (P6: Leo takes it)',
    project: 'Q3 close',
    assignee: 'me',
    delegate,
  });
  expect(created.isError, created.text).toBe(false);
  return (created.value as { id: string }).id;
}

describe('the fake Linear MCP server', (): void => {
  it('answers no bearer as recorded: 401, the challenge, an empty body', async (): Promise<void> => {
    const answer = await rpc(linear(), undefined, 'initialize');
    expect(answer.status).toBe(MCP_WITHOUT_BEARER.status);
    expect(answer.headers.get('www-authenticate')).toBe(
      MCP_WITHOUT_BEARER.headers['www-authenticate'],
    );
    expect(answer.text).toBe(MCP_WITHOUT_BEARER.body);
  });

  it('answers a token it never issued as recorded: 401 invalid_token', async (): Promise<void> => {
    const answer = await rpc(linear(), 'lin_oauth_never_issued', 'initialize');
    expect(answer.status).toBe(MCP_INVALID_TOKEN.status);
    expect(answer.headers.get('www-authenticate')).toBe(
      MCP_INVALID_TOKEN.headers['www-authenticate'],
    );
    expect(answer.contentType).toBe(MCP_INVALID_TOKEN.headers['content-type']);
    expect(answer.text).toBe(MCP_INVALID_TOKEN.body);
  });

  it('answers a token revoked at Linear with the body the walk saw inside the client error (R41V-9)', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    await call(fake, `https://api.linear.app/admin/revoke-app?client_id=${LEO.clientId}`, {
      method: 'POST',
    });
    const answer = await rpc(fake, pair.access, 'tools/list');
    expect(answer.status).toBe(401);
    expect(LINEAR_MCP_REVOKED_TOKEN_ERROR.endsWith(answer.text)).toBe(true);
  });

  it('answers an app actor, initialises and lists every recorded tool with its arguments', async (): Promise<void> => {
    const fake = linear();
    const token = await appActorToken(fake);
    const init = await rpc(fake, token, 'initialize', { protocolVersion: '2025-11-25' });
    expect(init.body).toMatchObject({
      result: { protocolVersion: '2025-11-25', capabilities: { tools: {} } },
    });
    const listed = (await rpc(fake, token, 'tools/list')).body as {
      result: { tools: { name: string; inputSchema: { properties: Record<string, unknown> } }[] };
    };
    expect(
      listed.result.tools.map((entry) => ({
        tool: entry.name,
        arguments: Object.keys(entry.inputSchema.properties).sort(),
      })),
    ).toEqual(
      RECORDED.map((entry) => ({ tool: entry.tool, arguments: [...entry.arguments].sort() })),
    );
  });

  it("lists a person's key every tool but the nine diff tools the walks saw only the app get (R41V-7)", async (): Promise<void> => {
    const listed = (await rpc(linear(), SAM_KEY, 'tools/list')).body as {
      result: { tools: { name: string }[] };
    };
    const names = listed.result.tools.map((entry) => entry.name);
    expect(DIFF_TOOLS).toHaveLength(9);
    expect(names).toHaveLength(RECORDED.length - 9);
    for (const name of DIFF_TOOLS) expect(names).not.toContain(name);
  });

  it("offers list_issues the fields Linear's live schema let a caller select (recorded 2 October)", async (): Promise<void> => {
    const listed = (await rpc(linear(), SAM_KEY, 'tools/list')).body as {
      result: {
        tools: {
          name: string;
          inputSchema: { properties: { fields?: { items: { enum: string[] } } } };
        }[];
      };
    };
    const listIssues = listed.result.tools.find((entry) => entry.name === 'list_issues');
    expect(listIssues?.inputSchema.properties.fields?.items.enum).toEqual([
      ...LIST_ISSUES_SELECTABLE_FIELDS,
    ]);
  });

  it('answers a notification 202 with no body, and a GET 405, as the client expects', async (): Promise<void> => {
    const fake = linear();
    const notified = await call(fake, MCP, {
      bearer: SAM_KEY,
      json: { jsonrpc: '2.0', method: 'notifications/initialized' },
    });
    expect(notified.status).toBe(202);
    expect(notified.text).toBe('');
    expect((await call(fake, MCP, { bearer: SAM_KEY })).status).toBe(405);
  });

  it("lists an app user's delegated tickets with only the fields named, holder by id (AL1)", async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    const identifier = await delegatedTicket(fake, 'Leo (Day0)');
    const listed = await tool(fake, pair.access, 'list_issues', {
      team: 'REVOPS',
      project: 'Q3 close',
      limit: 100,
      fields: ['id', 'title', 'statusType', 'status', 'assigneeId', 'delegateId', 'labels'],
    });
    const leo = fake.workspace.appUsers.get(LEO.clientId);
    expect(listed.value).toEqual({
      issues: [
        {
          id: identifier,
          title: '[w11 walk] Delegated to Day0 Leo (P6: Leo takes it)',
          status: 'Backlog',
          statusType: 'backlog',
          labels: [],
          assigneeId: fake.workspace.people[0]?.id,
          delegateId: leo?.id,
        },
      ],
    });
  });

  it('prints get_issue in the order the run of 19 September recorded, with the state history', async (): Promise<void> => {
    const fake = linear();
    const created = await tool(fake, SAM_KEY, 'save_issue', {
      team: 'REVOPS',
      title: 'Close the duplicate',
    });
    const read = await tool(fake, SAM_KEY, 'get_issue', {
      id: (created.value as { id: string }).id,
    });
    expect(Object.keys(read.value as object)).toEqual([
      'id',
      'uuid',
      'title',
      'description',
      'priority',
      'url',
      'gitBranchName',
      'createdAt',
      'updatedAt',
      'archivedAt',
      'completedAt',
      'startedAt',
      'canceledAt',
      'dueDate',
      'slaStartedAt',
      'slaMediumRiskAt',
      'slaHighRiskAt',
      'slaBreachesAt',
      'status',
      'statusType',
      'labels',
      'attachments',
      'documents',
      'stateHistory',
      'createdBy',
      'createdById',
      'team',
      'teamId',
    ]);
    expect(read.value).toMatchObject({
      id: 'REVOPS-1',
      priority: { value: 0, name: 'No priority' },
      url: 'https://linear.app/acme/issue/REVOPS-1/close-the-duplicate',
      stateHistory: [{ state: { name: 'Backlog', type: 'backlog' }, endedAt: null }],
      createdBy: 'Sam',
    });
  });

  it('writes a comment and a state change as the app user, answering as recorded (W-L10)', async (): Promise<void> => {
    const fake = linear();
    const pair = await installPair(fake);
    const identifier = await delegatedTicket(fake, 'Leo (Day0)');
    const comment = await tool(fake, pair.access, 'save_comment', {
      issueId: identifier,
      body: 'Closed as a duplicate.',
    });
    expect(comment.value).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      body: 'Closed as a duplicate.',
    });
    const saved = await tool(fake, pair.access, 'save_issue', { id: identifier, state: 'Done' });
    expect(saved.value).toMatchObject({ id: identifier, status: 'Done', statusType: 'completed' });
    const issue = fake.workspace.issueByAny(identifier)!;
    const leo = fake.workspace.appUsers.get(LEO.clientId)!;
    expect(issue.comments[0]?.userId).toBe(leo.id);
    expect(issue.history[0]?.actorId).toBe(leo.id);
  });

  it('refuses a delegate to an app user with no live app:assignable token, in the words the walk saw on GraphQL (not seen on MCP)', async (): Promise<void> => {
    const fake = linear();
    await appActorToken(fake, 'read,write');
    const refused = await tool(fake, SAM_KEY, 'save_issue', {
      team: 'REVOPS',
      title: 'Delegated to the shared app',
      delegate: WALK_SHARED_APP_USER.id,
    });
    expect(refused).toMatchObject({
      isError: true,
      text: 'One or more app users lack the required capability.',
    });
    expect(fake.workspace.issues).toHaveLength(0);
  });

  it("answers get_user 'me' with the actor's id and address, as intake reads it", async (): Promise<void> => {
    expect((await tool(linear(), SAM_KEY, 'get_user', { query: 'me' })).value).toMatchObject({
      id: expect.any(String),
      email: 'sam@acme.test',
    });
  });

  it('answers the next write upstream_unavailable when told to, as a real workspace once did (m1)', async (): Promise<void> => {
    const fake = linear();
    await call(fake, 'https://api.linear.app/admin/unavailable?writes=1', { method: 'POST' });
    const ticket = await tool(fake, SAM_KEY, 'save_issue', { team: 'REVOPS', title: 'One' });
    expect(ticket).toMatchObject({
      isError: true,
      text: '{"error":"upstream_unavailable","message":"Linear is temporarily unavailable. Please try again.","status":502}',
    });
    expect(
      (await tool(fake, SAM_KEY, 'save_issue', { team: 'REVOPS', title: 'One' })).isError,
    ).toBe(false);
  });

  it('stops answering a token once it is revoked', async (): Promise<void> => {
    const fake = linear();
    const token = await appActorToken(fake);
    await revoke(fake, token);
    expect((await rpc(fake, token, 'tools/list')).text).toBe(MCP_INVALID_TOKEN.body);
  });
});
