/**
 * What the cloud verbs read out of the tools they run: the Convex CLI's push
 * lines and table listing, the Vercel CLI's deployment summary and env
 * listing, a snapshot export's members, and the two public pages the app
 * serves. Each reader is a pure function of the text a tool printed, so the
 * verbs in `scripts/setup-cloud.ts` can be tested against recorded output and
 * a reader that no longer recognises a tool's words fails closed: it returns
 * nothing, and the verb refuses rather than guessing.
 *
 * The shapes were read off the runs that moved the hosted demo onto the
 * production deployment (30 September 2026, Convex CLI 1.38.0, Vercel CLI
 * 50.22.1) and off the Vercel CLI's own source for `env ls --format json`.
 */

/** A Convex cloud deployment's generated name, as the dashboard and the CLI print it. */
export const DEPLOYMENT_NAME_PATTERN = /^[a-z]+-[a-z]+-\d+$/;

/**
 * The address the app's client and server dial.
 *
 * @param name - The deployment's name.
 */
export function deploymentUrl(name: string): string {
  return `https://${name}.convex.cloud`;
}

/**
 * The address the deployment's HTTP actions answer on.
 *
 * @param name - The deployment's name.
 */
export function deploymentSiteUrl(name: string): string {
  return `https://${name}.convex.site`;
}

/**
 * A tool's output without its terminal colour codes.
 *
 * @param text - What the tool printed.
 */
export function plainText(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * The deployment a `npx convex deploy` names: the one its dry run would push
 * to, or the one its push reached.
 *
 * @param output - Both streams of the CLI's output.
 * @param phase - `dry-run` reads "Deploying to ... [dry run]"; `push` reads
 *   "Deployed Convex functions to ...".
 *
 * @returns The deployment's name, or undefined when the output names none.
 */
export function pushTarget(output: string, phase: 'dry-run' | 'push'): string | undefined {
  const pattern =
    phase === 'dry-run'
      ? /Deploying to https:\/\/([a-z0-9-]+)\.convex\.cloud\.\.\. \[dry run\]/
      : /Deployed Convex functions to https:\/\/([a-z0-9-]+)\.convex\.cloud/;
  return pattern.exec(plainText(output))?.[1];
}

/**
 * The tables `npx convex data` lists, one per line; a deployment nothing was
 * ever pushed to lists none.
 *
 * @param stdout - The CLI's standard output.
 */
export function listedTables(stdout: string): string[] {
  return plainText(stdout)
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(line));
}

/**
 * The names `npx convex env list` prints, each with its value unquoted as
 * the CLI's dotenv lines quote it. The values stay in memory: nothing here
 * prints them.
 *
 * @param stdout - The CLI's standard output.
 */
export function deploymentEnv(stdout: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const line of plainText(stdout).split('\n')) {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (match) values.set(match[1]!, unquoted(match[2]!));
  }
  return values;
}

/**
 * A dotenv value without the quotes the CLI put around it.
 *
 * @param value - The text after `=`.
 */
