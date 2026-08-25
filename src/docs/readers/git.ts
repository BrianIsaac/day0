import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { DocPage, DocSourceReader, DocSourceRecord } from '../types';
import { readMarkdownDirectory } from './folder';

const MAX_ARCHIVE_BYTES = 25 * 1024 * 1024;

export interface GitLocator {
  url: URL;
  ref: string;
}

/**
 * Parse the documented `<repository>#<ref>` source format.
 *
 * Args:
 *   locator: Repository locator supplied by the owner.
 *
 * Returns:
 *   HTTPS repository URL and requested ref.
 *
 * Raises:
 *   Error: If the repository host or protocol is unsupported.
 */
export function parseGitLocator(locator: string): GitLocator {
  const separator = locator.lastIndexOf('#');
  const rawUrl = separator === -1 ? locator : locator.slice(0, separator);
  const ref = separator === -1 ? 'main' : locator.slice(separator + 1);
  const url = new URL(rawUrl);
  if (url.protocol !== 'https:') throw new Error('Git documentation URL must use HTTPS.');
  if (!['github.com', 'gitlab.com'].includes(url.hostname)) {
    throw new Error('Git documentation supports GitHub and GitLab archive URLs.');
  }
  if (!ref.trim()) throw new Error('Git documentation ref cannot be empty.');
  return { url, ref };
}

/**
 * Build the provider archive URL used when the backend has no git binary.
 *
 * Args:
 *   locator: Parsed repository and ref.
 *
 * Returns:
 *   HTTPS tar-gzip archive URL.
 */
export function archiveUrlFor(locator: GitLocator): URL {
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

/** Reader for public GitHub and GitLab Markdown repositories. */
export class GitReader implements DocSourceReader {
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
    const locator = parseGitLocator(source.locator);
    const temporary = await mkdtemp(join(tmpdir(), 'day0-docs-git-'));
    const checkout = join(temporary, 'checkout');
    try {
      const cloned = spawnSync(
        'git',
        ['clone', '--depth', '1', '--branch', locator.ref, '--', locator.url.href, checkout],
        { encoding: 'utf8', timeout: 30_000 },
      );
      if (cloned.status !== 0) {
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
          throw new Error(`Git archive extraction failed: ${extracted.error?.message || extracted.stderr}`);
        }
      }
      return await readMarkdownDirectory(source, checkout);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
