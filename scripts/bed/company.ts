/// <reference types="node" />
/**
 * `pnpm bed:company <verb>`: the company bed, from a fresh clone.
 *
 *   docs [--replace]   copy bed/company/folder/ into the documentation folder
 *   check              what the hand steps have made, and what is still missing
 *   seed               the demo tickets created or put back, the bed's bot
 *                      messages deleted, the tile restarted at its seeded figure
 *   post <key>         file a late ticket at its protocol step (log-sh4480)
 *   teardown           archive the demo tickets and delete the bed's bot messages
 *
 * The Linear teams, projects and states, the Slack channels and app, and the
 * Notion pages are made by hand, once (bed/company/notion/README.md and the
 * README's "The company bed"). This script never creates them; `check` reads
 * them back and says what is missing and how to add it.
 *
 * Tokens come from `.env.local`: DAY0_BED_LINEAR_API_KEY,
 * DAY0_BED_SLACK_BOT_TOKEN and DAY0_BED_NOTION_TOKEN. None of them is ever
 * printed: every line goes through a scrub that removes their values and any
 * token shape before it reaches the terminal.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEFAULT_DOCS_HOST_DIR, ensureDocsHostDir } from '../../src/docs/host-dir';
import { replaceSpans, structuralSpans } from '../../src/redaction/structural';
import { containsProvenanceTrailer } from '../../src/surfaces/policy';
import { composeArguments } from '../compose';
import { UndoLedger } from '../rehearsal/cleanup';
import { deleteComment, readComments } from '../rehearsal/linear';
import { DOCS_STUB } from '../setup';
import { applyDocs, planDocs, readManifest, trackedPages, type DocsPlan } from './docs';
import {
  archiveIssue,
  createIssue,
  createLabel,
  deleteLabel,
  LABEL_DESCRIPTION,
  LinearClient,
  markedDescription,
  readBedIssues,
  readForeignIssues,
  readLabel,
  readWorkspace,
  unarchiveIssue,
  updateIssue,
  type BedIssue,
  type Workspace,
} from './linear';
import {
  comparePage,
  NOTION_PARENT_TITLE,
  NOTION_READER_SCRIPT,
  parseNotionRead,
  type NotionPage,
} from './notion';
import {
  bedMessages,
  conversationMessages,
  listConversations,
  REQUIRED_SCOPES,
  scopeRecordingFetch,
  SlackClient,
  slackTs,
  strayAsks,
  type BedChannel,
} from './slack';
import {
  BED_CHANNELS,
  BED_DIR,
  LINEAR_KEY_ENV,
  loadBedSpec,
  NOTION_TOKEN_ENV,
  SLACK_TOKEN_ENV,
  type BedSpec,
  type BedTicket,
} from './spec';

/** Where seed records when this clone's bed began, for the Slack deletes. */
export const STATE_FILE = '.demo-bed/company.json';
const ENV_FILE = '.env.local';

const VERBS = ['docs', 'check', 'seed', 'post', 'teardown'] as const;
export type CompanyVerb = (typeof VERBS)[number];

export interface CompanyOptions {
  verb?: CompanyVerb;
  key?: string;
  replace: boolean;
  help: boolean;
}

export interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Values layered on this process's environment for the child. */
  env?: Record<string, string>;
  /** Text piped to the child's stdin. */
  input?: string;
  timeoutMs?: number;
}

/** Everything the script does to the machine and the network, injectable for the tests. */
export interface CompanyIo {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof fetch;
  run(command: string, args: readonly string[], options?: RunOptions): RunResult;
  log(line: string): void;
  now(): number;
}

const USAGE = `Usage: pnpm bed:company <verb>

  docs [--replace]   copy bed/company/folder/ into the documentation folder
                     (DAY0_DOCS_HOST_DIR, default ./docs-local); refuses to
                     overwrite a page it did not write unless --replace
  check              read back the Linear teams, the Slack channels and app,
                     the Notion pages and the tile, and say what is missing
  seed               create the demo tickets that are missing, put every one
                     back to its tracked state, delete the bed's own bot
                     messages, and restart the tile so it reads 68%
  post <key>         file a late ticket at its protocol step (log-sh4480)
  teardown           archive the demo tickets and delete the bed's bot messages

Tokens are read from .env.local and never printed:
  ${LINEAR_KEY_ENV}    a Linear personal API key in the demo workspace
  ${SLACK_TOKEN_ENV}   the shared bot's token (xoxb-)
  ${NOTION_TOKEN_ENV}      the Notion integration's secret, for check

The hand steps are in bed/company/notion/README.md and the README's "The company bed".`;

