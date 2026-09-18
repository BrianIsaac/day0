import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  parseCompanyArguments,
  runCompany,
  STATE_FILE,
  type CompanyIo,
  type RunOptions,
  type RunResult,
} from '../../scripts/bed/company';
import { MANIFEST_FILE } from '../../scripts/bed/docs';
import { LABEL_DESCRIPTION, markedDescription } from '../../scripts/bed/linear';
import { comparePage, NOTION_READER_SCRIPT, parseNotionRead } from '../../scripts/bed/notion';
import { loadBedSpec } from '../../scripts/bed/spec';
import { DOCS_STUB } from '../../scripts/setup';

const LINEAR_KEY = `${['lin', 'api'].join('_')}_bedTestKey0123456789`;
const SLACK_TOKEN = `${['xox', 'b'].join('')}-1111-bedTestToken0123456789`;
const NOTION_TOKEN = `${['ntn', ''].join('_')}bedTestNotion0123456789`;
const TRAILER = '-- Mateo (Day0) · run wi_1/run_1';
const BOT_USER = 'UBOT';
const BOT_ID = 'BBOT';
const SCOPES =
  'chat:write,chat:write.customize,channels:read,channels:history,im:read,im:write,im:history,users:read,users:read.email';

// ---------------------------------------------------------------------------
// A Linear workspace, answering the bed's and the rehearsal's named documents.

interface FakeIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  archivedAt: string | null;
  teamId: string;
  projectId: string | null;
  stateId: string;
  assigneeId: string | null;
  labelIds: string[];
  comments: Array<{ id: string; body: string; createdAt: string }>;
}

class FakeLinear {
  teams = [
    { key: 'REVOPS', name: 'RevOps', project: 'Q3 close' },
    { key: 'FIN', name: 'Finance close', project: 'September close' },
    { key: 'LOG', name: 'Logistics desk', project: 'Shipment exceptions' },
  ].map((team) => ({
    id: `team-${team.key}`,
    key: team.key,
    name: team.name,
    states: ['Backlog', 'Todo', 'In Progress', 'Done'].map((state) => ({ id: `${team.key}-${state}`, name: state })),
    projects: [{ id: `project-${team.key}`, name: team.project }],
  }));
  labels: Array<{ id: string; name: string; description: string | null }> = [];
  issues: FakeIssue[] = [];
  operations: string[] = [];
  failOn?: string;
  private next = 1;
  private numbers = new Map<string, number>();

