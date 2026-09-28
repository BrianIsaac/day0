import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { fetchWithBackoff, PROVIDER_BACKOFF, type BackoffPolicy } from '../../lib/transport-error';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isIP } from 'node:net';
import { basename, join } from 'node:path';
import { isDiallablePrivateAddress } from '../../lib/network-addresses';
import {
  configuredPrivateHosts,
  isPrivateHostAllowed,
  type PrivateHostAllowlist,
} from '../../lib/private-hosts';
import { resolveHostname, type HostResolver } from '../../surfaces/mcp-address';
import type { DocPage, DocSourceRecord } from '../types';
import type { DocumentationReader, ReadPageBatch } from './batch';
import { readMarkdownDirectory, readMarkdownDirectoryBatch } from './folder';

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export interface GitLocator {
  url: URL;
  ref: string;
}

/** The public hosts whose archives are read when the backend cannot clone. */
const ARCHIVE_HOSTS = ['github.com', 'gitlab.com'];

/**
 * Parse the documented `<repository>#<ref>` source format.
 *
 * A locator never carries credentials: the reader reads public repositories
 * only, and a user name or token in the URL would be stored on the source row
 * and shown back on the page. It is refused, and no refusal repeats the
 * locator. A repository on a host inside the operator's network is read once
 * that host is listed in `DAY0_PRIVATE_HOSTS`.
 *
 * @param locator - Repository locator supplied by the owner.
 * @param privateHosts - Hosts inside the operator's network; the environment's by default.
 * @returns HTTPS repository URL and requested ref.
 * @throws Error when the locator is not an HTTPS URL, carries credentials, or names an unsupported host.
 */
export function parseGitLocator(
  locator: string,
  privateHosts: PrivateHostAllowlist = configuredPrivateHosts(),
): GitLocator {
  const separator = locator.lastIndexOf('#');
  const rawUrl = separator === -1 ? locator : locator.slice(0, separator);
  const ref = separator === -1 ? 'main' : locator.slice(separator + 1);
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Git documentation locator is not a URL.');
  }
  if (url.protocol !== 'https:') throw new Error('Git documentation URL must use HTTPS.');
  if (url.username !== '' || url.password !== '') {
    throw new Error(
      'Git documentation URL must not carry a user name or password; link a repository ' +
        'the backend can read without one.',
    );
  }
  if (!ARCHIVE_HOSTS.includes(url.hostname) && !isPrivateHostAllowed(url.hostname, privateHosts)) {
    throw new Error(
      'Git documentation supports GitHub and GitLab archive URLs, and repositories on hosts ' +
        'listed in DAY0_PRIVATE_HOSTS.',
    );
  }
  if (!ref.trim()) throw new Error('Git documentation ref cannot be empty.');
  return { url, ref };
}

/**
 * Build the provider archive URL used when the backend has no git binary.
 *
 * @param locator - Parsed repository and ref.
 * @returns HTTPS tar-gzip archive URL.
 * @throws Error for a host other than GitHub or GitLab, which publish no archive at a known path.
 */