/**
 * Read the command line.
 *
 * Args:
 *   argv: Arguments after the script name.
 *
 * Returns:
 *   The verb and its options.
 *
 * Raises:
 *   Error: On an unknown verb or flag, or `post` without a key.
 */
export function parseCompanyArguments(argv: readonly string[]): CompanyOptions {
  const options: CompanyOptions = { replace: false, help: false };
  for (const argument of argv) {
    if (argument === '--') continue;
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--replace') options.replace = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option "${argument}".`);
    else if (options.verb === undefined) {
      if (!(VERBS as readonly string[]).includes(argument)) {
        throw new Error(`"${argument}" is not a verb; the verbs are ${VERBS.join(', ')}.`);
      }
      options.verb = argument as CompanyVerb;
    } else if (options.verb === 'post' && options.key === undefined) options.key = argument;
    else throw new Error(`Unexpected argument "${argument}".`);
  }
  if (options.replace && options.verb !== 'docs') throw new Error('--replace belongs to docs.');
  if (options.verb === 'post' && options.key === undefined) throw new Error('post needs a ticket key.');
  return options;
}

/**
 * A function that removes every token this run holds, and any token shape,
 * from a line before it is printed.
 *
 * Args:
 *   env: The environment the tokens were read from.
 *
 * Returns:
 *   The scrub.
 */
export function tokenScrub(env: Readonly<Record<string, string | undefined>>): (text: string) => string {
  const secrets = [LINEAR_KEY_ENV, SLACK_TOKEN_ENV, NOTION_TOKEN_ENV]
    .map((name: string): string => env[name]?.trim() ?? '')
    .filter((value: string): boolean => value.length >= 8);
  return (text: string): string => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('<redacted>');
    return replaceSpans(out, structuralSpans(out), (): string => '<redacted>');
  };
}

type Status = 'ok' | 'gap' | 'note';

export class Report {
  gaps = 0;

  constructor(private readonly io: CompanyIo, private readonly scrub: (text: string) => string) {}

  section(title: string): void {
    this.io.log('');
    this.io.log(title);
  }

  line(status: Status, text: string): void {
    if (status === 'gap') this.gaps += 1;
    const marker = status === 'ok' ? 'ok  ' : status === 'gap' ? 'GAP ' : 'note';
    this.io.log(this.scrub(`  ${marker} ${text}`));
  }

  say(text: string): void {
    this.io.log(this.scrub(text));
  }
}

function composeCommand(project: string, argv: readonly string[]): string[] {
  const [, ...rest] = composeArguments(argv, ENV_FILE);
  return ['compose', '-p', project, ...rest];
}

function composeProject(io: CompanyIo): string | undefined {
  const project = io.env.COMPOSE_PROJECT_NAME?.trim();
  return project ? project : undefined;
}

function docsTarget(io: CompanyIo): string {
  return resolve(io.cwd, io.env.DAY0_DOCS_HOST_DIR?.trim() || DEFAULT_DOCS_HOST_DIR);
}

function readEpoch(io: CompanyIo): string | undefined {
  const path = join(io.cwd, STATE_FILE);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { epoch?: unknown };
  return typeof parsed.epoch === 'string' ? parsed.epoch : undefined;
}

