/**
 * The rehearsal's phases in their fixed order, with the dry-run boundary
 * between them. One list serves both modes: a live run executes every phase,
 * a dry run executes up to the boundary and then prints, from the same
 * declarations, the provider writes the remaining phases would make.
 */
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Bed } from './bed';
import * as bed from './bed';
import {
  agentNamed,
  allSourcesSynced,
  batchHeld,
  CARDS,
  closingHeld,
  competingClaims,
  failedSource,
  landingRefusal,
  orientationDone,
  skipKind,
  surfaceBySlug,
  surfaceSummary,
  TICKET,
  ticketItem,
  TILE_SLUG,
  type BackendReader,
  type WorkItemRow,
} from './backend';
import { nextAnswer } from './answers';
import {
  checkBrowserBatchHeldWhole,
  checkClosingCommentQuotesReadBack,
  checkCompletion,
  checkPlanWithoutOwnershipGate,
  checkWrongKeyReadRepaired,
  type CheckResult,
} from './checks';
import type { UndoLedger } from './cleanup';
import type { Dashboard } from './driver';
import { bedEnvValues, envRefusal, secretsRefusal, type RehearsalSecrets } from './env';
import {
  assignIssue,
  deleteComment,
  issueRestoreSteps,
  moveIssue,
  readComments,
  readIssueSnapshot,
  readMutationNames,
  readViewer,
  ticketRestRefusal,
  type IssueSnapshot,
  type LinearClient,
} from './linear';
import { projectRefusal, type RehearsalOptions } from './options';
import type { RunDirectory } from './output';
import { pickFreePorts, portsFromBase, portsRefusal } from './ports';
import { waitUntil, type Runner, type ServerHandle, type ServerStarter } from './process';
import { shotPath } from './output';
import type { RunRecord } from './report';
import { belongsToWorkItems, botMessagesSince, type SlackClient } from './slack';

/** The agent the rehearsal deploys. */
export const AGENT_NAME = 'rehearsal worker';
/** The label the documentation folder is linked under. */
export const DOCS_LABEL = 'team docs';
/** Where the primary's documentation folder is, relative to the primary checkout. */
export const DOCS_LOCAL = 'docs-local';
/** The Slack DM messages the run may delete are those after this many seconds before the boundary. */
const SLACK_START_SLACK_S = 5;

/** What the rehearsal knows as it goes; every phase reads and extends it. */
export interface RehearsalState {
  commit?: string;
  bed?: Bed;
  server?: ServerHandle;
  backend?: BackendReader;
  exportForAgent?: (agentId: string) => Promise<unknown>;
  dashboard?: Dashboard;
  viewer?: { id: string; name: string };
  ticketBefore?: IssueSnapshot;
  mutationNames?: string[];
  slackBot?: { team: string; userId: string; botId: string };
  slackStartTs?: string;
  managerDmChannelId?: string;
  agentId?: string;
  ticketItemId?: string;
  ticketTitle?: string;
  shots: number;
}

/** Everything a phase can touch, injected so a test can hand in doubles. */
export interface RehearsalContext {
  options: RehearsalOptions;
  secrets: RehearsalSecrets;
  /** The primary checkout. */
  primary: string;
  /** The repository the clone is taken from. */
  source: string;
  record: RunRecord;
  out: RunDirectory;
  log: (line: string) => void;
  runner: Runner;
  startServer: ServerStarter;
  fetchImpl: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  linear: LinearClient;
  slack?: SlackClient;
  ledger: UndoLedger;
  /** Docker's view, read fresh: compose projects, volumes, container project labels. */
  dockerInventory: () => { composeProjects: string[]; volumes: string[]; labelledContainers: string[] };
  /** Whether a port is free. */
  portIsFree: (port: number) => Promise<boolean>;
  openDashboard: (origin: string) => Promise<Dashboard>;
  connectBackend: (
    url: string,
    signingKey: string,
  ) => Promise<{ reader: BackendReader; exportForAgent: (agentId: string) => Promise<unknown> }>;
  /** The primary checkout's own compose project name. */
  primaryProject: string;
  /** The operator's env values, read-only. */
  sourceEnv: Record<string, string>;
  state: RehearsalState;
}

