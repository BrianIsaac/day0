/// <reference types="node" />
/**
 * `pnpm bed:company <verb>`: the company bed, from a fresh clone.
 *
 *   docs [--replace]   copy bed/company/folder/ into the documentation folder
 *   check [--set <n>]  what the hand steps have made, and what is still missing
 *   seed [--set <n>]   the demo tickets created or put back, bot cleanup
 *                      attempted, the tile restarted at its seeded figure;
 *                      with a set, only that set's tickets and the rest archived
 *   post <key>         file a late ticket at its protocol step (log-sh4480)
 *   teardown           archive this clone's tickets and attempt bot cleanup
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
import {
  deleteComment,
  readComments,
  retryOnce,
  type IssueComment,
  type LinearRequestError,
  type RetryIo,
} from '../rehearsal/linear';
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
  type BedLabel,
  type ProjectIssue,
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
  carriesAsk,
  ownMentions,
  slackTs,
  standingAsksFromFile,
  standingMentions,
  type BedChannel,
  type BedMessage,
  type SlackRetryIo,
  type StandingAsk,
} from './slack';
import {
  BED_CHANNELS,
  BED_DIR,
  LINEAR_KEY_ENV,
  loadBedSpec,
  NOTION_TOKEN_ENV,
  SLACK_TOKEN_ENV,
  ticketsToFile,
  type BedSpec,
  type BedTicket,
} from './spec';

/** Where seed records what this clone may clean up. */
export const STATE_FILE = '.demo-bed/company.json';
const ENV_FILE = '.env.local';

const VERBS = ['docs', 'check', 'seed', 'post', 'teardown'] as const;
export type CompanyVerb = (typeof VERBS)[number];

export interface CompanyOptions {
  verb?: CompanyVerb;
  key?: string;
  /** A named set from `linear.json`: check and seed act on that set only. */
  set?: string;
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
  sleep(ms: number): Promise<void>;
}