function writeEpoch(io: CompanyIo, epoch: string): void {
  const path = join(io.cwd, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ epoch }, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// docs

function describeDocsPlan(report: Report, plan: DocsPlan, target: string): void {
  for (const page of plan.write) report.line('ok', `${page.ref} (${page.reason})`);
  for (const removal of plan.remove) report.line('ok', `removed ${removal.ref}, ${removal.reason}`);
  for (const ref of plan.foreign) {
    report.line(
      'note',
      `${ref} in ${target} is not a company bed page and syncs as a page too; move it out for the bed's own set`,
    );
  }
}

/** `docs`: copy the tracked folder pages into the documentation folder. */
export function runDocs(io: CompanyIo, options: CompanyOptions, report: Report): number {
  const target = docsTarget(io);
  ensureDocsHostDir(io.env.DAY0_DOCS_HOST_DIR, io.cwd);
  const pages = trackedPages(join(io.cwd, BED_DIR, 'folder'));
  const manifest = readManifest(target);
  const plan = planDocs({ pages, target, manifest, replace: options.replace, stub: DOCS_STUB });
  report.section(`Company bed pages into ${target}`);
  if (plan.refused.length > 0) {
    for (const refusal of plan.refused) report.line('gap', `${refusal.ref} ${refusal.reason}`);
    report.say('');
    report.say(
      'Nothing was written. Move those pages aside, or run `pnpm bed:company docs --replace` to overwrite them.',
    );
    return 1;
  }
  applyDocs(target, plan, manifest);
  describeDocsPlan(report, plan, target);
  report.line('ok', `${pages.length} company pages in place (${plan.unchanged.length} already current)`);
  return 0;
}

// ---------------------------------------------------------------------------
// Linear

interface TeamTarget {
  teamId: string;
  projectId: string;
  states: Map<string, string>;
}

/**
 * What the hand steps still owe in Linear: teams, their projects, their states.
 *
 * Args:
 *   spec: The bed.
 *   workspace: What the key can see.
 *
 * Returns:
 *   One sentence per gap, each saying how to close it.
 */
export function workspaceGaps(spec: BedSpec, workspace: Workspace): string[] {
  const gaps: string[] = [];
  for (const team of spec.teams) {
    const found = workspace.teams.find((candidate) => candidate.key === team.key);
    if (!found) {
      gaps.push(
        `team ${team.key} is missing: create it by hand in Linear (Settings, Teams, Create team), name "${team.name}", identifier ${team.key}`,
      );
      continue;
    }
    for (const state of spec.states) {
      if (!found.states.some((candidate) => candidate.name === state)) {
        gaps.push(`team ${team.key} has no workflow state "${state}": add it in Settings, Teams, ${team.key}, Workflow`);
      }
    }
    if (!found.projects.some((candidate) => candidate.name === team.project)) {
      gaps.push(`team ${team.key} has no project "${team.project}": create it by hand (Projects, New project) in team ${team.key}`);
    }
  }
  return gaps;
}

function teamTargets(spec: BedSpec, workspace: Workspace): Map<string, TeamTarget> {
  const targets = new Map<string, TeamTarget>();
  for (const team of spec.teams) {
    const found = workspace.teams.find((candidate) => candidate.key === team.key);
    const project = found?.projects.find((candidate) => candidate.name === team.project);
    if (!found || !project) continue;
    targets.set(team.key, {
      teamId: found.id,
      projectId: project.id,
      states: new Map(found.states.map((state): [string, string] => [state.name, state.id])),
    });
  }
  return targets;
}

function sameText(left: string, right: string): boolean {
  return left.replace(/\s+/g, ' ').trim() === right.replace(/\s+/g, ' ').trim();
}

/**
 * The update that puts a bed issue back to its tracked ticket.
 *
 * Args:
 *   issue: The issue as Linear has it.
 *   ticket: The ticket as tracked.
 *   target: The ids the ticket resolves to.
 *
 * Returns:
 *   The fields to change; empty when the issue is already as tracked.
 */
export function resetInput(
  issue: BedIssue,
  ticket: BedTicket,
  target: { teamId: string; projectId: string; stateId: string; labelId: string },
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  if (issue.teamId !== target.teamId) input.teamId = target.teamId;
  if (issue.title !== ticket.title) input.title = ticket.title;
  const description = markedDescription(ticket.description, ticket.key);
  if (!sameText(issue.description, description)) input.description = description;
  if (issue.projectId !== target.projectId) input.projectId = target.projectId;
  if (issue.stateId !== target.stateId) input.stateId = target.stateId;
  if (issue.assigneeId !== null) input.assigneeId = null;
  if (!issue.labelIds.includes(target.labelId)) input.labelIds = [...issue.labelIds, target.labelId];
  return input;
}

function issuesByKey(issues: readonly BedIssue[]): { byKey: Map<string, BedIssue>; duplicates: string[] } {
  const byKey = new Map<string, BedIssue>();
  const duplicates: string[] = [];
  for (const issue of issues) {
    const existing = byKey.get(issue.key);
    if (existing) duplicates.push(`${issue.key} is on both ${existing.identifier} and ${issue.identifier}`);
    else byKey.set(issue.key, issue);
  }
  return { byKey, duplicates };
}

async function checkLinear(io: CompanyIo, spec: BedSpec, report: Report): Promise<void> {
  report.section('Linear');
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}: add a Linear personal API key from the demo workspace`);
    return;
  }
  const client = new LinearClient(key, io.fetch);
  const workspace = await readWorkspace(client, spec.teams.map((team) => team.key));
  report.line('ok', `the key is ${workspace.viewer.name}'s, in workspace ${workspace.organization}`);
  const gaps = workspaceGaps(spec, workspace);
  for (const gap of gaps) report.line('gap', gap);
  const targets = teamTargets(spec, workspace);
  for (const team of spec.teams) {
    if (targets.has(team.key) && !gaps.some((gap) => gap.startsWith(`team ${team.key} `))) {
      report.line('ok', `team ${team.key} with project "${team.project}" and states ${spec.states.join(', ')}`);
    }
  }
  const label = await readLabel(client, spec.label);
  report.line(label ? 'ok' : 'note', label ? `label ${spec.label}` : `label ${spec.label} is missing; seed creates it`);
  const { byKey, duplicates } = issuesByKey(await readBedIssues(client));
  for (const duplicate of duplicates) report.line('gap', `${duplicate}: archive one by hand`);
  for (const ticket of spec.tickets) {
    const issue = byKey.get(ticket.key);
    if (!issue || issue.archived) {
      report.line(
        ticket.late ? 'ok' : 'note',
        ticket.late
          ? `${ticket.key} is not filed; post files it at its protocol step`
          : `${ticket.key} is not filed yet; seed creates it`,
      );
    } else if (ticket.late) {
      report.line('note', `${ticket.key} is already filed as ${issue.identifier}; seed archives it so post can file it again`);
    } else {
      report.line('ok', `${ticket.key} ${issue.identifier} "${issue.title}" (${issue.stateName})`);
    }
  }
  const projectIds = [...targets.values()].map((target) => target.projectId);
  for (const foreign of await readForeignIssues(client, projectIds)) {
    report.line(
      'gap',
      `${foreign.identifier} "${foreign.title}" is in project "${foreign.projectName}" and is not a bed ticket; intake would read it. Archive it, or move it to another project, by hand`,
    );
  }
}