export interface Phase {
  name: string;
  /** Provider writes this phase makes; only phases after the boundary have any. */
  writes: string[];
  run: (ctx: RehearsalContext) => Promise<string | void>;
}

/** The first phase that writes to a provider. A dry run stops before it. */
export const BOUNDARY = 'assign-ticket';

/** The dry run's own note in the summary. */
export const DRY_RUN_NOTE =
  'Dry run: every phase up to the boundary ran for real (the bed, the documentation, the deploy, the 1:1, the charter, orientation and the card probes are all reads against the workspaces); the phases after it were not run and are listed with the writes each would make.';

class StopRun extends Error {}

function requireState<K extends keyof RehearsalState>(state: RehearsalState, key: K): NonNullable<RehearsalState[K]> {
  const value = state[key];
  if (value === undefined || value === null) throw new Error(`phase ordering: ${String(key)} is not set yet.`);
  return value as NonNullable<RehearsalState[K]>;
}

async function shot(ctx: RehearsalContext, slug: string): Promise<void> {
  const dashboard = ctx.state.dashboard;
  if (!dashboard) return;
  ctx.state.shots += 1;
  await dashboard.screenshot(shotPath(ctx.out.path, ctx.state.shots, slug));
}

function recordCheck(ctx: RehearsalContext, result: CheckResult): void {
  ctx.record.checks.push(result);
  ctx.out.writeCheckRows(result.check, result.rows);
  ctx.log(`check ${result.check}: ${result.passed ? 'pass' : 'FAIL'} - ${result.detail}`);
  if (!result.passed) throw new StopRun(`check ${result.check} failed: ${result.detail}`);
}

async function waitFor<T>(
  ctx: RehearsalContext,
  what: string,
  timeoutMs: number,
  probe: () => Promise<T | undefined | false>,
): Promise<T> {
  return await waitUntil(probe, { what, timeoutMs, intervalMs: 3_000, sleep: ctx.sleep, now: ctx.now });
}

async function ticketRow(ctx: RehearsalContext): Promise<WorkItemRow> {
  const backend = requireState(ctx.state, 'backend');
  const row = await backend.workItem(requireState(ctx.state, 'ticketItemId'));
  if (!row) throw new Error(`the ${TICKET} work item disappeared.`);
  return row;
}

/* --------------------------------- phases --------------------------------- */

const preflight: Phase = {
  name: 'preflight',
  writes: [],
  run: async (ctx) => {
    const { options, secrets, state } = ctx;
    const secretsRefused = secretsRefusal(secrets);
    if (secretsRefused) throw new Error(secretsRefused);
    const envRefused = envRefusal(ctx.sourceEnv);
    if (envRefused) throw new Error(envRefused);
    const docs = resolve(ctx.primary, DOCS_LOCAL);
    if (!existsSync(docs) || !statSync(docs).isDirectory()) {
      throw new Error(`${docs} is not a directory; the rehearsal links the primary's documentation folder.`);
    }

    const inventory = ctx.dockerInventory();
    const refused = projectRefusal({
      project: ctx.record.project,
      primaryProject: ctx.primaryProject,
      composeProjects: inventory.composeProjects,
      volumes: inventory.volumes,
      labelledContainers: inventory.labelledContainers,
    });
    if (refused) throw new Error(refused);
    if (options.warmFrom && !inventory.volumes.includes(`${options.warmFrom}_redactor_models`)) {
      throw new Error(`--warm-from ${options.warmFrom}: no ${options.warmFrom}_redactor_models volume exists.`);
    }

    const ports = options.portBase ? portsFromBase(options.portBase) : await pickFreePorts(ctx.portIsFree);
    const portRefused = await portsRefusal(ports, ctx.portIsFree);
    if (portRefused) throw new Error(portRefused);
    ctx.record.ports = ports;

    state.viewer = await readViewer(ctx.linear);
    state.ticketBefore = await readIssueSnapshot(ctx.linear, TICKET);
    const restRefused = ticketRestRefusal(state.ticketBefore);
    if (restRefused) throw new Error(restRefused);
    state.mutationNames = await readMutationNames(ctx.linear);
    for (const needed of ['issueUpdate', 'commentDelete']) {
      if (!state.mutationNames.includes(needed)) {
        throw new Error(`Linear's schema exposes no ${needed} mutation; the run could not be put back.`);
      }
    }
    ctx.log(`Linear: viewer ${state.viewer.name}; ${TICKET} ${state.ticketBefore.stateName}, unassigned, ${state.ticketBefore.commentIds.length} comment(s)`);
    if (ctx.slack) {
      state.slackBot = await ctx.slack.authTest();
      ctx.log(`Slack: workspace ${state.slackBot.team}, bot ${state.slackBot.botId}`);
    } else {
      ctx.record.notes.push('No SLACK_BOT_TOKEN in the secrets file: the Slack card is left unapproved.');
    }
    return `ports ${ports.backend}-${ports.app}; ${TICKET} at rest (${state.ticketBefore.stateName})`;
  },
};

