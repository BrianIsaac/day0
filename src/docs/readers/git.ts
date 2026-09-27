import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import {
  configuredPrivateHosts,
  isPrivateHostAllowed,
  type PrivateHostAllowlist,
} from '../../lib/private-hosts';
import type { DocPage, DocPageBatch, DocSourceReader, DocSourceRecord } from '../types';
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
 * Args:
 *   url: Provider archive URL.
 *
 * Returns:
 *   Tar-gzip bytes.
 *
 * Raises:
 *   Error: If the response fails or exceeds the size limit.
 */
async function downloadArchive(url: URL): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Git archive returned HTTP ${response.status}.`);
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > MAX_ARCHIVE_BYTES) throw new Error('Git archive exceeds 25 MiB.');
  const archive = Buffer.from(await response.arrayBuffer());
  if (archive.length > MAX_ARCHIVE_BYTES) throw new Error('Git archive exceeds 25 MiB.');
  return archive;
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
export class GitReader implements DocSourceReader {
  /**
   * Read a bounded Markdown batch from an isolated checkout.
   *
   * Args:
   *   source: Linked git source.
   *   _secret: Unused because public repositories need no credential.
   *   cursor: Optional decimal file offset.
   *   limit: Maximum pages to read.
   *
   * Returns:
   *   Bounded page batch and continuation cursor.
   */
  async listPageBatch(
    source: DocSourceRecord,
    _secret: string | undefined,
    cursor: string | undefined,
    limit: number,
  ): Promise<DocPageBatch> {
    void _secret;
    return await this.withCheckout(
      source,
      async (checkout: string): Promise<DocPageBatch> =>
        await readMarkdownDirectoryBatch(source, checkout, cursor, limit),
    );
  }

  /**
   * Read Markdown from a shallow checkout or bounded provider archive.
   *
   * Args:
   *   source: Linked git source.
   *   _secret: Unused because Phase 1 supports public repositories only.
   *
   * Returns:
   *   Normalised Markdown pages.
   */
  async listPages(source: DocSourceRecord, _secret?: string): Promise<DocPage[]> {
    void _secret;
    return await this.withCheckout(
      source,
      async (checkout: string): Promise<DocPage[]> => await readMarkdownDirectory(source, checkout),
    );
  }

  /**
   * Prepare one temporary checkout and remove it after the read completes.
   *
   * Args:
   *   source: Linked git source.
   *   read: Operation to perform against the checkout directory.
   *
   * Returns:
   *   Reader result.
   */
  private async withCheckout<T>(
    source: DocSourceRecord,
    read: (checkout: string) => Promise<T>,
  ): Promise<T> {
    const locator = parseGitLocator(source.locator);
    const temporary = await mkdtemp(join(tmpdir(), 'day0-docs-git-'));
    const checkout = join(temporary, 'checkout');
    try {
      const cloned = spawnSync(
        'git',
        ['clone', '--depth', '1', '--branch', locator.ref, '--', locator.url.href, checkout],
        // A repository that wants credentials fails at once rather than waiting on a prompt.
        { encoding: 'utf8', timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
      );
      if (cloned.status !== 0) {
        if (!ARCHIVE_HOSTS.includes(locator.url.hostname)) {
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