// ---------------------------------------------------------------------------
// Slack

interface SlackView {
  token: string;
  botId: string;
  botUserId: string;
  channels: Map<string, BedChannel>;
}

async function slackView(io: CompanyIo, token: string, report: Report, check: boolean): Promise<SlackView> {
  const recorder = scopeRecordingFetch(io.fetch);
  const auth = await new SlackClient(token, recorder.fetch).authTest();
  report.line('ok', `the token is the bot ${auth.userId} in workspace ${auth.team}`);
  if (check) {
    const scopes = recorder.scopes();
    if (scopes === undefined) {
      report.line('note', 'Slack did not report the token scopes; check chat:write.customize on the app by hand');
    } else {
      const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
      for (const scope of missing) {
        report.line('gap', `the app lacks ${scope}: add it under OAuth & Permissions, reinstall the app, and paste the new token`);
      }
      if (missing.length === 0) report.line('ok', `the app has ${REQUIRED_SCOPES.join(', ')}`);
    }
  }
  const visible = await listConversations(io.fetch, token, 'public_channel');
  const channels = new Map<string, BedChannel>();
  for (const channel of visible) if (BED_CHANNELS.includes(channel.name)) channels.set(channel.name, channel);
  return { token, botId: auth.botId, botUserId: auth.userId, channels };
}

async function checkSlack(io: CompanyIo, report: Report): Promise<void> {
  report.section('Slack');
  const token = io.env[SLACK_TOKEN_ENV]?.trim();
  if (!token) {
    report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}: add the shared bot's token`);
    return;
  }
  const view = await slackView(io, token, report, true);
  for (const name of BED_CHANNELS) {
    const channel = view.channels.get(name);
    if (!channel) {
      report.line('gap', `#${name} is not a public channel the bot can see: create it by hand as a public channel (intake reads public channels only), then /invite the bot`);
    } else if (!channel.isMember) {
      report.line('gap', `the bot is not in #${name}: /invite it there`);
    } else {
      const messages = await conversationMessages(io.fetch, token, channel.id);
      const asks = strayAsks(messages, view.botUserId);
      const own = messages.filter((message) => message.botId === view.botId && containsProvenanceTrailer(message.text));
      report.line('ok', `#${name}, the bot a member`);
      for (const ask of asks) {
        report.line(
          'gap',
          `#${name} holds an ask from an earlier run (ts ${ask.ts}: "${ask.text.slice(0, 60)}"); a new deployment reads it again. Delete it by hand`,
        );
      }
      if (own.length > 0) {
        report.line('note', `#${name} holds ${own.length} message(s) the bot posted with a provenance trailer; seed deletes those posted since this clone's first seed`);
      }
    }
  }
}