const clone: Phase = {
  name: 'clone',
  writes: [],
  run: async (ctx) => {
    const commit = bed.resolveCommit(ctx.runner, ctx.source, ctx.options.ref);
    ctx.state.commit = commit;
    ctx.record.commit = commit.slice(0, 7);
    const dirty = bed.dirtyPaths(ctx.runner, ctx.source);
    if (dirty.length > 0) {
      ctx.record.notes.push(`The source tree had ${dirty.length} uncommitted path(s); the clone is of commit ${commit.slice(0, 7)} without them.`);
    }
    bed.cloneAt(ctx.runner, ctx.source, commit, ctx.record.clone);
    bed.installDependencies(ctx.runner, ctx.record.clone);
    return `commit ${commit.slice(0, 7)} into ${ctx.record.clone}`;
  },
};

const env: Phase = {
  name: 'env',
  writes: [],
  run: async (ctx) => {
    const values = bedEnvValues({
      project: ctx.record.project,
      ports: ctx.record.ports,
      docsHostDir: resolve(ctx.primary, DOCS_LOCAL),
      source: ctx.sourceEnv,
    });
    bed.writeBedEnv(ctx.record.clone, values);
    bed.generateKeys(ctx.runner, ctx.record.clone);
    const written = bed.readBedEnv(ctx.record.clone);
    ctx.state.bed = {
      clone: ctx.record.clone,
      project: ctx.record.project,
      ports: ctx.record.ports,
      env: { ...written, COMPOSE_PROJECT_NAME: ctx.record.project },
    };
    return `${Object.keys(values).length} values plus the generated keys`;
  },
};

const warmVolumes: Phase = {
  name: 'warm-volumes',
  writes: [],
  run: async (ctx) => {
    if (!ctx.options.warmFrom) return 'no --warm-from: the redactor downloads its wheels and model on first start';
    bed.warmRedactorVolumes(ctx.runner, ctx.options.warmFrom, requireState(ctx.state, 'bed'));
    return `redactor volumes copied from ${ctx.options.warmFrom}`;
  },
};