const USAGE = `Usage: pnpm bed:company <verb>

  docs [--replace]   copy bed/company/folder/ into the documentation folder
                     (DAY0_DOCS_HOST_DIR, default ./docs-local); refuses to
                     overwrite a page it did not write unless --replace
  check [--set <n>]  read back the Linear teams, the Slack channels and app,
                     the Notion pages and the tile, and say what is missing
  seed [--set <n>]   create the demo tickets that are missing, put every one
                     back to its tracked state, attempt bot message cleanup,
                     and restart the tile so it reads 68%; with --set, file
                     only that named set from bed/company/linear.json and
                     archive every other bed ticket
  post <key>         file a late ticket at its protocol step (log-sh4480)
  teardown           archive this clone's tickets and attempt bot cleanup

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
 *   Error: On an unknown verb or flag, `post` without a key, or `--set` without a name.
 */
export function parseCompanyArguments(argv: readonly string[]): CompanyOptions {
  const options: CompanyOptions = { replace: false, help: false };
  let wantsSet = false;
  for (const argument of argv) {
    if (argument === '--') continue;
    if (wantsSet) {
      if (argument.startsWith('-')) throw new Error('--set needs a set name.');
      options.set = argument;
      wantsSet = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--replace') options.replace = true;
    else if (argument === '--set') wantsSet = true;
    else if (argument.startsWith('-')) throw new Error(`Unknown option "${argument}".`);
    else if (options.verb === undefined) {
      if (!(VERBS as readonly string[]).includes(argument)) {
        throw new Error(`"${argument}" is not a verb; the verbs are ${VERBS.join(', ')}.`);
      }
      options.verb = argument as CompanyVerb;
    } else if (options.verb === 'post' && options.key === undefined) options.key = argument;
    else throw new Error(`Unexpected argument "${argument}".`);
  }
  if (wantsSet) throw new Error('--set needs a set name.');
  if (options.replace && options.verb !== 'docs') throw new Error('--replace belongs to docs.');
  if (options.set !== undefined && options.verb !== 'check' && options.verb !== 'seed') {
    throw new Error('--set belongs to check and seed.');
  }
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

interface CompanyState {
  epoch: string;
  issueIds: string[];
  issueKeys: string[];
  labelId?: string;
  ownsLabel: boolean;
}

function readState(io: CompanyIo): CompanyState | undefined {
  const path = join(io.cwd, STATE_FILE);
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<CompanyState>;
  if (typeof parsed.epoch !== 'string') throw new Error(`${STATE_FILE} has no bed epoch`);
  return {
    epoch: parsed.epoch,
    issueIds: Array.isArray(parsed.issueIds) ? parsed.issueIds.filter((id): id is string => typeof id === 'string') : [],
    issueKeys: Array.isArray(parsed.issueKeys) ? parsed.issueKeys.filter((key): key is string => typeof key === 'string') : [],
    labelId: typeof parsed.labelId === 'string' ? parsed.labelId : undefined,
    ownsLabel: parsed.ownsLabel === true,
  };
}

function writeState(io: CompanyIo, state: CompanyState): void {
  const path = join(io.cwd, STATE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
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

/**
 * The bed's Linear calls, each retried once on a transient failure with the
 * retry named in the report. A write whose first attempt may have landed
 * before the failure re-reads first and is sent again only when it did not,
 * so an archive, a create or a delete is never done twice.
 */
class BedLinear {
  private readonly retry: RetryIo;

  constructor(
    private readonly client: LinearClient,
    io: CompanyIo,
    private readonly report: Report,
  ) {
    this.retry = {
      say: (line: string): void => report.line('note', line),
      sleep: (ms: number): Promise<void> => io.sleep(ms),
    };
  }

  private landed(what: string, failure: LinearRequestError): void {
    const reason = failure.reason.replace(/^an? /, '');
    this.report.line('note', `the first ${what} landed before the ${reason}; not sent again`);
  }

  private async issue(id: string): Promise<BedIssue | undefined> {
    return (await readBedIssues(this.client)).find((issue: BedIssue): boolean => issue.id === id);
  }

  workspace(keys: readonly string[]): Promise<Workspace> {
    return retryOnce('workspace read', this.retry, () => readWorkspace(this.client, keys));
  }

  issues(): Promise<BedIssue[]> {
    return retryOnce('ticket read', this.retry, () => readBedIssues(this.client));
  }

  foreignIssues(projectIds: readonly string[]): Promise<ProjectIssue[]> {
    return retryOnce('project ticket read', this.retry, () => readForeignIssues(this.client, projectIds));
  }

  label(name: string): Promise<BedLabel | undefined> {
    return retryOnce('label read', this.retry, () => readLabel(this.client, name));
  }

  createLabel(name: string): Promise<string> {
    const what = 'label create';
    return retryOnce(what, this.retry, () => createLabel(this.client, name), async (failure): Promise<string> => {
      const found = await readLabel(this.client, name);
      if (found?.description !== LABEL_DESCRIPTION) return await createLabel(this.client, name);
      this.landed(what, failure);
      return found.id;
    });
  }

  deleteLabel(name: string, id: string): Promise<void> {
    const what = 'label delete';
    return retryOnce(what, this.retry, () => deleteLabel(this.client, id), async (failure): Promise<void> => {
      if ((await readLabel(this.client, name))?.id === id) return await deleteLabel(this.client, id);
      this.landed(what, failure);
    });
  }

  createIssue(key: string, input: Record<string, unknown>): Promise<{ id: string; identifier: string }> {
    const what = `${key} create`;
    return retryOnce(what, this.retry, () => createIssue(this.client, input), async (failure) => {
      const found = (await readBedIssues(this.client)).find((issue: BedIssue): boolean => issue.key === key);
      if (!found) return await createIssue(this.client, input);
      this.landed(what, failure);
      return { id: found.id, identifier: found.identifier };
    });
  }

  updateIssue(issue: { id: string; identifier: string }, input: Record<string, unknown>): Promise<void> {
    // The same fields set twice leave the issue as once, so the update is simply sent again.
    return retryOnce(`${issue.identifier} update`, this.retry, () => updateIssue(this.client, issue.id, input));
  }

  archive(issue: { id: string; identifier: string }): Promise<void> {
    const what = `${issue.identifier} archive`;
    return retryOnce(what, this.retry, () => archiveIssue(this.client, issue.id), async (failure): Promise<void> => {
      if (!(await this.issue(issue.id))?.archived) return await archiveIssue(this.client, issue.id);
      this.landed(what, failure);
    });
  }

  unarchive(issue: { id: string; identifier: string }): Promise<void> {
    const what = `${issue.identifier} unarchive`;
    return retryOnce(what, this.retry, () => unarchiveIssue(this.client, issue.id), async (failure): Promise<void> => {
      if ((await this.issue(issue.id))?.archived !== false) return await unarchiveIssue(this.client, issue.id);
      this.landed(what, failure);
    });
  }

  comments(issue: { id: string; identifier: string }): Promise<IssueComment[]> {
    return retryOnce(`${issue.identifier} comment read`, this.retry, () => readComments(this.client, issue.id));
  }

  deleteComment(issue: { id: string; identifier: string }, commentId: string): Promise<void> {
    const what = `${issue.identifier} comment delete`;
    return retryOnce(what, this.retry, () => deleteComment(this.client, commentId), async (failure): Promise<void> => {
      const comments = await readComments(this.client, issue.id);
      if (comments.some((comment: IssueComment): boolean => comment.id === commentId)) {
        return await deleteComment(this.client, commentId);
      }
      this.landed(what, failure);
    });
  }
}

/** The bed's Linear calls over this run's key and clock. */
function bedLinear(io: CompanyIo, key: string, report: Report): BedLinear {
  return new BedLinear(new LinearClient(key, io.fetch, (): number => io.now()), io, report);
}

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

/** A small count as a word, the way the report says "the nine tickets". */
function numberWord(count: number): string {
  return ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'][count] ?? String(count);
}

/** What a seed with this set files, said once so the operator knows what check expects. */
function seedExpectation(spec: BedSpec, set: string | undefined, toFile: readonly BedTicket[]): string {
  if (set !== undefined) {
    return `seed --set ${set} files ${toFile.map((ticket) => ticket.key).join(', ')}; every other ticket stays unfiled`;
  }
  const late = spec.tickets.filter((ticket) => ticket.late).map((ticket) => ticket.key);
  const count = numberWord(toFile.length);
  return `seed files the ${count} tickets${late.length > 0 ? `; post files ${late.join(', ')} at its protocol step` : ''}`;
}

async function checkLinear(io: CompanyIo, spec: BedSpec, set: string | undefined, report: Report): Promise<void> {
  report.section('Linear');
  const toFile = ticketsToFile(spec, set);
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}: add a Linear personal API key from the demo workspace`);
    return;
  }
  const linear = bedLinear(io, key, report);
  const workspace = await linear.workspace(spec.teams.map((team) => team.key));
  report.line('ok', `the key is ${workspace.viewer.name}'s, in workspace ${workspace.organization}`);
  const gaps = workspaceGaps(spec, workspace);
  for (const gap of gaps) report.line('gap', gap);
  const targets = teamTargets(spec, workspace);
  for (const team of spec.teams) {
    if (targets.has(team.key) && !gaps.some((gap) => gap.startsWith(`team ${team.key} `))) {
      report.line('ok', `team ${team.key} with project "${team.project}" and states ${spec.states.join(', ')}`);
    }
  }
  const label = await linear.label(spec.label);
  report.line(label ? 'ok' : 'note', label ? `label ${spec.label}` : `label ${spec.label} is missing; seed creates it`);
  const { byKey, duplicates } = issuesByKey(await linear.issues());
  for (const duplicate of duplicates) report.line('gap', `${duplicate}: remove the marker from one or delete it by hand; archiving alone keeps it in the bed's read`);
  if (!readState(io)) {
    for (const issue of byKey.values()) {
      if (!issue.archived) report.line('gap', `${issue.identifier} is an active marked ticket from another clone: archive it there before this clone seeds`);
    }
  }
  report.line('note', seedExpectation(spec, set, toFile));
  for (const ticket of spec.tickets) {
    const issue = byKey.get(ticket.key);
    const filed = issue !== undefined && !issue.archived;
    if (set !== undefined && !toFile.includes(ticket)) {
      report.line(
        filed ? 'note' : 'ok',
        filed
          ? `${ticket.key} is outside the set ${set} and filed as ${issue.identifier}; seed --set ${set} archives it`
          : `${ticket.key} is outside the set ${set} and not filed`,
      );
    } else if (!filed) {
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
  for (const foreign of await linear.foreignIssues(projectIds)) {
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

function slackRetry(io: CompanyIo, report: Report): SlackRetryIo {
  return {
    say: (line: string): void => report.line('note', line),
    sleep: (ms: number): Promise<void> => io.sleep(ms),
  };
}

async function slackView(io: CompanyIo, token: string, report: Report, check: boolean): Promise<SlackView> {
  const recorder = scopeRecordingFetch(io.fetch);
  const retry = slackRetry(io, report);
  const auth = await new SlackClient(token, recorder.fetch, retry, (): number => io.now()).authTest();
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
  const visible = await listConversations(io.fetch, token, 'public_channel', retry, (): number => io.now());
  const channels = new Map<string, BedChannel>();
  for (const channel of visible) if (BED_CHANNELS.includes(channel.name)) channels.set(channel.name, channel);
  return { token, botId: auth.botId, botUserId: auth.userId, channels };
}

/** The start of a message, short enough for one report line. */
function firstWords(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 60);
}

/**
 * Report the standing asks against the sitting the check is for.
 *
 * The asks are posted once, by a person, and left standing, so every new
 * deployment reads them on its first poll. The full seed expects every ask of
 * the file; a named set expects only the asks whose row names it, which for
 * one-each is the single ask that is revenue operations' task. Each expected
 * ask must be there once, and any other message that mentions the bot is a
 * gap, because a new deployment would take it up as work.
 *
 * Args:
 *   asks: The asks `slack-asks.md` lists.
 *   standing: Per bed channel that was read, the mentions intake would read, oldest first.
 *   own: Per bed channel, mentions the app's own token posted with no trailer.
 *   set: The named set the check is for, or undefined for the full seed.
 *   report: Where the lines go.
 */
function reportStandingAsks(
  asks: readonly StandingAsk[],
  standing: ReadonlyMap<string, BedMessage[]>,
  own: ReadonlyMap<string, BedMessage[]>,
  set: string | undefined,
  report: Report,
): void {
  const expected = set === undefined ? asks : asks.filter((ask) => ask.sets.includes(set));
  const matched = new Set<BedMessage>();
  let present = 0;
  for (const ask of expected) {
    // A channel the check could not read has its own gap above; its ask is unknown, not missing.
    if (!standing.has(ask.channel)) continue;
    const found = (standing.get(ask.channel) ?? []).find(
      (message) => !matched.has(message) && carriesAsk(message, ask),
    );
    if (found) {
      matched.add(found);
      present += 1;
      report.line('ok', `#${ask.channel} holds the standing ask "${firstWords(ask.text)}"`);
      continue;
    }
    const viaBot = (own.get(ask.channel) ?? []).some((message) => carriesAsk(message, ask));
    report.line(
      'gap',
      `#${ask.channel} lacks the standing ask "${firstWords(ask.text)}": post it once, as yourself, mentioning the bot${
        viaBot ? "; the copy there was posted through the bot token; intake never reads the app's own posts" : ''
      }`,
    );
  }
  const kept = expected.map((ask) => `#${ask.channel}`).join(', ');
  for (const [name, messages] of standing) {
    for (const message of messages) {
      if (matched.has(message)) continue;
      const found = `(ts ${message.ts}: "${firstWords(message.text)}")`;
      report.line(
        'gap',
        set === undefined
          ? `#${name} holds a message that mentions the bot and is not one of the standing asks ${found}; a new deployment reads it as work. Delete it by hand`
          : `#${name} holds a standing message that mentions the bot ${found}; the ${set} sitting keeps only the ${kept || 'tickets and no'} ask and this would add an item on camera. Delete it by hand before the sitting, and post it again afterwards for the full run`,
      );
    }
  }
  const complete = present === expected.length;
  if (set === undefined) {
    report.line(
      complete ? 'ok' : 'note',
      complete
        ? `all ${numberWord(asks.length)} of slack-asks.md's asks are standing; a new deployment's first poll reads them`
        : `${present} of slack-asks.md's ${asks.length} asks are standing`,
    );
  } else if (expected.length > 0) {
    report.line(
      complete ? 'ok' : 'note',
      complete
        ? `the ${numberWord(expected.length)} standing ask${expected.length === 1 ? '' : 's'} the ${set} sitting keeps ${expected.length === 1 ? 'is' : 'are'} there`
        : `${present} of the ${expected.length} standing ask(s) the ${set} sitting keeps ${present === 1 ? 'is' : 'are'} there`,
    );
  }
}

async function checkSlack(io: CompanyIo, set: string | undefined, report: Report): Promise<void> {
  report.section('Slack');
  const token = io.env[SLACK_TOKEN_ENV]?.trim();
  if (!token) {
    report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}: add the shared bot's token`);
    return;
  }
  const asks = standingAsksFromFile(readFileSync(join(io.cwd, BED_DIR, 'slack-asks.md'), 'utf8'));
  const view = await slackView(io, token, report, true);
  const retry = slackRetry(io, report);
  const standing = new Map<string, BedMessage[]>();
  const ownAsks = new Map<string, BedMessage[]>();
  for (const name of BED_CHANNELS) {
    const channel = view.channels.get(name);
    if (!channel) {
      report.line('gap', `#${name} is not a public channel the bot can see: create it by hand as a public channel (intake reads public channels only), then /invite the bot`);
    } else if (!channel.isMember) {
      report.line('gap', `the bot is not in #${name}: /invite it there`);
    } else {
      const messages = await conversationMessages(io.fetch, token, channel.id, undefined, retry, (): number => io.now());
      standing.set(name, standingMentions(messages, view.botUserId, view.botId));
      ownAsks.set(name, ownMentions(messages, view.botUserId, view.botId));
      const own = messages.filter((message) => message.botId === view.botId && containsProvenanceTrailer(message.text));
      report.line('ok', `#${name}, the bot a member`);
      if (own.length > 0) {
        report.line('note', `#${name} holds ${own.length} message(s) the bot posted with a provenance trailer; seed attempts to delete those posted since this clone's first seed, but Slack refuses deletion of customised posts`);
      }
    }
  }
  reportStandingAsks(asks, standing, ownAsks, set, report);
}

async function deleteBedMessages(io: CompanyIo, view: SlackView, epoch: string, report: Report): Promise<void> {
  const retry = slackRetry(io, report);
  const conversations: BedChannel[] = [...view.channels.values()].filter((channel) => channel.isMember);
  try {
    conversations.push(...(await listConversations(io.fetch, view.token, 'im', retry, (): number => io.now())));
  } catch (error) {
    report.line('gap', `the bot's direct messages were not read (${(error as Error).message}); only the channels were cleaned`);
  }
  const client = new SlackClient(view.token, io.fetch, retry, (): number => io.now());
  let deleted = 0;
  // One conversation or message that fails is a gap of its own; the others are still cleaned.
  for (const conversation of conversations) {
    const where = conversation.name ? `#${conversation.name}` : `DM ${conversation.id}`;
    let messages: BedMessage[];
    try {
      messages = await conversationMessages(io.fetch, view.token, conversation.id, epoch, retry, (): number => io.now());
    } catch (error) {
      report.line('gap', `${where} was not read (${(error as Error).message})`);
      continue;
    }
    for (const message of bedMessages(messages, view.botId, epoch)) {
      try {
        await client.deleteMessage(conversation.id, message.ts);
        deleted += 1;
      } catch (error) {
        const reason = (error as Error).message;
        report.line(
          'gap',
          reason.includes('cant_delete_message')
            ? `${where} message ${message.ts} cannot be deleted by the bot token after a customised post: delete that exact message by hand in Slack, then retry teardown`
            : `${where} message ${message.ts} was not deleted (${reason})`,
        );
      }
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
export async function runCheck(io: CompanyIo, set: string | undefined, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  ticketsToFile(spec, set);
  checkFolder(io, report);
  for (const read of [
    (): Promise<void> => checkLinear(io, spec, set, report),
    (): Promise<void> => checkSlack(io, set, report),
    (): Promise<void> => checkNotion(io, report),
  ]) {
    try {
      await read();
    } catch (error) {
      report.line('gap', `could not be read: ${(error as Error).message}`);
    }
  }
  checkTile(io, report);
  report.say('');
  const seed = set === undefined ? 'seed' : `seed --set ${set}`;
  report.say(report.gaps === 0 ? `All green: the company bed is ready for ${seed}.` : `${report.gaps} gap(s) above.`);
  return report.gaps === 0 ? 0 : 1;
}

async function linearForWrite(
  io: CompanyIo,
  spec: BedSpec,
  report: Report,
): Promise<{ linear: BedLinear; targets: Map<string, TeamTarget> } | undefined> {
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}`);
    return undefined;
  }
  const linear = bedLinear(io, key, report);
  const workspace = await linear.workspace(spec.teams.map((team) => team.key));
  const gaps = workspaceGaps(spec, workspace);
  for (const gap of gaps) report.line('gap', gap);
  if (gaps.length > 0) {
    report.say('  Nothing was changed: the teams, projects and states are made by hand first.');
    return undefined;
  }
  return { linear, targets: teamTargets(spec, workspace) };
}

/**
 * What one seed or post has written so far: the tickets it made active, which
 * this clone may archive at teardown, the label it created, and the undo that
 * takes its writes back when a later call fails. A write the undo cannot take
 * back is kept, so the state file records it for teardown.
 */
class BedWrites {
  readonly activated: string[] = [];
  createdLabelId?: string;
  private readonly undo = new UndoLedger();
  private readonly strandedIssues: Array<{ id: string; identifier: string }> = [];
  private strandedLabelId?: string;

  constructor(private readonly linear: BedLinear) {}

  /** A ticket this run created or unarchived; the undo archives it. */
  activatedIssue(issue: { id: string; identifier: string }, undoLabel: string): void {
    this.activated.push(issue.id);
    this.undo.register(undoLabel, async (): Promise<void> => {
      try {
        await this.linear.archive(issue);
      } catch (error) {
        this.strandedIssues.push(issue);
        throw error;
      }
    });
  }

  /** The label this run created; the undo deletes it. */
  createdLabel(name: string, id: string): void {
    this.createdLabelId = id;
    this.undo.register(`delete label ${name}`, async (): Promise<void> => {
      try {
        await this.linear.deleteLabel(name, id);
      } catch (error) {
        this.strandedLabelId = id;
        throw error;
      }
    });
  }

  /**
   * Report the failure, take back what this run wrote, and record in the
   * state file whatever the undo could not, so teardown removes it.
   *
   * Args:
   *   io: The machine.
   *   verb: `seed` or `post`, for the report.
   *   error: What stopped the run.
   *   previous: The state file as the run found it.
   *   labelName: The bed's label name, for the report.
   *   report: The report.
   */
  async rollBack(
    io: CompanyIo,
    verb: string,
    error: unknown,
    previous: CompanyState | undefined,
    labelName: string,
    report: Report,
  ): Promise<void> {
    report.line('gap', `${verb} stopped: ${(error as Error).message}`);
    for (const result of await this.undo.runAll()) {
      report.line(result.ok ? 'ok' : 'gap', `undo: ${result.label}${result.ok ? '' : ` failed (${result.error})`}`);
    }
    if (this.strandedIssues.length === 0 && this.strandedLabelId === undefined) return;
    writeState(io, {
      epoch: previous?.epoch ?? slackTs(io.now()),
      issueIds: [...new Set([...(previous?.issueIds ?? []), ...this.strandedIssues.map((issue) => issue.id)])],
      issueKeys: previous?.issueKeys ?? [],
      labelId: this.strandedLabelId ?? previous?.labelId,
      ownsLabel: previous?.ownsLabel === true || this.strandedLabelId !== undefined,
    });
    for (const issue of this.strandedIssues) {
      report.line('note', `${issue.identifier} is recorded in ${STATE_FILE} so teardown archives it`);
    }
    if (this.strandedLabelId !== undefined) {
      report.line('note', `label ${labelName} is recorded in ${STATE_FILE} so teardown deletes it`);
    }
  }
}

async function ensureLabel(
  linear: BedLinear,
  spec: BedSpec,
  existing: BedLabel | undefined,
  writes: BedWrites,
  report: Report,
): Promise<string> {
  if (existing) return existing.id;
  const id = await linear.createLabel(spec.label);
  writes.createdLabel(spec.label, id);
  report.line('ok', `created label ${spec.label}`);
  return id;
}

async function fileTicket(
  linear: BedLinear,
  ticket: BedTicket,
  existing: BedIssue | undefined,
  target: TeamTarget,
  labelId: string,
  writes: BedWrites,
  report: Report,
): Promise<void> {
  const stateId = target.states.get(ticket.state)!;
  if (!existing) {
    const created = await linear.createIssue(ticket.key, {
      teamId: target.teamId,
      projectId: target.projectId,
      title: ticket.title,
      description: markedDescription(ticket.description, ticket.key),
      stateId,
      labelIds: [labelId],
    });
    writes.activatedIssue(created, `archive ${created.identifier}`);
    report.line('ok', `created ${ticket.key} as ${created.identifier} "${ticket.title}" (${ticket.state})`);
    return;
  }
  if (existing.archived) {
    await linear.unarchive(existing);
    writes.activatedIssue(existing, `archive ${existing.identifier} again`);
    report.line('ok', `unarchived ${ticket.key} ${existing.identifier}`);
  }
  const input = resetInput(existing, ticket, { teamId: target.teamId, projectId: target.projectId, stateId, labelId });
  if (Object.keys(input).length > 0) {
    await linear.updateIssue(existing, input);
    report.line('ok', `put ${ticket.key} ${existing.identifier} back (${Object.keys(input).join(', ')})`);
  }
  const trailers = (await linear.comments(existing)).filter((comment) => containsProvenanceTrailer(comment.body));
  for (const comment of trailers) await linear.deleteComment(existing, comment.id);
  report.line(
    'ok',
    `${ticket.key} ${existing.identifier} is "${ticket.title}" (${ticket.state}), unassigned${trailers.length > 0 ? `; deleted ${trailers.length} comment(s) with a provenance trailer` : ''}`,
  );
}

/** `seed`: the tickets created or put back, the bed's messages deleted, the tile restarted. */
export async function runSeed(io: CompanyIo, set: string | undefined, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  const toFile = ticketsToFile(spec, set);
  const previous = readState(io);
  const slackToken = io.env[SLACK_TOKEN_ENV]?.trim();
  const project = composeProject(io);
  report.section('Linear');
  if (!slackToken) report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}`);
  if (!project) report.line('gap', `COMPOSE_PROJECT_NAME is not set in ${ENV_FILE}: run ./setup.sh first`);
  const forWrite = await linearForWrite(io, spec, report);
  if (!forWrite || !slackToken || !project) return 1;
  const { linear, targets } = forWrite;
  const { byKey, duplicates } = issuesByKey(await linear.issues());
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) report.line('gap', `${duplicate}: remove the marker from one or delete it by hand; archiving alone keeps it in the bed's read`);
    return 1;
  }
  if (!previous) {
    const active = [...byKey.values()].filter((issue) => !issue.archived);
    if (active.length > 0) {
      for (const issue of active) report.line('gap', `${issue.identifier} is an active marked ticket from another clone: archive it there before this clone seeds`);
      return 1;
    }
  }
  const writes = new BedWrites(linear);
  let recorded = previous;
  try {
    const existingLabel = await linear.label(spec.label);
    recorded = {
      epoch: previous?.epoch ?? slackTs(io.now()),
      issueIds: previous?.issueIds ?? [],
      issueKeys: [
        ...new Set([
          ...(previous?.issueKeys ?? []),
          ...toFile
            .filter((ticket) => byKey.get(ticket.key)?.archived !== false)
            .map((ticket) => ticket.key),
        ]),
      ],
      labelId: previous?.labelId,
      ownsLabel: previous?.ownsLabel === true || existingLabel === undefined,
    };
    // Persist deterministic ownership before a provider write can land without returning.
    writeState(io, recorded);
    const labelId = await ensureLabel(linear, spec, existingLabel, writes, report);
    for (const ticket of spec.tickets) {
      const existing = byKey.get(ticket.key);
      if (!toFile.includes(ticket)) {
        if (existing && !existing.archived) {
          await linear.archive(existing);
          report.line(
            'ok',
            set === undefined
              ? `archived ${ticket.key} ${existing.identifier}; post files it at its protocol step`
              : `archived ${ticket.key} ${existing.identifier}; it is outside the set ${set}`,
          );
        }
        continue;
      }
      await fileTicket(linear, ticket, existing, targets.get(ticket.team)!, labelId, writes, report);
    }
  } catch (error) {
    await writes.rollBack(io, 'seed', error, recorded, spec.label, report);
    return 1;
  }

  // Recorded from seed's own writes: a read here that failed would leave filed tickets no clone owns.
  const state: CompanyState = {
    ...recorded!,
    issueIds: [...new Set([...recorded!.issueIds, ...writes.activated])],
    // A label seed made supersedes the recorded one, which must already be gone for seed to make it.
    labelId: writes.createdLabelId ?? recorded!.labelId,
  };
  writeState(io, state);
  report.section('Slack');
  try {
    await deleteBedMessages(io, await slackView(io, slackToken, report, false), state.epoch, report);
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
  const seeded = set === undefined ? 'Seeded.' : `Seeded the set ${set}: ${toFile.map((ticket) => ticket.key).join(', ')}.`;
  report.say(report.gaps === 0 ? seeded : `${report.gaps} gap(s) above.`);
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
  const state = readState(io);
  if (!state) {
    report.line('gap', `run seed first so ${STATE_FILE} records which late ticket this clone may tear down`);
    return 1;
  }
  const forWrite = await linearForWrite(io, spec, report);
  if (!forWrite) return 1;
  const { linear, targets } = forWrite;
  const { byKey, duplicates } = issuesByKey(await linear.issues());
  if (duplicates.length > 0) {
    for (const duplicate of duplicates) report.line('gap', `${duplicate}: remove the marker from one or delete it by hand; archiving alone keeps it in the bed's read`);
    return 1;
  }
  const existing = byKey.get(key);
  if (existing && !existing.archived) {
    report.line('ok', `${key} is already filed as ${existing.identifier} (${existing.stateName}); nothing changed`);
    return 0;
  }
  const writes = new BedWrites(linear);
  let recorded = state;
  try {
    const existingLabel = await linear.label(spec.label);
    recorded = {
      ...state,
      issueKeys: [...new Set([...state.issueKeys, ...(existing?.archived !== false ? [ticket.key] : [])])],
      ownsLabel: state.ownsLabel || existingLabel === undefined,
    };
    writeState(io, recorded);
    const labelId = await ensureLabel(linear, spec, existingLabel, writes, report);
    await fileTicket(linear, ticket, existing, targets.get(ticket.team)!, labelId, writes, report);
  } catch (error) {
    await writes.rollBack(io, 'post', error, recorded, spec.label, report);
    return 1;
  }
  writeState(io, {
    ...recorded,
    issueIds: [...new Set([...recorded.issueIds, ...writes.activated])],
    labelId: writes.createdLabelId ?? recorded.labelId,
  });
  return 0;
}

/** What failed, said once: a retry's own line already names the call. */
function failure(what: string, error: unknown): string {
  const message = (error as Error).message;
  return message.startsWith(what) ? message : `${what} failed: ${message}`;
}

/**
 * Archive this clone's tickets and delete the label seed made. Each call that
 * fails even after its retry is one gap line and the rest still run, so one
 * failure never leaves the Slack half untouched.
 */
async function teardownLinear(linear: BedLinear, spec: BedSpec, state: CompanyState, report: Report): Promise<void> {
  let issues: BedIssue[] = [];
  try {
    issues = await linear.issues();
  } catch (error) {
    report.line('gap', `${failure('ticket read', error)}; no ticket was archived`);
  }
  const ownedIds = new Set(state.issueIds);
  const ownedKeys = new Set(state.issueKeys);
  for (const issue of issues.filter((candidate) => (ownedIds.has(candidate.id) || ownedKeys.has(candidate.key)) && !candidate.archived)) {
    try {
      await linear.archive(issue);
      report.line('ok', `archived ${issue.key} ${issue.identifier}`);
    } catch (error) {
      report.line('gap', failure(`${issue.identifier} archive`, error));
    }
  }
  if (!state.labelId && !state.ownsLabel) return;
  let label: BedLabel | undefined;
  try {
    label = await linear.label(spec.label);
  } catch (error) {
    report.line('gap', failure('label read', error));
    return;
  }
  if (!label || label.description !== LABEL_DESCRIPTION || (!state.ownsLabel && label.id !== state.labelId)) return;
  try {
    await linear.deleteLabel(spec.label, label.id);
    report.line('ok', `deleted label ${spec.label}, which seed created`);
  } catch (error) {
    report.line('gap', failure('label delete', error));
  }
}

/** `teardown`: archive the bed's tickets and delete the bed's bot messages. */
export async function runTeardown(io: CompanyIo, report: Report): Promise<number> {
  const spec = loadBedSpec(io.cwd);
  const state = readState(io);
  report.section('Linear');
  const key = io.env[LINEAR_KEY_ENV]?.trim();
  if (!key) {
    report.line('gap', `${LINEAR_KEY_ENV} is not set in ${ENV_FILE}`);
  } else if (!state) {
    report.line('note', `no seed is recorded in ${STATE_FILE} on this clone, so no Linear ticket is this clone's to archive`);
  } else {
    await teardownLinear(bedLinear(io, key, report), spec, state, report);
  }
  report.section('Slack');
  const token = io.env[SLACK_TOKEN_ENV]?.trim();
  const epoch = state?.epoch;
  if (!token) {
    report.line('gap', `${SLACK_TOKEN_ENV} is not set in ${ENV_FILE}`);
  } else if (!epoch) {
    report.line('note', `no seed is recorded in ${STATE_FILE} on this clone, so no Slack message is the bed's to delete`);
  } else {
    try {
      await deleteBedMessages(io, await slackView(io, token, report, false), epoch, report);
    } catch (error) {
      report.line('gap', `Slack: ${(error as Error).message}`);
    }
    if (report.gaps === 0) rmSync(join(io.cwd, STATE_FILE));
  }
  report.say('');
  if (report.gaps === 0) report.say('Torn down.');
  else if (state) report.say(`${report.gaps} gap(s) above. ${STATE_FILE} is kept: run teardown again to finish.`);
  else report.say(`${report.gaps} gap(s) above.`);
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
        return await runCheck(io, options.set, report);
      case 'seed':
        return await runSeed(io, options.set, report);
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
    sleep: (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms)),
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
