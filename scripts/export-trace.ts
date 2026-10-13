/**
 * Export one agent's whole trace to one file, a page at a time:
 *
 *   pnpm export:trace <agentId> --out <trace.json> [--identity <subject>]
 *
 * The export action never returns the whole trace (the pinned backend image
 * refuses an array past 8,192 elements, which one agent's events pass), so
 * this calls `exportActions:exportForAgent` for the head and
 * `exportActions:exportPage` for each page through `npx convex run`, under the
 * owner's identity, until nothing is left, and writes the assembled trace:
 * the manifest with its release, commit, date and row counts, the agent, the
 * owner section and every section in full. `pnpm metrics:recompute` reads the
 * file.
 *
 * `--identity` defaults to the no-auth subject every local bed runs as. Exit
 * 0: written; 2: usage, or a call the deployment refused.
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DEV_NO_AUTH_SUBJECT } from '../src/lib/dev-auth-issuer';
import {
  assembleOwnerExport,
  assembleTrace,
  type AgentTrace,
  type OwnerAgentsPage,
  type OwnerExport,
  type OwnerExportHead,
  type OwnerPage,
  type TraceHead,
  type TracePage,
} from '../src/export/trace';

const USAGE =
  'Usage: pnpm export:trace <agentId> --out <trace.json> [--identity <subject>], or pnpm export:trace --owner --out <owner.json> [--identity <subject>]';

/** One call of a deployed function: its name, its arguments, the caller's subject. */
export type ConvexRun = (name: string, args: Record<string, unknown>, subject: string) => unknown;

interface Io {
  log(line: string): void;
  error(line: string): void;
}

/**
 * Run a deployed function with `npx convex run` under one identity.
 *
 * @returns The function's result, parsed from the JSON `convex run` prints.
 * @throws Error carrying the command's own message when it fails.
 */
export const npxConvexRun: ConvexRun = (name, args, subject) => {
  const result = spawnSync(
    'npx',
    ['convex', 'run', name, JSON.stringify(args), '--identity', JSON.stringify({ subject })],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`${name} failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout) as unknown;
};

/**
 * Assemble one agent's trace through a runner of deployed functions.
 *
 * @returns The whole trace.
 */
export async function exportTrace(
  agentId: string,
  run: ConvexRun,
  subject: string = DEV_NO_AUTH_SUBJECT,
): Promise<AgentTrace> {
  return await assembleTrace(agentId, {
    head: async () =>
      (await run('exportActions:exportForAgent', { agentId }, subject)) as TraceHead,
    page: async ({ page }) =>
      (await run(
        'exportActions:exportPage',
        { agentId, section: page.section, cursor: page.cursor },
        subject,
      )) as TracePage,
  });
}

/**
 * Export the caller's owner export (wave 16, 16-F): every employee's trace and the owner's own
 * rows, assembled through the paged actions into the one file `metrics:recompute` reads.
 *
 * @param run - How a deployed function is called.
 * @param subject - The caller's subject, the no-auth one a local bed runs as by default.
 * @returns The whole file.
 */
export async function exportOwner(
  run: ConvexRun,
  subject: string = DEV_NO_AUTH_SUBJECT,
): Promise<OwnerExport> {
  return await assembleOwnerExport({
    head: async () => (await run('exportActions:exportForOwner', {}, subject)) as OwnerExportHead,
    agents: async (cursor) =>
      (await run('exportActions:exportOwnerAgents', { cursor }, subject)) as OwnerAgentsPage,
    page: async (cursor) =>
      (await run('exportActions:exportOwnerPage', { ...cursor }, subject)) as OwnerPage,
    employee: {
      head: async ({ agentId }) =>
        (await run('exportActions:exportForAgent', { agentId }, subject)) as TraceHead,
      page: async ({ agentId, page }) =>
        (await run(
          'exportActions:exportPage',
          { agentId, section: page.section, cursor: page.cursor },
          subject,
        )) as TracePage,
    },
  });
}

function parseArguments(
  argv: readonly string[],
): { agentId: string | 'owner'; out: string; subject: string } | undefined {
  let agentId: string | undefined;
  let out: string | undefined;
  let subject = DEV_NO_AUTH_SUBJECT;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--owner') {
      if (agentId !== undefined) return undefined;
      agentId = 'owner';
    } else if (argument === '--out' || argument === '--identity') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) return undefined;
      if (argument === '--out') out = value;
      else subject = value;
      index += 1;
    } else if (argument.startsWith('--') || agentId !== undefined) {
      return undefined;
    } else {
      agentId = argument;
    }
  }
  return agentId === undefined || out === undefined ? undefined : { agentId, out, subject };
}

/**
 * Run the command line.
 *
 *
 * @param argv - The arguments after the script's own path.
 * @param io - Where the summary (`log`) and refusals (`error`) go.
 * @param run - How a deployed function is called; `npx convex run` unless a test passes another.
 * @returns The exit code: 0 written, 2 usage or a refused call.
 */
export async function runExportTrace(
  argv: readonly string[],
  io: Io = console,
  run: ConvexRun = npxConvexRun,
): Promise<number> {
  const options = parseArguments(argv);
  if (!options) {
    io.error(USAGE);
    return 2;
  }
  if (options.agentId === 'owner') {
    let file: OwnerExport;
    try {
      file = await exportOwner(run, options.subject);
    } catch (error) {
      io.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    writeFileSync(options.out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    const { manifest } = file;
    io.log(
      `${options.out}: the owner export, exported ${manifest.exportedOn} (${manifest.zone}) at release ${manifest.release ?? 'unstamped'}, commit ${manifest.commit ?? 'unknown'}; ${Object.entries(
        manifest.counts,
      )
        .map(([section, count]) => `${count} ${section}`)
        .join(', ')}`,
    );
    return 0;
  }
  let trace: AgentTrace;
  try {
    trace = await exportTrace(options.agentId, run, options.subject);
  } catch (error) {
    io.error(`Export failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  writeFileSync(options.out, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  const { manifest } = trace;
  io.log(
    `${options.out}: ${trace.agent.name}, exported ${manifest.exportedOn} (${manifest.zone}) at release ${manifest.release ?? 'unstamped'}, commit ${manifest.commit ?? 'unknown'}; ${Object.entries(
      manifest.counts,
    )
      .map(([section, count]) => `${count} ${section}`)
      .join(', ')}`,
  );
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runExportTrace(process.argv.slice(2));
}