const stack: Phase = {
  name: 'stack',
  writes: [],
  run: async (ctx) => {
    const current = requireState(ctx.state, 'bed');
    bed.composeUp(ctx.runner, current);
    await bed.waitForBackend(current.ports.backend, ctx.fetchImpl);
    const adminKey = bed.readAdminKey(ctx.runner, current);
    bed.updateBedEnv(current.clone, { CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey });
    current.env = { ...bed.readBedEnv(current.clone), COMPOSE_PROJECT_NAME: current.project };
    bed.syncEnv(ctx.runner, current);
    bed.pushFunctions(ctx.runner, current);
    bed.restartBackend(ctx.runner, current);
    const version = await bed.waitForBackend(current.ports.backend, ctx.fetchImpl);
    for (const service of ['sandbox', 'looker-tile', 'playwright-mcp']) {
      await bed.waitForHealthy(ctx.runner, current, service, 3 * 60_000, ctx.sleep);
    }
    await bed.waitForHealthy(ctx.runner, current, 'redactor', 20 * 60_000, ctx.sleep);
    const connected = await ctx.connectBackend(
      `http://127.0.0.1:${current.ports.backend}`,
      current.env.DEV_NO_AUTH_SIGNING_KEY ?? '',
    );
    ctx.state.backend = connected.reader;
    ctx.state.exportForAgent = connected.exportForAgent;
    return `backend ${version}; every component healthy`;
  },
};

const app: Phase = {
  name: 'app',
  writes: [],
  run: async (ctx) => {
    const current = requireState(ctx.state, 'bed');
    ctx.state.server = await bed.startApp(ctx.startServer, current, ctx.fetchImpl);
    const dashboard = await ctx.openDashboard(bed.appUrl(current, ''));
    ctx.state.dashboard = dashboard;
    await dashboard.unlock(bed.unlockUrl(current, current.env.DEV_NO_AUTH_SECRET ?? ''));
    await shot(ctx, 'unlocked');
    return `next dev pid ${ctx.state.server.pid} on localhost:${current.ports.app}`;
  },
};

const documentation: Phase = {
  name: 'documentation',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    await dashboard.linkFolder(DOCS_LABEL, '.');
    const sources = await waitFor(ctx, 'the documentation folder to sync', 15 * 60_000, async () => {
      const rows = await backend.docSources();
      const failed = failedSource(rows);
      if (failed) throw new Error(`documentation sync failed: ${failed.lastError ?? 'no reason recorded'}`);
      return allSourcesSynced(rows) ? rows : undefined;
    });
    await shot(ctx, 'documentation-synced');
    return `${sources.map((source) => `${source.label}: ${source.pageCount} pages`).join(', ')}`;
  },
};

const deploy: Phase = {
  name: 'deploy',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    const agentId = await dashboard.deploy(AGENT_NAME);
    await waitFor(ctx, 'the agent row', 60_000, async () => agentNamed(await backend.agents(), AGENT_NAME));
    ctx.state.agentId = agentId;
    await shot(ctx, 'deployed');
    return `agent ${agentId}`;
  },
};

const dayOne: Phase = {
  name: 'day-one',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    const agentId = requireState(ctx.state, 'agentId');
    await dashboard.chooseChat();
    let turn = 0;
    for (;;) {
      const outcome = await dashboard.waitForAgentTurn(3 * 60_000);
      if (outcome === 'complete') break;
      const answer = nextAnswer(turn);
      if (answer === undefined) {
        throw new Error(`the 1:1 asked a ${turn + 1}th question after the scripted answers ran out: "${await dashboard.lastAgentMessage()}"`);
      }
      ctx.log(`1:1 turn ${turn + 1}: agent asked "${(await dashboard.lastAgentMessage()).slice(0, 160)}"`);
      await dashboard.sendReply(answer);
      turn += 1;
    }
    await waitFor(ctx, 'the charter draft', 5 * 60_000, async () => (await backend.charter(agentId)) ?? undefined);
    await shot(ctx, 'day-one-complete');
    return `${turn} replies; charter drafted`;
  },
};

const charter: Phase = {
  name: 'charter',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    const agentId = requireState(ctx.state, 'agentId');
    await dashboard.approveCharter();
    await waitFor(ctx, 'the charter to be approved', 2 * 60_000, async () => {
      const row = await backend.charter(agentId);
      return row?.approved ? row : undefined;
    });
    await shot(ctx, 'charter-approved');
    return 'approved';
  },
};

