/**
 * The app half of the cloud verbs, on Vercel: the build that serves
 * production now, the production env's names, the app's three Convex values
 * set through stdin, the deploy, and the read-back of the served app, which
 * is the one place the values Vercel encrypts can be seen to be right: the
 * client inlines the deployment's address and `/setup` states its release.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { firstLine, tail, type CloudIo, type CloudTarget, type Failure } from './checkout';
import {
  clientChunkPaths,
  deployedAppUrl,
  deploymentSiteUrl,
  deploymentUrl,
  pageNamesRelease,
  parseVercelInspect,
  vercelEnvNames,
  type VercelDeployment,
} from './outputs';

/**
 * The Vercel CLI's arguments with the team, when one is named.
 *
 * @param target - The target, for its scope.
 * @param args - The command.
 */
export function vercelArgs(target: CloudTarget, args: readonly string[]): string[] {
  return target.scope === undefined ? [...args] : [...args, '--scope', target.scope];
}

/**
 * Which deployment an app address is served by.
 *
 * @param io - The machine.
 * @param target - The target, for its scope.
 * @param url - The address.
 */
export function inspectApp(
  io: CloudIo,
  target: CloudTarget,
  url: string,
): VercelDeployment | Failure {
  const inspected = io.run('vercel', vercelArgs(target, ['inspect', url]), { timeoutMs: 120_000 });
  const deployment = parseVercelInspect(`${inspected.stdout}\n${inspected.stderr}`);
  if (inspected.status !== 0 || deployment === undefined) {
    return {
      failure: `\`vercel inspect ${url}\` named no deployment (exit ${inspected.status ?? 'unknown'}: ${firstLine(inspected.stderr) || firstLine(inspected.stdout)})`,
    };
  }
  return deployment;
}

/**
 * The project the checkout is linked to, as `vercel link` wrote it.
 *
 * @param io - The machine.
 */
export function linkedProject(io: CloudIo): string | undefined {
  try {
    const link = JSON.parse(readFileSync(join(io.cwd, '.vercel', 'project.json'), 'utf8')) as {
      projectName?: unknown;
    };
    return typeof link.projectName === 'string' ? link.projectName : undefined;
  } catch {
    // No link, or not the link's shape: the caller refuses on undefined.
    return undefined;
  }
}

/**
 * Why the app's address is not served by the project this checkout is
 * linked to, whose env and production the Vercel writes change, or
 * undefined when it is.
 *
 * @param io - The machine.
 * @param served - The build serving the app's address.
 * @param appUrl - That address.
 */
export function projectRefusal(
  io: CloudIo,
  served: VercelDeployment,
  appUrl: string,
): Failure | undefined {
  const linked = linkedProject(io);
  if (linked !== undefined && served.name === linked) return undefined;
  return {
    failure: `${appUrl} is served by the Vercel project ${served.name ?? '(unnamed)'}, and this checkout is linked to ${linked ?? 'a project whose name .vercel/project.json does not give'}; the writes would reach the linked one. Link the project that serves it: vercel link.`,
  };
}

/**
 * When each production variable of the linked Vercel project was last written.
 *
 * @param io - The machine.
 * @param target - The target, for its scope.
 */
export function readAppEnv(io: CloudIo, target: CloudTarget): Map<string, number> | Failure {
  const listed = io.run(
    'vercel',
    vercelArgs(target, ['env', 'ls', 'production', '--format', 'json']),
    { timeoutMs: 120_000 },
  );
  const names = listed.status === 0 ? vercelEnvNames(listed.stdout, 'production') : undefined;
  if (names === undefined) {
    return {
      failure: `the Vercel project's production env could not be listed (exit ${listed.status ?? 'unknown'}: ${firstLine(listed.stderr)})`,
    };
  }
  return names;
}

/** The three values the app reads to find its Convex deployment. */
export function appConvexValues(deployment: string): ReadonlyMap<string, string> {
  return new Map([
    ['NEXT_PUBLIC_CONVEX_URL', deploymentUrl(deployment)],
    ['NEXT_PUBLIC_CONVEX_SITE_URL', deploymentSiteUrl(deployment)],
    ['CONVEX_DEPLOYMENT', `prod:${deployment}`],
  ]);
}

/** The app keys a Clerk deployment's app host needs before the app can sign anyone in. */
export const CLERK_APP_KEYS: readonly string[] = [
  'NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY',
  'CLERK_SECRET_KEY',
];

/** The user agent the public read-backs send, so the host's logs say what asked. */
const READ_BACK_AGENT = 'Mozilla/5.0 (compatible; day0-setup-cloud read-back)';

/**
 * Fetch a public page of the app.
 *
 * @param io - The machine.
 * @param url - The page.
 *
 * @returns Its body when it answers 200, else why not.
 */
export function fetchPage(io: CloudIo, url: string): { readonly body: string } | Failure {
  const fetched = io.run(
    'curl',
    ['-sS', '-L', '--max-time', '30', '-A', READ_BACK_AGENT, '-w', '\n%{http_code}', url],
    { timeoutMs: 60_000 },
  );
  const cut = fetched.stdout.lastIndexOf('\n');
  const code = fetched.stdout.slice(cut + 1).trim();
  if (fetched.status !== 0 || code !== '200') {
    return { failure: `${url} answered ${code || `nothing (${firstLine(fetched.stderr)})`}` };
  }
  return { body: fetched.stdout.slice(0, Math.max(cut, 0)) };
}

/** The most client chunks read looking for the deployment's address. */
const CHUNKS_READ = 60;