async function deleteBedMessages(io: CompanyIo, view: SlackView, epoch: string, report: Report): Promise<void> {
  const conversations: BedChannel[] = [...view.channels.values()].filter((channel) => channel.isMember);
  try {
    conversations.push(...(await listConversations(io.fetch, view.token, 'im')));
  } catch (error) {
    report.line('note', `the bot's direct messages were not read (${(error as Error).message}); only the channels were cleaned`);
  }
  const client = new SlackClient(view.token, io.fetch);
  let deleted = 0;
  for (const conversation of conversations) {
    const messages = await conversationMessages(io.fetch, view.token, conversation.id, epoch);
    for (const message of bedMessages(messages, view.botId, epoch)) {
      await client.deleteMessage(conversation.id, message.ts);
      deleted += 1;
    }
  }
  report.line('ok', `deleted ${deleted} message(s) the bot posted with a provenance trailer since ${epoch}`);
}

// ---------------------------------------------------------------------------
// Notion and the tile

async function checkNotion(io: CompanyIo, report: Report): Promise<void> {
  report.section('Notion');
  const token = io.env[NOTION_TOKEN_ENV]?.trim();
  const project = composeProject(io);
  if (!token) {
    report.line('gap', `${NOTION_TOKEN_ENV} is not set in ${ENV_FILE}: add the Notion integration's secret`);
    return;
  }
  if (!project) {
    report.line('gap', `COMPOSE_PROJECT_NAME is not set in ${ENV_FILE}: run ./setup.sh first`);
    return;
  }
  const read = io.run(
    'docker',
    [
      ...composeCommand(project, ['--profile', 'docs-notion', 'exec', '-T', '-e', NOTION_TOKEN_ENV, 'docs-notion-mcp']),
      'node',
      '--input-type=module',
      '-',
    ],
    { env: { [NOTION_TOKEN_ENV]: token }, input: NOTION_READER_SCRIPT, timeoutMs: 180_000 },
  );
  let pages: NotionPage[];
  try {
    if (read.status !== 0) throw new Error((read.stderr || read.stdout).trim().split('\n').pop() ?? 'no output');
    pages = parseNotionRead(read.stdout);
  } catch (error) {
    const reason = (error as Error).message;
    report.line(
      'gap',
      reason.startsWith('Notion refused')
        ? `${reason}: ${NOTION_TOKEN_ENV} must be the secret of the integration the parent page is shared with`
        : `the Notion component could not be read (${reason}); is it running (pnpm convex:up --profile docs-notion)?`,
    );
    return;
  }
  const tracked = ['linear-automation.md', 'slack-automation-policy.md'].map((file) => {
    const text = readFileSync(join(io.cwd, BED_DIR, 'notion', file), 'utf8');
    return { file, text, title: /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? file };
  });
  const expected = new Set([NOTION_PARENT_TITLE, ...tracked.map((page) => page.title)]);
  const parent = pages.filter((page) => page.title === NOTION_PARENT_TITLE);
  report.line(
    parent.length === 1 ? 'ok' : 'gap',
    parent.length === 1
      ? `parent page "${NOTION_PARENT_TITLE}"`
      : `the integration sees ${parent.length} pages titled "${NOTION_PARENT_TITLE}"; bed/company/notion/README.md says how to make one`,
  );
  for (const page of tracked) {
    const found = pages.filter((candidate) => candidate.title === page.title);
    if (found.length !== 1) {
      report.line('gap', `the integration sees ${found.length} pages titled "${page.title}"; paste ${page.file} under the parent, once`);
      continue;
    }
    const comparison = comparePage(page.text, found[0]!.markdown);
    if (comparison.kind === 'differs') {
      report.line(
        'gap',
        `"${page.title}" differs from ${page.file} at line ${comparison.line}: expected "${comparison.expected}", found "${comparison.found}"`,
      );
    } else if (comparison.token === 'placeholder') {
      report.line('gap', `"${page.title}" still carries the placeholder token: paste the Linear key in its place`);
    } else {
      report.line('ok', `"${page.title}" matches ${page.file}${comparison.token === 'pasted' ? ', the token line filled' : ''}`);
    }
  }
  for (const page of pages.filter((candidate) => !expected.has(candidate.title))) {
    report.line('gap', `the integration also sees "${page.title}", which sync would read too: take the integration off it`);
  }
}