const orientation: Phase = {
  name: 'orientation',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    const agentId = requireState(ctx.state, 'agentId');
    const surfaces = await waitFor(ctx, 'orientation to propose the cards', 10 * 60_000, async () => {
      const rows = await backend.surfaces(agentId);
      return orientationDone(rows) ? rows : undefined;
    });
    await dashboard.openSurfaces();
    await shot(ctx, 'orientation-cards');
    return surfaceSummary(surfaces);
  },
};

const cards: Phase = {
  name: 'cards',
  writes: [],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const backend = requireState(ctx.state, 'backend');
    const agentId = requireState(ctx.state, 'agentId');
    const outcomes: string[] = [];
    await dashboard.openSurfaces();
    const rows = await backend.surfaces(agentId);
    for (const card of CARDS) {
      if (card.credential === 'none') continue;
      const row = surfaceBySlug(rows, card.slug);
      const refused = row ? landingRefusal(row) : `no ${card.slug} card was proposed`;
      if (refused) {
        await shot(ctx, `${card.slug}-not-landable`);
        throw new StopRun(refused);
      }
    }
    for (const card of CARDS) {
      if (card.credential === 'linear') await dashboard.landCredential(card.slug, ctx.secrets.linearApiKey ?? '');
      if (card.credential === 'slack') {
        if (!ctx.secrets.slackBotToken) {
          outcomes.push(`${card.slug}: left unapproved (no token)`);
          continue;
        }
        await dashboard.landCredential(card.slug, ctx.secrets.slackBotToken);
      }
      await dashboard.approveCard(card.slug);
      const row = await waitFor(ctx, `${card.slug} to connect`, 3 * 60_000, async () => {
        const surface = surfaceBySlug(await backend.surfaces(agentId), card.slug);
        if (!surface) return undefined;
        if (['ungranted', 'listed-dead', 'absent'].includes(surface.verdict)) {
          throw new Error(`${card.slug} ended ${surface.verdict}: ${surface.reason ?? 'no reason recorded'}`);
        }
        return surface.verdict === 'connected' ? surface : undefined;
      });
      if (card.slug === 'slack') ctx.state.managerDmChannelId = (row as { managerDmChannelId?: string }).managerDmChannelId;
      outcomes.push(`${card.slug}: connected`);
    }
    await shot(ctx, 'cards-connected');
    return outcomes.join(', ');
  },
};

/* ------------------------------- the boundary ------------------------------ */

const assignTicket: Phase = {
  name: BOUNDARY,
  writes: [`Linear issueUpdate ${TICKET} assigneeId = the key's own user (undone at cleanup: assignee back to the snapshot)`],
  run: async (ctx) => {
    const viewer = requireState(ctx.state, 'viewer');
    const before = requireState(ctx.state, 'ticketBefore');
    ctx.state.slackStartTs = ((ctx.now() / 1000) - SLACK_START_SLACK_S).toFixed(6);
    ctx.ledger.register(`${TICKET} assignee back to ${before.assigneeId ?? 'unassigned'}`, async () => {
      const current = await readIssueSnapshot(ctx.linear, TICKET);
      if (current.assigneeId === viewer.id) await assignIssue(ctx.linear, before.id, before.assigneeId);
    });
    await assignIssue(ctx.linear, before.id, viewer.id);
    ctx.record.writes.push(`Linear: ${TICKET} assigned to ${viewer.name} (${viewer.id})`);
    if (ctx.slack && ctx.state.managerDmChannelId) {
      const slack = ctx.slack;
      const channel = ctx.state.managerDmChannelId;
      const botId = requireState(ctx.state, 'slackBot').botId;
      const startTs = ctx.state.slackStartTs;
      ctx.ledger.register(`this work item's bot DMs in ${channel} deleted`, async () => {
        const messages = botMessagesSince(
          await slack.history(channel, startTs), botId, startTs,
          ctx.state.ticketItemId ? [ctx.state.ticketItemId] : [],
        );
        const failures: string[] = [];
        for (const message of messages) {
          try {
            await slack.deleteMessage(channel, message.ts);
          } catch (error) {
            failures.push(`${message.ts}: ${(error as Error).message}`);
          }
        }
        ctx.record.writes.push(`Slack: ${messages.length} DM(s) from the bot deleted`);
        if (failures.length > 0) throw new Error(failures.join('; '));
      });
    }
    return `${TICKET} assigned to ${viewer.name}`;
  },
};