  fetch: typeof fetch = (async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const body = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
    expect((init?.headers as Record<string, string>).Authorization).toBe(LINEAR_KEY);
    const operation = /(?:query|mutation) (\w+)/.exec(body.query)![1]!;
    this.operations.push(operation);
    if (operation === this.failOn) {
      return new Response(JSON.stringify({ errors: [{ message: 'simulated outage' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ data: this.answer(operation, body.variables ?? {}) }), { status: 200 });
  }) as typeof fetch;

  addIssue(issue: Partial<FakeIssue> & { team: string; title: string }): FakeIssue {
    const number = (this.numbers.get(issue.team) ?? 0) + 1;
    this.numbers.set(issue.team, number);
    const created: FakeIssue = {
      id: `issue-${this.next++}`,
      identifier: `${issue.team}-${number}`,
      title: issue.title,
      description: issue.description ?? '',
      archivedAt: issue.archivedAt ?? null,
      teamId: `team-${issue.team}`,
      projectId: issue.projectId === undefined ? `project-${issue.team}` : issue.projectId,
      stateId: issue.stateId ?? `${issue.team}-Todo`,
      assigneeId: issue.assigneeId ?? null,
      labelIds: issue.labelIds ?? [],
      comments: issue.comments ?? [],
    };
    this.issues.push(created);
    return created;
  }

  byKey(key: string): FakeIssue | undefined {
    return this.issues.find((issue) => issue.description.endsWith(`day0-demo-key: ${key}`));
  }

  /** Everything a reader would see, ids included, for before-and-after comparisons. */
  snapshot(): string {
    return JSON.stringify({ issues: this.issues, labels: this.labels });
  }

  private issue(id: unknown): FakeIssue {
    const found = this.issues.find((issue) => issue.id === id || issue.identifier === id);
    if (!found) throw new Error(`no issue ${String(id)}`);
    return found;
  }

  private answer(operation: string, variables: Record<string, unknown>): unknown {
    switch (operation) {
      case 'BedWorkspace': {
        const keys = variables.keys as string[];
        return {
          viewer: { id: 'user-1', name: 'Operator' },
          organization: { name: 'day0' },
          teams: {
            nodes: this.teams
              .filter((team) => keys.includes(team.key))
              .map((team) => ({ ...team, states: { nodes: team.states }, projects: { nodes: team.projects } })),
          },
        };
      }
      case 'BedLabels':
        return { issueLabels: { nodes: this.labels.filter((label) => label.name === variables.name) } };
      case 'BedLabelCreate': {
        const input = variables.input as { name: string; description: string };
        const label = { id: `label-${this.next++}`, name: input.name, description: input.description };
        this.labels.push(label);
        return { issueLabelCreate: { success: true, issueLabel: { id: label.id } } };
      }
      case 'BedLabelDelete':
        this.labels = this.labels.filter((label) => label.id !== variables.id);
        for (const issue of this.issues) issue.labelIds = issue.labelIds.filter((id) => id !== variables.id);
        return { issueLabelDelete: { success: true } };
      case 'BedIssues':
        return {
          issues: {
            nodes: this.issues
              .filter((issue) => issue.description.includes('day0-demo-key: '))
              .map((issue) => this.node(issue)),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      case 'BedProjectIssues': {
        const projectIds = variables.projectIds as string[];
        return {
          issues: {
            nodes: this.issues
              .filter((issue) => issue.archivedAt === null && projectIds.includes(issue.projectId ?? ''))
              .map((issue) => ({
                id: issue.id,
                identifier: issue.identifier,
                title: issue.title,
                description: issue.description,
                project: { name: this.teams.find((team) => `project-${team.key}` === issue.projectId)!.projects[0]!.name },
              })),
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      case 'BedIssueCreate': {
        const input = variables.input as Record<string, unknown>;
        const team = this.teams.find((candidate) => candidate.id === input.teamId)!;
        const created = this.addIssue({
          team: team.key,
          title: String(input.title),
          description: String(input.description),
          projectId: String(input.projectId),
          stateId: String(input.stateId),
          labelIds: input.labelIds as string[],
        });
        return { issueCreate: { success: true, issue: { id: created.id, identifier: created.identifier } } };
      }
      case 'BedIssueUpdate': {
        const issue = this.issue(variables.id);
        const input = variables.input as Record<string, unknown>;
        if ('title' in input) issue.title = String(input.title);
        if ('description' in input) issue.description = String(input.description);
        if ('projectId' in input) issue.projectId = String(input.projectId);
        if ('stateId' in input) issue.stateId = String(input.stateId);
        if ('assigneeId' in input) issue.assigneeId = input.assigneeId as string | null;
        if ('labelIds' in input) issue.labelIds = input.labelIds as string[];
        if ('teamId' in input) issue.teamId = String(input.teamId);
        return { issueUpdate: { success: true } };
      }
      case 'BedIssueArchive':
        this.issue(variables.id).archivedAt = '2026-09-18T00:00:00.000Z';
        return { issueArchive: { success: true } };
      case 'BedIssueUnarchive':
        this.issue(variables.id).archivedAt = null;
        return { issueUnarchive: { success: true } };
      case 'RehearsalComments':
        return { issue: { comments: { nodes: this.issue(variables.id).comments } } };
      case 'RehearsalCommentDelete':
        for (const issue of this.issues) issue.comments = issue.comments.filter((comment) => comment.id !== variables.id);
        return { commentDelete: { success: true } };
      default:
        throw new Error(`the Linear double has no answer for ${operation}`);
    }
  }

  private node(issue: FakeIssue): Record<string, unknown> {
    const state = this.teams.flatMap((team) => team.states).find((candidate) => candidate.id === issue.stateId)!;
    return {
      id: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description,
      archivedAt: issue.archivedAt,
      team: { id: issue.teamId },
      project: issue.projectId ? { id: issue.projectId } : null,
      state,
      assignee: issue.assigneeId ? { id: issue.assigneeId } : null,
      labels: { nodes: issue.labelIds.map((id) => ({ id })) },
    };
  }
}

// ---------------------------------------------------------------------------
// A Slack workspace, answering the Web API methods the bed reads and deletes with.

interface FakeMessage {
  ts: string;
  text: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
}

class FakeSlack {
  scopes = SCOPES;
  channels = [
    { id: 'C1', name: 'revops-asks', is_member: true },
    { id: 'C2', name: 'revops', is_member: true },
    { id: 'C3', name: 'finance-close', is_member: true },
    { id: 'C4', name: 'logistics-desk', is_member: true },
    { id: 'C5', name: 'ops-requests', is_member: true },
    { id: 'C9', name: 'general', is_member: true },
  ];
  ims = [{ id: 'D1', is_im: true }];
  messages = new Map<string, FakeMessage[]>();
  deleted: Array<{ channel: string; ts: string }> = [];

  fetch: typeof fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${SLACK_TOKEN}`);
    const url = new URL(String(input));
    const method = url.pathname.replace('/api/', '');
    const headers = { 'x-oauth-scopes': this.scopes };
    const reply = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200, headers });
    const channel = url.searchParams.get('channel') ?? '';
    const all = this.messages.get(channel) ?? [];
    switch (method) {
      case 'auth.test':
        return reply({ ok: true, team: 'day0', user_id: BOT_USER, bot_id: BOT_ID });
      case 'conversations.list':
        return reply({
          ok: true,
          channels: url.searchParams.get('types') === 'im' ? this.ims : this.channels,
        });
      case 'conversations.history': {
        const top = all.filter((message) => message.thread_ts === undefined || message.thread_ts === message.ts);
        return reply({
          ok: true,
          messages: top.map((message) => {
            const replies = all.filter((candidate) => candidate.thread_ts === message.ts && candidate.ts !== message.ts);
            return replies.length > 0
              ? { ...message, reply_count: replies.length, latest_reply: replies[replies.length - 1]!.ts }
              : message;
          }),
        });
      }
      case 'conversations.replies': {
        const parent = url.searchParams.get('ts');
        return reply({ ok: true, messages: all.filter((message) => message.ts === parent || message.thread_ts === parent) });
      }
      case 'chat.delete': {
        const body = JSON.parse(String(init?.body)) as { channel: string; ts: string };
        const list = this.messages.get(body.channel) ?? [];
        const target = list.find((message) => message.ts === body.ts);
        if (!target || target.bot_id !== BOT_ID) return reply({ ok: false, error: 'cant_delete_message' });
        this.messages.set(body.channel, list.filter((message) => message.ts !== body.ts));
        this.deleted.push(body);
        return reply({ ok: true });
      }
      default:
        return reply({ ok: false, error: `unknown_method_${method}` });
    }
  }) as typeof fetch;

  post(channel: string, message: FakeMessage): void {
    this.messages.set(channel, [...(this.messages.get(channel) ?? []), message]);
  }
}

// ---------------------------------------------------------------------------
// The machine: a temporary checkout, a clock, and a docker double.

interface Harness {
  root: string;
  io: CompanyIo;
  logs: string[];
  runs: Array<{ command: string; args: string[]; options?: RunOptions }>;
  linear: FakeLinear;
  slack: FakeSlack;
  clock: { now: number };
}

const roots: string[] = [];

function notionPages(overrides: Record<string, string> = {}): string {
  const text = (file: string): string =>
    readFileSync(resolve('bed', 'company', 'notion', file), 'utf8').replace('PASTE_LINEAR_API_KEY_HERE', LINEAR_KEY);
  const pages = [
    { id: 'n0', title: 'Kestrel Supply handbook', markdown: '<page url="x">Linear automation</page>' },
    { id: 'n1', title: 'Linear automation', markdown: overrides['Linear automation'] ?? `${text('linear-automation.md')}\n<empty-block/>` },
    { id: 'n2', title: 'Slack automation policy', markdown: overrides['Slack automation policy'] ?? text('slack-automation-policy.md') },
  ];
  return `${JSON.stringify({ pages: [...pages, ...(overrides.extra ? [{ id: 'n9', title: overrides.extra, markdown: '' }] : [])] })}\n`;
}

function harness(env: Record<string, string> = {}, docker: (args: string[]) => RunResult | undefined = () => undefined): Harness {
  const root = mkdtempSync(join(tmpdir(), 'day0-bed-company-'));
  roots.push(root);
  cpSync(resolve('bed', 'company'), join(root, 'bed', 'company'), { recursive: true });
  const logs: string[] = [];
  const runs: Harness['runs'] = [];
  const linear = new FakeLinear();
  const slack = new FakeSlack();
  const clock = { now: Date.parse('2026-09-18T01:00:00Z') };
  const io: CompanyIo = {
    cwd: root,
    env: {
      COMPOSE_PROJECT_NAME: 'day0-bed-test',
      DAY0_BED_LINEAR_API_KEY: LINEAR_KEY,
      DAY0_BED_SLACK_BOT_TOKEN: SLACK_TOKEN,
      DAY0_BED_NOTION_TOKEN: NOTION_TOKEN,
      ...env,
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit): Promise<Response> =>
      String(input).startsWith('https://api.linear.app/')
        ? linear.fetch(input, init)
        : slack.fetch(input, init)) as typeof fetch,
    run: (command: string, args: readonly string[], options?: RunOptions): RunResult => {
      runs.push({ command, args: [...args], options });
      const answer = docker([...args]);
      if (answer) return answer;
      if (args.includes('exec')) return { status: 0, stdout: notionPages(), stderr: '' };
      if (args.includes('ps')) return { status: 0, stdout: 'backend\nlooker-tile\n', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
    log: (line: string): void => {
      logs.push(line);
    },
    now: (): number => clock.now,
  };
  return { root, io, logs, runs, linear, slack, clock };
}

async function run(h: Harness, argv: string[]): Promise<number> {
  return await runCompany(parseCompanyArguments(argv), h.io);
}

afterEach((): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('the command line', (): void => {
  it('takes one verb, a key for post, and --replace for docs only', (): void => {
    expect(parseCompanyArguments(['seed'])).toEqual({ verb: 'seed', replace: false, help: false });
    expect(parseCompanyArguments(['post', 'log-sh4480'])).toMatchObject({ verb: 'post', key: 'log-sh4480' });
    expect(parseCompanyArguments(['--', 'docs', '--replace'])).toMatchObject({ verb: 'docs', replace: true });
    expect(() => parseCompanyArguments(['seed', '--replace'])).toThrow('--replace belongs to docs');
    expect(() => parseCompanyArguments(['post'])).toThrow('post needs a ticket key');
    expect(() => parseCompanyArguments(['reset'])).toThrow('is not a verb');
  });

  it('reads the tracked tickets: ten, one of them late, every team and state declared', (): void => {
    const spec = loadBedSpec(process.cwd());
    expect(spec.tickets).toHaveLength(10);
    expect(spec.tickets.filter((ticket) => ticket.late).map((ticket) => ticket.key)).toEqual(['log-sh4480']);
    expect(spec.teams.map((team) => team.key)).toEqual(['REVOPS', 'FIN', 'LOG']);
  });
});

describe('seed', (): void => {
  it('creates the nine tickets in their tracked states, and twice gives the same workspace', async (): Promise<void> => {
    const h = harness();
    expect(await run(h, ['seed'])).toBe(0);
    const spec = loadBedSpec(h.root);
    for (const ticket of spec.tickets) {
      const issue = h.linear.byKey(ticket.key);
      if (ticket.late) {
        expect(issue, ticket.key).toBeUndefined();
        continue;
      }
      expect(issue, ticket.key).toMatchObject({
        title: ticket.title,
        description: markedDescription(ticket.description, ticket.key),
        teamId: `team-${ticket.team}`,
        projectId: `project-${ticket.team}`,
        stateId: `${ticket.team}-${ticket.state}`,
        assigneeId: null,
        archivedAt: null,
      });
    }
    expect(h.linear.labels).toEqual([{ id: expect.any(String), name: 'day0-demo', description: LABEL_DESCRIPTION }]);
    const first = h.linear.snapshot();
    h.linear.operations = [];
    h.clock.now += 60_000;
    expect(await run(h, ['seed'])).toBe(0);
    expect(h.linear.snapshot()).toBe(first);
    expect(h.linear.operations.filter((operation) => /Create|Update|Archive|Delete/.test(operation))).toEqual([]);
  });

  it('puts a worked ticket back and deletes only the comments with a provenance trailer', async (): Promise<void> => {
    const h = harness();
    await run(h, ['seed']);
    const status = h.linear.byKey('fin-status')!;
    status.stateId = 'FIN-Done';
    status.assigneeId = 'user-1';
    status.comments = [
      { id: 'c-human', body: 'Please post the note by noon.', createdAt: '1' },
      { id: 'c-run', body: `Accruals booked: FIN-2, Done\n\n${TRAILER}`, createdAt: '2' },
    ];
    const foreign = h.linear.addIssue({
      team: 'FIN',
      title: 'Someone else s ticket',
      projectId: null,
      comments: [{ id: 'c-foreign', body: `A run's comment\n\n${TRAILER}`, createdAt: '3' }],
    });
    expect(await run(h, ['seed'])).toBe(0);
    expect(status).toMatchObject({ stateId: 'FIN-Todo', assigneeId: null });
    expect(status.comments.map((comment) => comment.id)).toEqual(['c-human']);
    expect(foreign.comments.map((comment) => comment.id)).toEqual(['c-foreign']);
  });

  it('archives a filed late ticket, and post files it again once', async (): Promise<void> => {
    const h = harness();
    await run(h, ['seed']);
    expect(await run(h, ['post', 'log-sh4480'])).toBe(0);
    const late = h.linear.byKey('log-sh4480')!;
    expect(late).toMatchObject({ archivedAt: null, stateId: 'LOG-Todo' });
    const identifier = late.identifier;
    expect(await run(h, ['post', 'log-sh4480'])).toBe(0);
    expect(h.linear.issues.filter((issue) => issue.description.endsWith('log-sh4480'))).toHaveLength(1);
    late.comments = [{ id: 'c-run', body: `Exception recorded\n\n${TRAILER}`, createdAt: '1' }];
    await run(h, ['seed']);
    expect(late.archivedAt).not.toBeNull();
    expect(await run(h, ['post', 'log-sh4480'])).toBe(0);
    expect(late).toMatchObject({ archivedAt: null, identifier, comments: [] });
    expect(await run(h, ['post', 'log-sh4471'])).toBe(1);
    expect(h.logs.join('\n')).toContain('log-sh4471 is not a late ticket; post files only log-sh4480');
  });

  it('refuses before changing anything when a hand step is missing', async (): Promise<void> => {
    const h = harness();
    h.linear.teams = h.linear.teams.filter((team) => team.key !== 'LOG');
    expect(await run(h, ['seed'])).toBe(1);
    expect(h.linear.issues).toEqual([]);
    expect(h.linear.labels).toEqual([]);
    expect(h.logs.join('\n')).toContain('team LOG is missing: create it by hand');
    expect(h.runs).toEqual([]);
  });

  it('undoes what it created when a later call fails', async (): Promise<void> => {
    const h = harness();
    const original = h.linear.fetch;
    let creates = 0;
    h.linear.fetch = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      if (String(init?.body).includes('BedIssueCreate') && ++creates === 3) {
        return new Response(JSON.stringify({ errors: [{ message: 'simulated outage' }] }), { status: 200 });
      }
      return original(input, init);
    }) as typeof fetch;
    expect(await run(h, ['seed'])).toBe(1);
    expect(h.linear.issues.every((issue) => issue.archivedAt !== null)).toBe(true);
    expect(h.linear.labels).toEqual([]);
    expect(h.logs.join('\n')).toContain('seed stopped: Linear: simulated outage');
  });

  it("deletes only the bot's trailer messages posted since this clone's first seed", async (): Promise<void> => {
    const h = harness();
    h.slack.post('C1', { ts: '1789000000.000100', text: `an earlier run's reply\n\n${TRAILER}`, bot_id: BOT_ID });
    await run(h, ['seed']);
    const epoch = JSON.parse(readFileSync(join(h.root, STATE_FILE), 'utf8')).epoch as string;
    expect(epoch).toBe('1789693200.000000');
    const later = (seconds: number): string => `${1789693200 + seconds}.000100`;
    h.slack.post('C5', { ts: later(10), text: `<@${BOT_USER}> please refresh the pipeline tile`, user: 'UHUMAN' });
    h.slack.post('C5', { ts: later(20), text: `Refreshed.\n\n${TRAILER}`, bot_id: BOT_ID, thread_ts: later(10) });
    h.slack.post('C3', { ts: later(30), text: 'A bot line with no trailer', bot_id: BOT_ID });
    h.slack.post('C3', { ts: later(40), text: `Another app\n\n${TRAILER}`, bot_id: 'BOTHER' });
    h.slack.post('C9', { ts: later(50), text: `Outside the bed\n\n${TRAILER}`, bot_id: BOT_ID });
    h.slack.post('D1', { ts: later(60), text: `A question for the manager\n\n${TRAILER}`, bot_id: BOT_ID });
    h.clock.now += 3_600_000;
    expect(await run(h, ['seed'])).toBe(0);
    expect(h.slack.deleted).toEqual([
      { channel: 'C5', ts: later(20) },
      { channel: 'D1', ts: later(60) },
    ]);
    expect(h.slack.messages.get('C1')).toHaveLength(1);
    expect(h.slack.messages.get('C5')!.map((message) => message.ts)).toEqual([later(10)]);
    expect(JSON.parse(readFileSync(join(h.root, STATE_FILE), 'utf8')).epoch).toBe(epoch);
  });

  it('restarts the tile in its own project, by name, and nothing else', async (): Promise<void> => {
    const h = harness();
    await run(h, ['seed']);
    expect(h.runs.map((call) => [call.command, ...call.args].join(' '))).toEqual([
      'docker compose -p day0-bed-test --env-file .env.local --profile real --profile demo restart looker-tile',
    ]);
  });
});