export function archiveUrlFor(locator: GitLocator): URL {
  if (!ARCHIVE_HOSTS.includes(locator.url.hostname)) {
    throw new Error(`${locator.url.hostname} has no archive fallback; only a clone can read it.`);
  }
  const repositoryPath = locator.url.pathname
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
    .replace(/^\//, '');
  const encodedRef = locator.ref.split('/').map(encodeURIComponent).join('/');
  if (locator.url.hostname === 'github.com') {
    return new URL(`https://github.com/${repositoryPath}/archive/refs/heads/${encodedRef}.tar.gz`);
  }
  const repository = basename(repositoryPath);
  return new URL(
    `https://gitlab.com/${repositoryPath}/-/archive/${encodedRef}/${repository}-${encodedRef.replaceAll('/', '-')}.tar.gz`,
  );
}

/**
 * Download one bounded repository archive.
 *
 * A rate limit or a server error is tried again under the provider backoff.
 *
 * Args:
 *   url: Provider archive URL.
 *   backoff: How a rate-limited or failed download is tried again.
 *
 * Returns:
 *   Tar-gzip bytes.
 *
 * Raises:
 *   Error: If the response fails or exceeds the size limit.
 */
export async function downloadArchive(
  url: URL,
  backoff: BackoffPolicy = PROVIDER_BACKOFF,
): Promise<Buffer> {
  const read = fetchWithBackoff(
    (input: URL, init?: RequestInit): Promise<Response> => fetch(input, init),
    30_000,
    backoff,
  );
  const response = await read(url);
  if (!response.ok) throw new Error(`Git archive returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('Git archive exceeds 25 MiB.');
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Git archive exceeds 25 MiB.');
  return archive;
}

/** The first git release that honours `http.curloptResolve`; an older one ignores it without a word. */
const pinningGit = { major: 2, minor: 37 } as const;

/** The first git release that reads configuration from `GIT_CONFIG_COUNT`, which carries a secret off the command line. */
const environmentConfigGit = { major: 2, minor: 31 } as const;

/** Whether a `git --version` line is at least a release. */
function gitAtLeast(version: string, release: { major: number; minor: number }): boolean {
  const match = /git version (\d+)\.(\d+)/.exec(version);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > release.major || (major === release.major && minor >= release.minor);
}

/**
 * The authorization header a repository's reader secret is sent as (E-74).
 *
 * A secret that already names its scheme (`Bearer ...`, `Basic ...`) is sent
 * as written, as a URL source's is. An access token alone goes as the
 * password of HTTP Basic under a placeholder user, which GitHub and GitLab
 * both accept; a host that needs the user name takes the secret as `user:token`.
 *
 * @param secret - The source's reader secret.
 */
export function gitAuthorization(secret: string): string {
  if (/^(?:basic|bearer) \S+$/i.test(secret)) return secret;
  const pair = secret.includes(':') ? secret : `x-access-token:${secret}`;
  return `Basic ${Buffer.from(pair, 'utf8').toString('base64')}`;
}

/**
 * Whether the git that printed this `git --version` line pins the address it
 * dials when told to.
 *
 * @param version - The line, for example `git version 2.43.0`.
 */
export function gitPinsResolve(version: string): boolean {
  return gitAtLeast(version, pinningGit);
}

/**
 * The `git` arguments that clone one locator into a checkout directory.
 *
 * GitHub and GitLab are cloned by name. A host the operator listed in
 * `DAY0_PRIVATE_HOSTS` is resolved once, every answer is checked the way a
 * listed MCP server's are (never loopback, link-local, multicast or
 * unspecified), and git is told to dial only the first checked answer and to
 * follow no redirect, so neither a later DNS answer nor a 302 to a metadata
 * address reaches past the check.
 *
 * A clone that carries a reader secret follows no redirect on any host, so
 * the secret's header never reaches another one.
 *
 * @param locator - The parsed repository and ref.
 * @param checkout - The directory to clone into.
 * @param resolve - The resolver; the system's by default.
 * @param withSecret - Whether the clone carries the source's reader secret.
 * @returns The arguments after `git`.
 * @throws Error naming the host when it does not resolve or answers with an address day0 never dials.
 */
export async function cloneArguments(
  locator: GitLocator,
  checkout: string,
  resolve: HostResolver = resolveHostname,
  withSecret = false,
): Promise<string[]> {
  const clone = [
    'clone',
    '--depth',
    '1',
    '--branch',
    locator.ref,
    '--',
    locator.url.href,
    checkout,
  ];
  if (ARCHIVE_HOSTS.includes(locator.url.hostname)) {
    return withSecret ? ['-c', 'http.followRedirects=false', ...clone] : clone;
  }
  const host = locator.url.hostname.replace(/^\[|\]$/g, '');
  let addresses: string[];
  if (isIP(host) !== 0) {
    addresses = [host];
  } else {
    try {
      addresses = await resolve(host);
    } catch (error) {
      throw new Error(`The git host ${host} did not resolve.`, { cause: error });
    }
  }
  if (addresses.length === 0 || !addresses.every(isDiallablePrivateAddress)) {
    throw new Error(
      `The git host ${host} answers with an address day0 never dials (loopback, link-local, ` +
        'multicast or unspecified), listed or not.',
    );
  }
  const pinned = isIP(addresses[0]) === 6 ? `[${addresses[0]}]` : addresses[0];
  const port = locator.url.port || '443';
  return [
    '-c',
    'http.followRedirects=false',
    ...(isIP(host) === 0 ? ['-c', `http.curloptResolve=${host}:${port}:${pinned}`] : []),
    ...clone,
  ];
}

/** The proxy variables curl reads, which would dial a listed host by name past the pin. */
const PROXY_VARIABLES = [
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
] as const;

/**
 * The environment a clone runs in. A listed host is dialled at the pinned
 * address only: no proxy (which would resolve the name itself) and no LFS
 * download (whose server `.lfsconfig` may name). Markdown needs neither.
 *
 * A reader secret travels as an `http.extraHeader` in the environment
 * (`GIT_CONFIG_COUNT`), never in the arguments, which any process on the
 * machine can list, nor in the remote URL git would store (E-74). It is
 * scoped to the repository's own origin, and a clone that carries one
 * fetches no LFS object, whose server a `.lfsconfig` may name.
 *
 * @param archived - Whether the host is GitHub or GitLab, cloned as before.
 * @param authorization - The reader secret's header and the origin it is for, when the source has one.
 */
export function cloneEnvironment(
  archived: boolean,
  authorization?: { readonly origin: string; readonly header: string },
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: '0',
    ...(authorization === undefined
      ? {}
      : {
          GIT_CONFIG_COUNT: '1',
          GIT_CONFIG_KEY_0: `http.${authorization.origin}/.extraHeader`,
          GIT_CONFIG_VALUE_0: `Authorization: ${authorization.header}`,
          GIT_LFS_SKIP_SMUDGE: '1',
        }),
  };
  if (archived) return environment;
  for (const name of PROXY_VARIABLES) delete environment[name];
  return { ...environment, GIT_LFS_SKIP_SMUDGE: '1' };
}

/**
 * Why a clone from a host with no archive fallback failed, in the words the
 * source's status shows: the backend having no git binary is said as such.
 *
 * @param hostname - The repository's host.
 * @param cloned - The finished `git clone`.
 */
export function cloneFailure(
  hostname: string,
  cloned: Pick<SpawnSyncReturns<string>, 'error' | 'stderr'>,
): string {
  if ((cloned.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') {
    return (
      `The backend has no git binary, so the repository on ${hostname} cannot be cloned; ` +
      'only GitHub and GitLab have an archive fallback.'
    );
  }
  const reason = (cloned.error?.message ?? cloned.stderr ?? '').trim().split('\n').pop();
  return `Git clone from ${hostname} failed${reason ? `: ${reason}` : ''}.`;
}

/** Reader for public GitHub and GitLab Markdown repositories, and repositories on listed private hosts. */
export class GitReader implements DocumentationReader {
  private readonly resolve: HostResolver;

  /** @param resolve - Resolves a listed host's name; the system's resolver by default. */
  constructor(resolve: HostResolver = resolveHostname) {
    this.resolve = resolve;
  }

  /**
   * Read a bounded Markdown batch from an isolated checkout.
   *
   * Args:
   *   source: Linked git source.
   *   secret: The source's own reader secret, when the repository is private.
   *   cursor: Optional decimal file offset.
   *   limit: Maximum pages to read.
   *
   * Returns:
   *   Bounded page batch and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<ReadPageBatch> {
    return await this.withCheckout(
      source,
      secret,
      async (checkout: string): Promise<ReadPageBatch> =>
        await readMarkdownDirectoryBatch(source, checkout, cursor, limit),
    );
  }

  /**
   * Read Markdown from a shallow checkout or bounded provider archive.
   *
   * Args:
   *   source: Linked git source.
   *   secret: The source's own reader secret, if any.
   *
   * Returns:
   *   Normalised Markdown pages.
   */
  async listPages(source: DocSourceRecord, secret?: string): Promise<DocPage[]> {
    return await this.withCheckout(
      source,
      secret,
      async (checkout: string): Promise<DocPage[]> => await readMarkdownDirectory(source, checkout),
    );
  }

  /**
   * Prepare one temporary checkout and remove it after the read completes.
   *
   * A repository read with a secret is cloned only: the public archive
   * fallback cannot carry it, and a private repository has no public archive.
   *
   * Args:
   *   source: Linked git source.
   *   secret: The source's own reader secret, if any.
   *   read: Operation to perform against the checkout directory.
   *
   * Returns:
   *   Reader result.
   */
  private async withCheckout<T>(
    source: DocSourceRecord,
    secret: string | undefined,
    read: (checkout: string) => Promise<T>,
  ): Promise<T> {
    const locator = parseGitLocator(source.locator);
    const archived = ARCHIVE_HOSTS.includes(locator.url.hostname);
    if (!archived || secret !== undefined) {
      const version = spawnSync('git', ['--version'], { encoding: 'utf8', timeout: 10_000 });
      if (version.error || version.status !== 0) {
        throw new Error(cloneFailure(locator.url.hostname, version));
      }
      if (!archived && !gitPinsResolve(version.stdout)) {
        throw new Error(
          `The backend's ${version.stdout.trim()} cannot pin the address it dials (git 2.37 or ` +
            `later can), so the repository on ${locator.url.hostname} is not cloned.`,
        );
      }
      if (secret !== undefined && !gitAtLeast(version.stdout, environmentConfigGit)) {
        throw new Error(
          `The backend's ${version.stdout.trim()} can take a secret only on its command line (git ` +
            `2.31 or later takes it from the environment), so the repository on ` +
            `${locator.url.hostname} is not cloned.`,
        );
      }
    }
    const withSecret = secret !== undefined;
    const temporary = await mkdtemp(join(tmpdir(), 'day0-docs-git-'));
    const checkout = join(temporary, 'checkout');
    try {
      const cloned = spawnSync(
        'git',
        await cloneArguments(locator, checkout, this.resolve, withSecret),
        // A repository that wants credentials fails at once rather than waiting on a prompt.
        {
          encoding: 'utf8',
          timeout: 30_000,
          env: cloneEnvironment(
            archived,
            withSecret
              ? { origin: locator.url.origin, header: gitAuthorization(secret) }
              : undefined,
          ),
        },
      );
      if (cloned.status !== 0) {
        if (!archived || withSecret) {
          throw new Error(cloneFailure(locator.url.hostname, cloned));
        }
        await rm(checkout, { recursive: true, force: true });
        await mkdir(checkout);
        const archivePath = join(temporary, 'source.tar.gz');
        await writeFile(archivePath, await downloadArchive(archiveUrlFor(locator)));
        const extracted = spawnSync(
          'tar',
          ['-xzf', archivePath, '-C', checkout, '--strip-components=1'],
          { encoding: 'utf8', timeout: 30_000 },
        );
        if (extracted.error || extracted.status !== 0) {
          throw new Error(
            `Git archive extraction failed: ${extracted.error?.message || extracted.stderr}`,
          );
        }
      }
      return await read(checkout);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