function checkTile(io: CompanyIo, report: Report): void {
  report.section('Looker pipeline tile');
  const project = composeProject(io);
  if (!project) {
    report.line('gap', `COMPOSE_PROJECT_NAME is not set in ${ENV_FILE}: run ./setup.sh first`);
    return;
  }
  const running = io.run('docker', composeCommand(project, ['--profile', 'demo', 'ps', '--services', '--status', 'running']), {
    timeoutMs: 60_000,
  });
  const up = running.status === 0 && running.stdout.split('\n').some((line) => line.trim() === 'looker-tile');
  report.line(
    up ? 'ok' : 'gap',
    up ? `looker-tile is running in ${project}` : `looker-tile is not running in ${project}: pnpm convex:up --profile demo`,
  );
}

function checkFolder(io: CompanyIo, report: Report): void {
  const target = docsTarget(io);
  report.section(`Documentation folder ${target}`);
  if (!existsSync(target)) {
    report.line('gap', `${target} does not exist: pnpm bed:company docs`);
    return;
  }
  const pages = trackedPages(join(io.cwd, BED_DIR, 'folder'));
  const plan = planDocs({ pages, target, manifest: readManifest(target), replace: false, stub: DOCS_STUB });
  for (const page of plan.write) report.line('gap', `${page.ref} is ${page.reason === 'new' ? 'missing' : 'out of date'}: pnpm bed:company docs`);
  for (const refusal of plan.refused) report.line('gap', `${refusal.ref} ${refusal.reason}: pnpm bed:company docs --replace`);
  for (const removal of plan.remove) report.line('gap', `${removal.ref} is ${removal.reason}: pnpm bed:company docs removes it`);
  for (const ref of plan.foreign) report.line('gap', `${ref} is not a company bed page and would sync as one: move it out`);
  if (plan.write.length + plan.refused.length + plan.remove.length + plan.foreign.length === 0) {
    report.line('ok', `the ${pages.length} company pages and nothing else`);
  }
}

// ---------------------------------------------------------------------------
// verbs

/** `check`: read back every hand step and every file, and name each gap. */
export async function runCheck(io: CompanyIo, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  checkFolder(io, report);
  for (const part of [checkLinear(io, spec, report), checkSlack(io, report), checkNotion(io, report)]) {
    try {
      await part;
    } catch (error) {
      report.line('gap', `could not be read: ${(error as Error).message}`);
    }
  }
  checkTile(io, report);
  report.say('');
  report.say(report.gaps === 0 ? 'All green: the company bed is ready for seed.' : `${report.gaps} gap(s) above.`);
  return report.gaps === 0 ? 0 : 1;
}