const intake: Phase = {
  name: 'intake',
  writes: [],
  run: async (ctx) => {
    const backend = requireState(ctx.state, 'backend');
    const agentId = requireState(ctx.state, 'agentId');
    bed.pollIntake(ctx.runner, requireState(ctx.state, 'bed'));
    const item = await waitFor(ctx, `${TICKET} to be taken in`, 5 * 60_000, async () =>
      ticketItem(await backend.workItems(agentId)),
    );
    ctx.state.ticketItemId = item._id;
    ctx.state.ticketTitle = item.title;
    await shot(ctx, 'intake');
    return `${TICKET} item ${item._id} at ${item.state}`;
  },
};

/**
 * Bring the ticket to a drafted plan whatever the evaluator did with it: a
 * quality-fit skip is retried from its card, a competing claim has its plan
 * cancelled, a skill proposal is approved and its registration awaited.
 */
async function reachPlan(ctx: RehearsalContext): Promise<WorkItemRow> {
  const dashboard = requireState(ctx.state, 'dashboard');
  const backend = requireState(ctx.state, 'backend');
  const agentId = requireState(ctx.state, 'agentId');
  const title = requireState(ctx.state, 'ticketTitle');
  const acted = new Set<string>();
  return await waitFor(ctx, `${TICKET} to reach a drafted plan`, 25 * 60_000, async () => {
    const item = await ticketRow(ctx);
    if (item.state === 'plan-pending' && item.plan) return item;
    if (item.state === 'skipped') {
      const kind = skipKind(item);
      if (kind === 'out-of-scope') throw new StopRun(`${TICKET} skipped as out of scope: "${item.skipReason}"`);
      if (kind === 'quality-fit' && !acted.has('retry')) {
        acted.add('retry');
        ctx.log(`${TICKET} skipped by the quality-fit filter; Retry from its card`);
        await dashboard.retry(title);
        return undefined;
      }
      throw new StopRun(`${TICKET} skipped: "${item.skipReason}"`);
    }
    if (item.state === 'needs-skill') {
      const proposed = (await backend.skills(agentId, 'proposed')).find((skill) => skill.proposedFor === item._id);
      if (proposed && !acted.has(`skill:${proposed._id}`)) {
        acted.add(`skill:${proposed._id}`);
        ctx.log(`approving the proposed skill "${proposed.name}"`);
        await dashboard.approveSkill(proposed.name);
      }
      return undefined;
    }
    if (item.state === 'discovered') {
      for (const other of competingClaims(await backend.workItems(agentId), item._id)) {
        if (other.state === 'plan-pending' && !acted.has(`cancel:${other._id}`)) {
          acted.add(`cancel:${other._id}`);
          ctx.log(`cancelling the plan on "${other.title}" so the cold-start slot frees`);
          await dashboard.cancelPlan(other.title);
        }
      }
      await dashboard.showAgent();
      return undefined;
    }
    if (['failed', 'cancelled'].includes(item.state)) throw new StopRun(`${TICKET} ${item.state}: ${item.skipReason ?? ''}`);
    return undefined;
  });
}

const plan: Phase = {
  name: 'plan',
  writes: [],
  run: async (ctx) => {
    const item = await reachPlan(ctx);
    await shot(ctx, 'plan-drafted');
    recordCheck(ctx, checkPlanWithoutOwnershipGate(item));
    return `${item.plan?.steps.length ?? 0} steps`;
  },
};