describe('teardown', (): void => {
  it("archives the bed's tickets, removes the label seed made and the bed's messages, and nothing else", async (): Promise<void> => {
    const h = harness();
    const foreign = h.linear.addIssue({ team: 'REVOPS', title: 'Not the bed s', projectId: null });
    const before = JSON.stringify(foreign);
    await run(h, ['seed']);
    await run(h, ['post', 'log-sh4480']);
    const later = `${1789693200 + 5}.000100`;
    h.slack.post('C1', { ts: later, text: `Coverage is 74%.\n\n${TRAILER}`, bot_id: BOT_ID });
    expect(await run(h, ['teardown'])).toBe(0);
    expect(h.linear.issues.filter((issue) => issue.description.includes('day0-demo-key')).every((issue) => issue.archivedAt !== null)).toBe(true);
    expect(JSON.stringify(foreign)).toBe(before);
    expect(h.linear.labels).toEqual([]);
    expect(h.slack.deleted).toEqual([{ channel: 'C1', ts: later }]);
    expect(existsSync(join(h.root, STATE_FILE))).toBe(false);
  });

  it('keeps a label of the same name that seed did not create', async (): Promise<void> => {
    const h = harness();
    h.linear.labels.push({ id: 'label-own', name: 'day0-demo', description: 'made by hand' });
    await run(h, ['seed']);
    await run(h, ['teardown']);
    expect(h.linear.labels).toEqual([{ id: 'label-own', name: 'day0-demo', description: 'made by hand' }]);
  });
});