function unquoted(value: string): string {
  const quoted = /^(['"`])([\s\S]*)\1$/.exec(value);
  if (!quoted) return value;
  return quoted[1] === '"' ? quoted[2]!.replace(/\\n/g, '\n') : quoted[2]!;
}

/** A Vercel deployment, as `vercel inspect` summarises it. */
export interface VercelDeployment {
  /** The deployment's id, `dpl_...`, which `vercel promote` takes. */
  readonly id: string;
  /** The Vercel project it belongs to. */
  readonly name: string | undefined;
  /** `production` for a production deployment. */
  readonly target: string | undefined;
  /** Whether its status reads Ready. */
  readonly ready: boolean;
  /** Its own URL. */
  readonly url: string | undefined;
  /** The domains aliased to it. */
  readonly aliases: readonly string[];
}

/**
 * The deployment `vercel inspect <url>` describes, from its text summary.
 *
 * @param output - Both streams of the CLI's output.
 *
 * @returns The deployment, or undefined when the output carries no id.
 */
export function parseVercelInspect(output: string): VercelDeployment | undefined {
  const text = plainText(output);
  const field = (name: string): string | undefined =>
    new RegExp(`^\\s*${name}\\s+(.+?)\\s*$`, 'm').exec(text)?.[1];
  const id = field('id');
  if (id === undefined || !/^dpl_[A-Za-z0-9]+$/.test(id)) return undefined;
  const aliasesAt = text.search(/^\s*Aliases\s*$/m);
  const aliases =
    aliasesAt < 0
      ? []
      : [
          ...text
            .slice(aliasesAt)
            .split(/^\s*Builds\s*$/m)[0]!
            .matchAll(/(https:\/\/[^\s]+)/g),
        ].map((match) => match[1]!);
  return {
    id,
    name: field('name'),
    target: field('target'),
    ready: /\bReady\b/.test(field('status') ?? ''),
    url: field('url'),
    aliases,
  };
}

/**
 * The framework preset `vercel project inspect` names under its Framework
 * Settings: `Next.js`, `Other` and the rest, by the name the dashboard shows.
 *
 * @param output - The command's output, stdout and stderr together.
 * @returns The preset's name, or undefined when the output names none.
 */
export function parseFrameworkPreset(output: string): string | undefined {
  const preset = /^\s*Framework Preset\s+(.+?)\s*$/m.exec(plainText(output))?.[1];
  // The CLI prints `undefined` for a preset slug its framework list lacks.
  return preset === undefined || preset === 'undefined' ? undefined : preset;
}

/**
 * When each variable a Vercel environment holds was last written, by name,
 * from `vercel env ls <environment> --format json`. The listing returns a
 * value only for a plain variable, and this reads none.
 *
 * @param stdout - The CLI's standard output.
 * @param environment - The environment the names must target.
 *
 * @returns Each name's last write in milliseconds, or undefined when the output is not the listing.
 */
export function vercelEnvNames(
  stdout: string,
  environment: string,
): Map<string, number> | undefined {
  const start = stdout.indexOf('{');
  if (start < 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    // Not the JSON listing: the caller refuses on undefined.
    return undefined;
  }
  const envs = (parsed as { envs?: unknown }).envs;
  if (!Array.isArray(envs)) return undefined;
  const names = new Map<string, number>();
  for (const entry of envs as readonly unknown[]) {
    const { key, target, updatedAt, createdAt } = (entry ?? {}) as {
      key?: unknown;
      target?: unknown;
      updatedAt?: unknown;
      createdAt?: unknown;
    };
    if (typeof key !== 'string') continue;
    const targets = Array.isArray(target) ? target : [target];
    if (!targets.includes(environment)) continue;
    const at = typeof updatedAt === 'number' ? updatedAt : createdAt;
    names.set(key, typeof at === 'number' ? at : 0);
  }
  return names;
}

/**
 * The production URL `vercel --prod` reports for the deployment it made.
 *
 * @param output - Both streams of the CLI's output.
 */
export function deployedAppUrl(output: string): string | undefined {
  const text = plainText(output);
  return (
    /Production:\s+(https:\/\/[^\s[\]]+)/.exec(text)?.[1] ??
    [...text.matchAll(/(https:\/\/[a-z0-9-]+\.vercel\.app)\b/g)].at(-1)?.[1]
  );
}

/**
 * Whether the `/setup` page says the deployment behind it is at a release.
 *
 * @param html - The page as served.
 * @param release - The release, without its `v`.
 */
export function pageNamesRelease(html: string, release: string): boolean {
  return html.includes(`The deployment behind this page has been at v${release} since `);
}

/**
 * The client chunks a page loads, as paths on the app's own origin.
 *
 * @param html - The page as served.
 */
export function clientChunkPaths(html: string): string[] {
  const found = [...html.matchAll(/["'](\/_next\/static\/[^"'?#\s]+\.js)["']/g)].map(
    (match) => match[1]!,
  );
  return [...new Set(found)];
}

/** The tables a snapshot export holds, from `unzip -Z1`, and whether it carries stored files. */
export interface ExportLayout {
  /** Every table with a `documents.jsonl`, `_storage` apart, sorted. */
  readonly tables: readonly string[];
  /** Whether `_storage/documents.jsonl` is present. */
  readonly storage: boolean;
}

/**
 * The layout of a snapshot export, from its member listing.
 *
 * @param listing - What `unzip -Z1 <zip>` printed.
 */
export function exportLayout(listing: string): ExportLayout {
  const tables = new Set<string>();
  let storage = false;
  for (const line of listing.split('\n')) {
    const match = /^([A-Za-z0-9_]+)\/documents\.jsonl$/.exec(line.trim());
    if (!match) continue;
    if (match[1] === '_storage') storage = true;
    else if (!match[1]!.startsWith('_')) tables.add(match[1]!);
  }
  return { tables: [...tables].sort(), storage };
}

/**
 * How many rows a `documents.jsonl` holds: one per non-empty line.
 *
 * @param documents - The member's text.
 */
export function rowCount(documents: string): number {
  return documents.split('\n').filter((line) => line.trim() !== '').length;
}

/** The row counts of an export, table by table. */
export interface ExportCounts {
  readonly tables: readonly (readonly [string, number])[];
  readonly storedFiles: number;
}

/**
 * The counts beside an export, in the form the redeploy handovers record:
 * `<table> <rows>` per line, then `TOTAL <rows> tables <n> stored_files <n>`.
 *
 * @param counts - The export's counts.
 */
export function countsText(counts: ExportCounts): string {
  const total = counts.tables.reduce((sum, [, rows]) => sum + rows, 0);
  return [
    ...counts.tables.map(([table, rows]) => `${table} ${rows}`),
    `TOTAL ${total} tables ${counts.tables.length} stored_files ${counts.storedFiles}`,
    '',
  ].join('\n');
}