const approvePlan: Phase = {
  name: 'approve-plan',
  writes: [
    'Linear reads on REVOPS-7 under the probed key (get_issue, list_comments); a refused first read is repaired once',
    'the tile sequence (navigate, sign in, set the value, save, read back) emitted and held whole for the manager',
  ],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    await dashboard.approvePlan(requireState(ctx.state, 'ticketTitle'));
    const item = await waitFor(ctx, 'phase one to park with the batch held', 15 * 60_000, async () => {
      const row = await ticketRow(ctx);
      if (['failed', 'cancelled', 'skipped'].includes(row.state)) throw new StopRun(`${TICKET} ${row.state}: ${row.skipReason ?? ''}`);
      return batchHeld(row) ? row : undefined;
    });
    await shot(ctx, 'batch-held');
    recordCheck(ctx, checkBrowserBatchHeldWhole(item, TILE_SLUG));
    recordCheck(ctx, checkWrongKeyReadRepaired(item));
    return 'batch held';
  },
};

const approveBatch: Phase = {
  name: 'approve-batch',
  writes: [
    'the tile driven through the browser component: sign in, set the value, save, read back (the tile is per project, in memory; teardown restores it)',
    'a DM to the manager on Slack when the card is connected (deleted at cleanup)',
    'the closing ticket comment and the Done move emitted and held for the manager',
  ],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const title = requireState(ctx.state, 'ticketTitle');
    await dashboard.approveAll(title);
    const item = await waitFor(ctx, 'the closing phase to park with the comment held', 15 * 60_000, async () => {
      const row = await ticketRow(ctx);
      if (['failed', 'cancelled', 'skipped'].includes(row.state)) throw new StopRun(`${TICKET} ${row.state}: ${row.skipReason ?? ''}`);
      return closingHeld(row, TILE_SLUG) ? row : undefined;
    });
    await shot(ctx, 'closing-held');
    recordCheck(ctx, checkClosingCommentQuotesReadBack(item));
    return 'closing comment held';
  },
};

const approveClosing: Phase = {
  name: 'approve-closing',
  writes: [
    `Linear save_comment on ${TICKET} quoting the read-back (deleted at cleanup: new comments attributed to this work item)`,
    `Linear ${TICKET} moved to Done (moved back at cleanup to the snapshot's state)`,
  ],
  run: async (ctx) => {
    const dashboard = requireState(ctx.state, 'dashboard');
    const before = requireState(ctx.state, 'ticketBefore');
    const linear = ctx.linear;
    ctx.ledger.register(`${TICKET} state and comments back to the snapshot`, async () => {
      const after = await readIssueSnapshot(linear, TICKET);
      const item = await ticketRow(ctx);
      const comments = await readComments(linear, before.id);
      const ownedComments = comments.filter(comment => belongsToWorkItems(comment.body, [item._id]));
      const ledgers = [item.output, item.output?.initial];
      const wroteCurrentState = ledgers.some(output => output?.actions?.some((action, index) => {
        const receipt = output.applied?.[index];
        if (!receipt?.ok || receipt.held || receipt.awaitingApproval) return false;
        if (action.tool !== 'mcp.call' || action.args.surface !== 'linear' || action.args.tool !== 'save_issue') return false;
        const args = JSON.parse(action.args.toolArgsJson ?? '{}') as Record<string, unknown>;
        return [before.id, before.identifier].includes(String(args.id)) && args.state === after.stateName;
      }));
      for (const step of issueRestoreSteps(before, after, {
        commentIds: ownedComments.map(comment => comment.id),
        ...(wroteCurrentState ? { stateId: after.stateId } : {}),
      })) {
        if (step.kind === 'delete-comment') await deleteComment(linear, step.commentId);
        if (step.kind === 'move') await moveIssue(linear, before.id, step.stateId);
        if (step.kind === 'assign') await assignIssue(linear, before.id, step.assigneeId);
      }
    });
    await dashboard.approveAll(requireState(ctx.state, 'ticketTitle'));
    const item = await waitFor(ctx, 'the run to complete', 10 * 60_000, async () => {
      const row = await ticketRow(ctx);
      if (['failed', 'cancelled', 'skipped'].includes(row.state)) throw new StopRun(`${TICKET} ${row.state}: ${row.skipReason ?? ''}`);
      return row.state === 'completed' ? row : undefined;
    });
    const after = await readIssueSnapshot(linear, TICKET);
    const comments = await readComments(linear, before.id);
    const newComments = comments.filter((comment) => !before.commentIds.includes(comment.id)).map((comment) => comment.body);
    ctx.record.writes.push(`Linear: ${TICKET} now ${after.stateName} with ${newComments.length} new comment(s)`);
    await shot(ctx, 'completed');
    recordCheck(ctx, checkCompletion(item, { stateName: after.stateName, newComments }));
    return `completed; ${TICKET} ${after.stateName}`;
  },
};