describe('docs', (): void => {
  function docsHarness(): Harness & { docs: string } {
    const h = harness();
    return { ...h, docs: join(h.root, 'docs-local') };
  }

  it("copies the thirteen pages, removes the setup's placeholder, and records what it wrote", async (): Promise<void> => {
    const h = docsHarness();
    mkdirSync(h.docs);
    writeFileSync(join(h.docs, 'README.md'), DOCS_STUB);
    expect(await run(h, ['docs'])).toBe(0);
    expect(existsSync(join(h.docs, 'README.md'))).toBe(false);
    expect(readFileSync(join(h.docs, 'finance/handbook.md'), 'utf8')).toBe(
      readFileSync(resolve('bed/company/folder/finance/handbook.md'), 'utf8'),
    );
    const manifest = JSON.parse(readFileSync(join(h.docs, MANIFEST_FILE), 'utf8')) as { files: Record<string, string> };
    expect(Object.keys(manifest.files)).toHaveLength(13);
    expect(await run(h, ['docs'])).toBe(0);
    expect(h.logs.join('\n')).toContain('13 company pages in place (13 already current)');
  });

  it('refuses to overwrite a page it did not write, writes nothing, and --replace overwrites it', async (): Promise<void> => {
    const h = docsHarness();
    mkdirSync(h.docs, { recursive: true });
    writeFileSync(join(h.docs, 'onboarding.md'), '# Our own onboarding\n');
    expect(await run(h, ['docs'])).toBe(1);
    expect(readFileSync(join(h.docs, 'onboarding.md'), 'utf8')).toBe('# Our own onboarding\n');
    expect(existsSync(join(h.docs, 'finance'))).toBe(false);
    expect(existsSync(join(h.docs, MANIFEST_FILE))).toBe(false);
    expect(h.logs.join('\n')).toContain('onboarding.md is already there and was not written by bed:company');
    expect(await run(h, ['docs', '--replace'])).toBe(0);
    expect(readFileSync(join(h.docs, 'onboarding.md'), 'utf8')).toContain('# Kestrel Supply onboarding');
  });

  it('updates a page it wrote, refuses one edited since, and leaves a foreign page with a note', async (): Promise<void> => {
    const h = docsHarness();
    await run(h, ['docs']);
    const tracked = join(h.root, 'bed/company/folder/revops/handbook.md');
    writeFileSync(tracked, `${readFileSync(tracked, 'utf8')}\nA new line in the tracked page.\n`);
    writeFileSync(join(h.docs, 'queue.md'), '# Our queue\n');
    expect(await run(h, ['docs'])).toBe(0);
    expect(readFileSync(join(h.docs, 'revops/handbook.md'), 'utf8')).toContain('A new line in the tracked page.');
    expect(h.logs.join('\n')).toContain('revops/handbook.md (updated)');
    expect(h.logs.join('\n')).toContain('queue.md in');
    expect(existsSync(join(h.docs, 'queue.md'))).toBe(true);
    writeFileSync(join(h.docs, 'revops/handbook.md'), '# Edited by hand\n');
    expect(await run(h, ['docs'])).toBe(1);
    expect(h.logs.join('\n')).toContain('revops/handbook.md was written by bed:company and edited since');
  });
});