/**
 * Whether the app at an address talks to the deployment: one of the client
 * chunks its home page loads inlines the deployment's URL, which Next writes
 * in at build time from `NEXT_PUBLIC_CONVEX_URL`.
 *
 * @param io - The machine.
 * @param appUrl - The app's production address.
 * @param deployment - The deployment.
 */
export function appTalksTo(
  io: CloudIo,
  appUrl: string,
  deployment: string,
): { readonly talks: boolean } | Failure {
  const home = fetchPage(io, `${appUrl}/`);
  if ('failure' in home) return home;
  const address = deploymentUrl(deployment);
  if (home.body.includes(address)) return { talks: true };
  for (const path of clientChunkPaths(home.body).slice(0, CHUNKS_READ)) {
    const chunk = fetchPage(io, `${appUrl}${path}`);
    if ('failure' in chunk) return chunk;
    if (chunk.body.includes(address)) return { talks: true };
  }
  return { talks: false };
}

/**
 * Read the app back after a deploy: the address is served by the new build,
 * the build talks to the deployment, and `/setup` states the stamped release.
 *
 * @param io - The machine.
 * @param target - The target.
 * @param appUrl - The app's production address.
 * @param before - The build that served it before, which must have been replaced.
 * @param release - The release just stamped.
 */
export function readAppBack(
  io: CloudIo,
  target: CloudTarget,
  appUrl: string,
  before: VercelDeployment | undefined,
  release: string,
): VercelDeployment | Failure {
  const after = inspectApp(io, target, appUrl);
  if ('failure' in after) return after;
  if (!after.ready || after.target !== 'production' || after.id === before?.id) {
    return {
      failure: `${appUrl} is served by ${after.id} (${after.target ?? 'no target'}, ${after.ready ? 'ready' : 'not ready'}), not a new production build`,
    };
  }
  const talks = appTalksTo(io, appUrl, target.deployment);
  if ('failure' in talks) return talks;
  if (!talks.talks) {
    return {
      failure: `no client chunk ${appUrl} serves names ${deploymentUrl(target.deployment)}, so the app does not talk to the deployment`,
    };
  }
  const setup = fetchPage(io, `${appUrl}/setup`);
  if ('failure' in setup) return setup;
  if (!pageNamesRelease(setup.body, release)) {
    return { failure: `${appUrl}/setup does not say the deployment behind it is at v${release}` };
  }
  io.log(
    `Read back: ${appUrl} is ${after.id}, its client talks to ${target.deployment}, and /setup says v${release}.`,
  );
  return after;
}

/**
 * Deploy the app to production and say which address serves it.
 *
 * @param io - The machine.
 * @param target - The target, for its scope and address.
 */
export function deployApp(io: CloudIo, target: CloudTarget): { readonly url: string } | Failure {
  io.log(
    'Deploying the app to Vercel production (a few minutes; the output follows on a failure).',
  );
  const deployed = io.run('vercel', vercelArgs(target, ['--prod', '--yes']), {
    timeoutMs: 1_800_000,
  });
  const url = deployedAppUrl(`${deployed.stdout}\n${deployed.stderr}`);
  if (deployed.status !== 0 || url === undefined) {
    return {
      failure: [
        `\`vercel --prod\` did not finish a production deployment (exit ${deployed.status ?? 'unknown'}); its last lines:`,
        ...tail(deployed),
      ].join('\n'),
    };
  }
  return { url };
}

/**
 * Set the app's three Convex values on Vercel production, each through
 * stdin with `--yes`, and read the listing back to see each one written.
 *
 * @param io - The machine.
 * @param target - The target.
 * @param before - When each production name was last written, before.
 */
export function setAppValues(
  io: CloudIo,
  target: CloudTarget,
  before: ReadonlyMap<string, number>,
): Failure | undefined {
  for (const [name, value] of appConvexValues(target.deployment)) {
    const verb = before.has(name) ? 'update' : 'add';
    const set = io.run('vercel', vercelArgs(target, ['env', verb, name, 'production', '--yes']), {
      input: value,
      timeoutMs: 120_000,
    });
    if (set.status !== 0) {
      return {
        failure: `\`vercel env ${verb} ${name} production\` failed (exit ${set.status ?? 'unknown'}: ${firstLine(set.stderr)})`,
      };
    }
  }
  const after = readAppEnv(io, target);
  if ('failure' in after) return after;
  const unwritten = [...appConvexValues(target.deployment).keys()].filter(
    (name) => !after.has(name) || (before.has(name) && after.get(name)! <= before.get(name)!),
  );
  if (unwritten.length > 0) {
    return {
      failure: `Vercel's listing does not show ${unwritten.join(', ')} written by this run`,
    };
  }
  io.log(
    `Set on Vercel production and read back: NEXT_PUBLIC_CONVEX_URL=${deploymentUrl(target.deployment)}, ` +
      `NEXT_PUBLIC_CONVEX_SITE_URL=${deploymentSiteUrl(target.deployment)}, CONVEX_DEPLOYMENT=prod:${target.deployment}.`,
  );
  return undefined;
}

/**
 * Print the step for an app host this command does not drive.
 *
 * @param io - The machine.
 * @param target - The target.
 */
export function otherHostLines(io: CloudIo, target: CloudTarget): void {
  io.log('The app is yours to deploy (--app none). Set these three on its host, then build it:');
  for (const [name, value] of appConvexValues(target.deployment)) io.log(`  ${name}=${value}`);
  io.log(
    '  The client inlines NEXT_PUBLIC_CONVEX_URL at build time, so build after setting it; the ' +
      "app's own keys (Clerk's, the model's for the chat route) are set there too.",
  );
}