const exportLedger: Phase = {
  name: 'export',
  writes: [],
  run: async (ctx) => {
    const exportForAgent = requireState(ctx.state, 'exportForAgent');
    ctx.out.writeExport(await exportForAgent(requireState(ctx.state, 'agentId')));
    return 'export.json written';
  },
};

/** The phases in order. */
export const PHASES: readonly Phase[] = [
  preflight,
  clone,
  env,
  warmVolumes,
  stack,
  app,
  documentation,
  deploy,
  dayOne,
  charter,
  orientation,
  cards,
  assignTicket,
  intake,
  plan,
  approvePlan,
  approveBatch,
  approveClosing,
  exportLedger,
];

/**
 * The provider writes a dry run does not make, from the same declarations the
 * live run executes.
 *
 * Args:
 *   phases: The phase list.
 *
 * Returns:
 *   One line per declared write, prefixed by its phase.
 */
export function declaredWrites(phases: readonly Phase[] = PHASES): string[] {
  const boundary = phases.findIndex((phase: Phase): boolean => phase.name === BOUNDARY);
  return phases
    .slice(boundary)
    .flatMap((phase: Phase): string[] => phase.writes.map((write: string): string => `${phase.name}: ${write}`));
}

/**
 * Run the phases in order, rewriting the record after each.
 *
 * Args:
 *   ctx: The context.
 *   phases: The phase list.
 *
 * Returns:
 *   Nothing; the record says what happened.
 */
export async function runPhases(ctx: RehearsalContext, phases: readonly Phase[] = PHASES): Promise<void> {
  for (const phase of phases) {
    if (ctx.options.dryRun && phase.name === BOUNDARY) {
      ctx.record.status = 'dry-run';
      ctx.record.stoppedAt = `the boundary, before ${BOUNDARY}`;
      ctx.record.writes.push(...declaredWrites(phases));
      ctx.record.notes.push(DRY_RUN_NOTE);
      for (const remaining of phases.slice(phases.indexOf(phase))) {
        ctx.record.phases.push({ name: remaining.name, status: 'skipped', detail: 'dry run' });
      }
      ctx.out.writeRecord(ctx.record);
      ctx.log(`dry run: stopped before ${BOUNDARY}`);
      return;
    }
    const startedAt = ctx.now();
    ctx.log(`phase ${phase.name}`);
    try {
      const detail = await phase.run(ctx);
      ctx.record.phases.push({ name: phase.name, status: 'ok', seconds: (ctx.now() - startedAt) / 1000, detail: detail ?? undefined });
    } catch (error) {
      const reason = (error as Error).message;
      const stopped = error instanceof StopRun;
      ctx.record.phases.push({ name: phase.name, status: stopped ? 'stopped' : 'failed', seconds: (ctx.now() - startedAt) / 1000, detail: reason });
      ctx.record.status = 'failed';
      ctx.record.stoppedAt = `${phase.name}: ${reason}`;
      ctx.out.writeRecord(ctx.record);
      ctx.log(`stopped at ${phase.name}: ${reason}`);
      return;
    }
    ctx.out.writeRecord(ctx.record);
  }
  ctx.record.status = ctx.record.checks.every((check) => check.passed) && ctx.record.checks.length === 5 ? 'passed' : 'failed';
  ctx.out.writeRecord(ctx.record);
}