async function linearForWrite(
  io: CompanyIo,
  spec: BedSpec,
  report: Report,
): Promise<{ client: LinearClient; targets: Map<string, TeamTarget> } | undefined> {
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}`);
    return undefined;
  }
  const client = new LinearClient(key, io.fetch);
  const workspace = await readWorkspace(client, spec.teams.map((team) => team.key));
  const gaps = workspaceGaps(spec, workspace);
  for (const gap of gaps) report.line('gap', gap);
  if (gaps.length > 0) {
    report.say('  Nothing was changed: the teams, projects and states are made by hand first.');
    return undefined;
  }
  return { client, targets: teamTargets(spec, workspace) };
}

async function ensureLabel(client: LinearClient, spec: BedSpec, undo: UndoLedger, report: Report): Promise<string> {
  const existing = await readLabel(client, spec.label);
  if (existing) return existing.id;
  const id = await createLabel(client, spec.label);
  undo.register(`delete label ${spec.label}`, () => deleteLabel(client, id));
  report.line('ok', `created label ${spec.label}`);
  return id;
}

async function fileTicket(
  client: LinearClient,
  ticket: BedTicket,
  existing: BedIssue | undefined,
  target: TeamTarget,
  labelId: string,
  undo: UndoLedger,
  report: Report,
): Promise<void> {
  const stateId = target.states.get(ticket.state)!;
  if (!existing) {
    const created = await createIssue(client, {
      teamId: target.teamId,
      projectId: target.projectId,
      title: ticket.title,
      description: markedDescription(ticket.description, ticket.key),
      stateId,
      labelIds: [labelId],
    });
    undo.register(`archive ${created.identifier}`, () => archiveIssue(client, created.id));
    report.line('ok', `created ${ticket.key} as ${created.identifier} "${ticket.title}" (${ticket.state})`);
    return;
  }
  if (existing.archived) {
    await unarchiveIssue(client, existing.id);
    undo.register(`archive ${existing.identifier} again`, () => archiveIssue(client, existing.id));
    report.line('ok', `unarchived ${ticket.key} ${existing.identifier}`);
  }
  const input = resetInput(existing, ticket, { teamId: target.teamId, projectId: target.projectId, stateId, labelId });
  if (Object.keys(input).length > 0) {
    await updateIssue(client, existing.id, input);
    report.line('ok', `put ${ticket.key} ${existing.identifier} back (${Object.keys(input).join(', ')})`);
  }
  const trailers = (await readComments(client, existing.id)).filter((comment) =>
    containsProvenanceTrailer(comment.body),
  );
  for (const comment of trailers) await deleteComment(client, comment.id);
  report.line(
    'ok',
    `${ticket.key} ${existing.identifier} is "${ticket.title}" (${ticket.state}), unassigned${trailers.length > 0 ? `; deleted ${trailers.length} comment(s) with a provenance trailer` : ''}`,
  );
}

/** `seed`: the tickets created or put back, the bed's messages deleted, the tile restarted. */
export async function runSeed(io: CompanyIo, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  const slackToken = io.env[SLACK_TOKEN_ENV]?.trim();
  const project = composeProject(io);
  report.section('Linear');
  if (!slackToken) report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}`);
  if (!project) report.line('gap', `COMPOSE_PROJECT_NAME is not set in ${ENV_FILE}: run ./setup.sh first`);
  const linear = await linearForWrite(io, spec, report);
  if (!linear || !slackToken || !project) return 1;
  const { client, targets } = linear;
  const { byKey, duplicates } = issuesByKey(await readBedIssues(client));
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) report.line('gap', `${duplicate}: archive one by hand`);
    return 1;
  }
  const undo = new UndoLedger();
  try {
    const labelId = await ensureLabel(client, spec, undo, report);
    for (const ticket of spec.tickets) {
      const existing = byKey.get(ticket.key);
      if (ticket.late) {
        if (existing && !existing.archived) {
          await archiveIssue(client, existing.id);
          report.line('ok', `archived ${ticket.key} ${existing.identifier}; post files it at its protocol step`);
        }
        continue;
      }
      await fileTicket(client, ticket, existing, targets.get(ticket.team)!, labelId, undo, report);
    }
  } catch (error) {
    report.line('gap', `seed stopped: ${(error as Error).message}`);
    for (const result of await undo.runAll()) {
      report.line(result.ok ? 'ok' : 'gap', `undo: ${result.label}${result.ok ? '' : ` failed (${result.error})`}`);
    }
    return 1;
  }

  report.section('Slack');
  const epoch = readEpoch(io) ?? slackTs(io.now());
  writeEpoch(io, epoch);
  try {
    await deleteBedMessages(io, await slackView(io, slackToken, report, false), epoch, report);
  } catch (error) {
    report.line('gap', `Slack: ${(error as Error).message}`);
  }

  report.section('Looker pipeline tile');
  const restart = io.run('docker', composeCommand(project, ['--profile', 'demo', 'restart', 'looker-tile']), {
    timeoutMs: 120_000,
  });
  report.line(
    restart.status === 0 ? 'ok' : 'gap',
    restart.status === 0
      ? `restarted looker-tile in ${project}; it reads its seeded 68%`
      : `looker-tile did not restart in ${project}: ${(restart.stderr || restart.stdout).trim().split('\n').pop() ?? ''}`,
  );
  report.say('');
  report.say(report.gaps === 0 ? 'Seeded.' : `${report.gaps} gap(s) above.`);
  return report.gaps === 0 ? 0 : 1;
}