describe('check', (): void => {
  async function readyBed(): Promise<Harness> {
    const h = harness();
    await run(h, ['docs']);
    await run(h, ['seed']);
    await run(h, ['post', 'log-sh4480']);
    h.logs.length = 0;
    return h;
  }

  it('is all green on a bed whose hand steps are done, and prints no token', async (): Promise<void> => {
    const h = await readyBed();
    expect(await run(h, ['check'])).toBe(0);
    const printed = h.logs.join('\n');
    expect(printed).toContain('All green: the company bed is ready for seed.');
    expect(printed).toContain('"Linear automation" matches linear-automation.md, the token line filled');
    for (const token of [LINEAR_KEY, SLACK_TOKEN, NOTION_TOKEN]) expect(printed).not.toContain(token);
    const exec = h.runs.find((call) => call.args.includes('exec'))!;
    expect(exec.args).toEqual([
      'compose', '-p', 'day0-bed-test', '--env-file', '.env.local', '--profile', 'real', '--profile', 'docs-notion',
      'exec', '-T', '-e', 'DAY0_BED_NOTION_TOKEN', 'docs-notion-mcp', 'node', '--input-type=module', '-',
    ]);
    expect(exec.args.join(' ')).not.toContain(NOTION_TOKEN);
    expect(exec.options).toMatchObject({ env: { DAY0_BED_NOTION_TOKEN: NOTION_TOKEN }, input: NOTION_READER_SCRIPT });
  });

  it('names every hand step still owed and how to make it', async (): Promise<void> => {
    const h = harness({}, (args) =>
      args.includes('exec')
        ? {
            status: 0,
            stdout: notionPages({
              'Slack automation policy': '# Slack automation policy\n\nSomething else entirely.',
              extra: 'Revenue operations onboarding',
            }).replace(LINEAR_KEY, 'PASTE_LINEAR_API_KEY_HERE'),
            stderr: '',
          }
        : args.includes('ps')
          ? { status: 0, stdout: 'backend\n', stderr: '' }
          : undefined,
    );
    h.linear.teams = h.linear.teams.filter((team) => team.key !== 'FIN');
    h.linear.addIssue({ team: 'REVOPS', title: 'Refresh the Looker pipeline tile' });
    h.slack.scopes = SCOPES.replace('chat:write.customize,', '');
    h.slack.channels = h.slack.channels.filter((channel) => channel.name !== 'logistics-desk');
    h.slack.channels.find((channel) => channel.name === 'ops-requests')!.is_member = false;
    h.slack.post('C1', { ts: '1.000100', text: `<@${BOT_USER}> can you confirm pipeline coverage?`, user: 'UHUMAN' });
    mkdirSync(join(h.root, 'docs-local'));
    writeFileSync(join(h.root, 'docs-local', 'README.md'), DOCS_STUB);
    expect(await run(h, ['check'])).toBe(1);
    const gaps = h.logs.filter((line) => line.includes('GAP ')).join('\n');
    expect(gaps).toContain('onboarding.md is missing: pnpm bed:company docs');
    expect(gaps).toContain("README.md is the setup's placeholder page: pnpm bed:company docs removes it");
    expect(gaps).toContain('team FIN is missing: create it by hand in Linear');
    expect(gaps).toContain('REVOPS-1 "Refresh the Looker pipeline tile" is in project "Q3 close" and is not a bed ticket');
    expect(gaps).toContain('the app lacks chat:write.customize');
    expect(gaps).toContain('#logistics-desk does not exist: create it by hand');
    expect(gaps).toContain('the bot is not in #ops-requests');
    expect(gaps).toContain('#revops-asks holds an ask from an earlier run');
    expect(gaps).toContain('"Slack automation policy" differs from slack-automation-policy.md at line 3');
    expect(gaps).toContain('"Linear automation" still carries the placeholder token');
    expect(gaps).toContain('the integration also sees "Revenue operations onboarding"');
    expect(gaps).toContain('looker-tile is not running in day0-bed-test');
  });

  it('says which token is missing rather than calling a provider without one', async (): Promise<void> => {
    const h = harness({ DAY0_BED_LINEAR_API_KEY: '', DAY0_BED_SLACK_BOT_TOKEN: '', DAY0_BED_NOTION_TOKEN: '' });
    expect(await run(h, ['check'])).toBe(1);
    const gaps = h.logs.join('\n');
    expect(gaps).toContain('DAY0_BED_LINEAR_API_KEY is not set in .env.local');
    expect(gaps).toContain('DAY0_BED_SLACK_BOT_TOKEN is not set in .env.local');
    expect(gaps).toContain('DAY0_BED_NOTION_TOKEN is not set in .env.local');
    expect(h.linear.operations).toEqual([]);
  });
});

describe('the Notion comparison', (): void => {
  const tracked = readFileSync(resolve('bed/company/notion/linear-automation.md'), 'utf8');

  it('matches a pasted page with the token filled, its heading dropped and a trailing empty block', (): void => {
    const pasted = tracked.replace('PASTE_LINEAR_API_KEY_HERE', LINEAR_KEY).split('\n').slice(2).join('\n');
    expect(comparePage(tracked, `${pasted}\n\n<empty-block/>\n`)).toEqual({ kind: 'same', token: 'pasted' });
    expect(comparePage(tracked, tracked)).toEqual({ kind: 'same', token: 'placeholder' });
  });

  it('names the first line that differs and never echoes the token line', (): void => {
    const edited = tracked
      .replace('PASTE_LINEAR_API_KEY_HERE', LINEAR_KEY)
      .replace('Workflow states, the same in every team', 'Workflow states');
    const comparison = comparePage(tracked, edited);
    expect(comparison).toMatchObject({ kind: 'differs', expected: expect.stringContaining('the same in every team') });
    const moved = tracked.replace('- Service token (company automation): `PASTE_LINEAR_API_KEY_HERE`\n', '');
    expect(JSON.stringify(comparePage(tracked, `${moved}\n- Service token (company automation): \`${LINEAR_KEY}\``))).not.toContain(LINEAR_KEY);
  });

  it('reads the container script output, and says what the component said when it failed', (): void => {
    expect(parseNotionRead(`noise\n${JSON.stringify({ pages: [{ id: 'a', title: 'T', markdown: 'm' }] })}\n`)).toEqual([
      { id: 'a', title: 'T', markdown: 'm' },
    ]);
    expect(() => parseNotionRead(`${JSON.stringify({ error: 'unauthorized' })}\n`)).toThrow('unauthorized');
  });
});