/** `post <key>`: file one late ticket at its protocol step. */
export async function runPost(io: CompanyIo, key: string, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  const ticket = spec.tickets.find((candidate) => candidate.key === key);
  report.section('Linear');
  if (!ticket?.late) {
    const late = spec.tickets.filter((candidate) => candidate.late).map((candidate) => candidate.key);
    report.line('gap', `${key} is not a late ticket; post files only ${late.join(', ')}`);
    return 1;
  }
  const linear = await linearForWrite(io, spec, report);
  if (!linear) return 1;
  const { byKey, duplicates } = issuesByKey(await readBedIssues(linear.client));
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) report.line('gap', `${duplicate}: archive one by hand`);
    return 1;
  }
  const existing = byKey.get(key);
  if (existing && !existing.archived) {
    report.line('ok', `${key} is already filed as ${existing.identifier} (${existing.stateName}); nothing changed`);
    return 0;
  }
  const undo = new UndoLedger();
  try {
    const labelId = await ensureLabel(linear.client, spec, undo, report);
    await fileTicket(linear.client, ticket, existing, linear.targets.get(ticket.team)!, labelId, undo, report);
  } catch (error) {
    report.line('gap', `post stopped: ${(error as Error).message}`);
    for (const result of await undo.runAll()) {
      report.line(result.ok ? 'ok' : 'gap', `undo: ${result.label}${result.ok ? '' : ` failed (${result.error})`}`);
    }
    return 1;
  }
  return 0;
}

/** `teardown`: archive the bed's tickets and delete the bed's bot messages. */
export async function runTeardown(io: CompanyIo, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  report.section('Linear');
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}`);
  } else {
    const client = new LinearClient(key, io.fetch);
    const issues = await readBedIssues(client);
    for (const issue of issues.filter((candidate) => !candidate.archived)) {
      await archiveIssue(client, issue.id);
      report.line('ok', `archived ${issue.key} ${issue.identifier}`);
    }
    const label = await readLabel(client, spec.label);
    if (label && label.description === LABEL_DESCRIPTION) {
      await deleteLabel(client, label.id);
      report.line('ok', `deleted label ${spec.label}, which seed created`);
    }
  }
  report.section('Slack');
  const token = io.env[SLACK_TOKEN_ENV]?.trim();
  const epoch = readEpoch(io);
  if (!token) {
    report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}`);
  } else if (!epoch) {
    report.line('note', `no seed is recorded in ${STATE_FILE} on this clone, so no Slack message is the bed's to delete`);
  } else {
    await deleteBedMessages(io, await slackView(io, token, report, false), epoch, report);
    rmSync(join(io.cwd, STATE_FILE));
  }
  report.say('');
  report.say(report.gaps === 0 ? 'Torn down.' : `${report.gaps} gap(s) above.`);
  return report.gaps === 0 ? 0 : 1;
}

/**
 * Run one verb.
 *
 * Args:
 *   options: The parsed command line.
 *   io: The machine and the network.
 *
 * Returns:
 *   The exit status: 0 when everything the verb reports is green.
 */
export async function runCompany(options: CompanyOptions, io: CompanyIo): Promise<number> {
  const report = new Report(io, tokenScrub(io.env));
  try {
    switch (options.verb) {
      case 'docs':
        return runDocs(io, options, report);
      case 'check':
        return await runCheck(io, report);
      case 'seed':
        return await runSeed(io, report);
      case 'post':
        return await runPost(io, options.key!, report);
      case 'teardown':
        return await runTeardown(io, report);
      default:
        io.log(USAGE);
        return 2;
    }
  } catch (error) {
    report.say(`error: ${(error as Error).message}`);
    return 1;
  }
}

/** The script's view of this machine. */
export function consoleIo(cwd: string = process.cwd()): CompanyIo {
  return {
    cwd,
    env: process.env,
    fetch: globalThis.fetch,
    run: (command: string, args: readonly string[], options: RunOptions = {}): RunResult => {
      const result = spawnSync(command, [...args], {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, ...(options.env ?? {}) },
        input: options.input,
        timeout: options.timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
      });
      return { status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
    },
    log: (line: string): void => {
      console.log(line);
    },
    now: (): number => Date.now(),
  };
}

async function main(): Promise<number> {
  let options: CompanyOptions;
  try {
    options = parseCompanyArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`error: ${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (options.help || options.verb === undefined) {
    console.log(USAGE);
    return options.help ? 0 : 2;
  }
  return await runCompany(options, consoleIo());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Handed back rather than passed to process.exit so a piped stdout drains.
  process.exitCode = await main();
}