describe('the Notion read, run as the container runs it', (): void => {
  let server: Server;
  let url: string;
  const seen: Array<{ method: string; rpc?: string; auth?: string; notion?: string; session?: string }> = [];

  beforeEach(async (): Promise<void> => {
    seen.length = 0;
    server = createServer((request: IncomingMessage, response: ServerResponse): void => {
      let raw = '';
      request.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      request.on('end', (): void => {
        const rpc = raw ? (JSON.parse(raw) as { id?: number; method: string; params?: { name?: string; arguments?: Record<string, unknown> } }) : undefined;
        seen.push({
          method: request.method ?? '',
          rpc: rpc?.method,
          auth: request.headers.authorization,
          notion: request.headers['notion-token'] as string | undefined,
          session: request.headers['mcp-session-id'] as string | undefined,
        });
        if (request.method === 'DELETE' || rpc?.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result: unknown = { protocolVersion: '2025-03-26', capabilities: {}, serverInfo: { name: 'fake' } };
        if (rpc.params?.name === 'API-post-search') {
          result = {
            content: [{
              type: 'text',
              text: JSON.stringify({
                results: [{ id: 'p1', properties: { title: { type: 'title', title: [{ plain_text: 'Linear automation' }] } } }],
                has_more: false,
              }),
            }],
          };
        } else if (rpc.params?.name === 'API-retrieve-page-markdown') {
          result = { content: [{ type: 'text', text: JSON.stringify({ markdown: `# Page ${String(rpc.params.arguments?.page_id)}` }) }] };
        }
        response.writeHead(200, { 'content-type': 'text/event-stream', 'mcp-session-id': 'session-1' });
        response.end(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result })}\n\n`);
      });
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  });

  afterEach(async (): Promise<void> => {
    await new Promise<void>((done) => server.close(() => done()));
  });

  it('lists and reads every page in one session with both tokens, then ends the session', async (): Promise<void> => {
    const child = spawn(process.execPath, ['--input-type=module', '-'], {
      env: { ...process.env, MCP_URL: url, AUTH_TOKEN: 'transport-token', DAY0_BED_NOTION_TOKEN: NOTION_TOKEN },
    });
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stdin.end(NOTION_READER_SCRIPT);
    await new Promise<void>((done) => child.on('close', () => done()));
    expect(parseNotionRead(stdout)).toEqual([{ id: 'p1', title: 'Linear automation', markdown: '# Page p1' }]);
    expect(seen.map((call) => call.rpc ?? call.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/call',
      'DELETE',
    ]);
    expect(seen.every((call) => call.auth === 'Bearer transport-token' && call.notion === NOTION_TOKEN)).toBe(true);
    expect(seen.slice(1).every((call) => call.session === 'session-1')).toBe(true);
  });
});
