/**
 * Copy the company bed's folder pages into the documentation folder.
 *
 * The folder is the operator's: it may hold pages the bed did not write, and
 * those are never overwritten without `--replace`. What the bed wrote is
 * recorded, with a hash of what it wrote, in a manifest beside the pages
 * (JSON, so documentation sync, which reads Markdown only, never sees it). A
 * page is the bed's to update when the manifest says the bed wrote it and it
 * has not been edited since.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** The manifest's file name inside the documentation folder. */
export const MANIFEST_FILE = '.day0-company-bed.json';
/** Where the setup's placeholder page sits in a folder it created. */
export const STUB_REF = 'README.md';

export interface DocsManifest {
  /** Page ref to the sha256 of the text the bed last wrote there. */
  files: Record<string, string>;
}

export interface BedDocPage {
  ref: string;
  content: string;
}

export interface DocsPlan {
  write: Array<BedDocPage & { reason: 'new' | 'updated' | 'replaced' }>;
  unchanged: string[];
  refused: Array<{ ref: string; reason: string }>;
  remove: Array<{ ref: string; reason: string }>;
  /** Markdown in the folder that is not one of the bed's pages and stays. */
  foreign: string[];
}

/** The sha256 of a page's text. */
export function pageHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function markdownRefs(root: string, directory: string = root): string[] {
  if (!existsSync(directory)) return [];
  const refs: string[] = [];
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right): number =>
    left.name.localeCompare(right.name),
  );
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) refs.push(...markdownRefs(root, path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      refs.push(relative(root, path).split(sep).join('/'));
    }
  }
  return refs;
}

/**
 * The bed's tracked folder pages, in the folder reader's order.
 *
 * Args:
 *   sourceDir: `bed/company/folder`.
 *
 * Returns:
 *   Each page's ref and text.
 */
export function trackedPages(sourceDir: string): BedDocPage[] {
  return markdownRefs(sourceDir).map(
    (ref: string): BedDocPage => ({ ref, content: readFileSync(join(sourceDir, ref), 'utf8') }),
  );
}

/**
 * The manifest in a documentation folder, empty when there is none yet.
 *
 * Args:
 *   target: The documentation folder.
 *
 * Returns:
 *   What the bed recorded it wrote.
 *
 * Raises:
 *   Error: If the manifest exists and is not one this script wrote.
 */
export function readManifest(target: string): DocsManifest {
  const path = join(target, MANIFEST_FILE);
  if (!existsSync(path)) return { files: {} };
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<DocsManifest>;
  if (!parsed.files || typeof parsed.files !== 'object') {
    throw new Error(`${path} is not a company bed manifest; move it aside and run again.`);
  }
  return { files: { ...parsed.files } };
}

/**
 * Decide what copying the bed's pages into a folder would do, writing nothing.
 *
 * Args:
 *   input.pages: The bed's tracked pages.
 *   input.target: The documentation folder.
 *   input.manifest: What the bed wrote there before.
 *   input.replace: Overwrite pages the bed did not write, or edited since.
 *   input.stub: The setup's placeholder page, removed when found unchanged.
 *
 * Returns:
 *   The plan. Nothing is written when anything is refused.
 */
export function planDocs(input: {
  pages: readonly BedDocPage[];
  target: string;
  manifest: DocsManifest;
  replace: boolean;
  stub: string;
}): DocsPlan {
  const plan: DocsPlan = { write: [], unchanged: [], refused: [], remove: [], foreign: [] };
  const tracked = new Set(input.pages.map((page: BedDocPage): string => page.ref));
  for (const page of input.pages) {
    const path = join(input.target, page.ref);
    if (!existsSync(path)) {
      plan.write.push({ ...page, reason: 'new' });
      continue;
    }
    const present = readFileSync(path, 'utf8');
    if (present === page.content) {
      plan.unchanged.push(page.ref);
      continue;
    }
    const written = input.manifest.files[page.ref];
    if (written !== undefined && written === pageHash(present)) {
      plan.write.push({ ...page, reason: 'updated' });
    } else if (input.replace) {
      plan.write.push({ ...page, reason: 'replaced' });
    } else {
      plan.refused.push({
        ref: page.ref,
        reason:
          written === undefined
            ? 'is already there and was not written by bed:company'
            : 'was written by bed:company and edited since',
      });
    }
  }
  for (const ref of markdownRefs(input.target)) {
    if (tracked.has(ref)) continue;
    const content = readFileSync(join(input.target, ref), 'utf8');
    if (ref === STUB_REF && content === input.stub) {
      plan.remove.push({ ref, reason: "the setup's placeholder page" });
    } else if (input.manifest.files[ref] === pageHash(content)) {
      plan.remove.push({ ref, reason: 'a bed page no longer tracked' });
    } else {
      plan.foreign.push(ref);
    }
  }
  return plan;
}

/**
 * Carry out a plan that refused nothing, and record what was written.
 *
 * Args:
 *   target: The documentation folder.
 *   plan: A plan from `planDocs` with no refusals.
 *   manifest: The manifest the plan was made against.
 *
 * Returns:
 *   The manifest as written.
 *
 * Raises:
 *   Error: If the plan refused a page.
 */
export function applyDocs(target: string, plan: DocsPlan, manifest: DocsManifest): DocsManifest {
  if (plan.refused.length > 0) throw new Error('refusing to apply a plan that refused a page');
  const files = { ...manifest.files };
  for (const page of plan.write) {
    const path = join(target, page.ref);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, page.content, 'utf8');
    files[page.ref] = pageHash(page.content);
  }
  for (const ref of plan.unchanged) {
    const presentHash = pageHash(readFileSync(join(target, ref), 'utf8'));
    if (manifest.files[ref] === presentHash) files[ref] = presentHash;
    else delete files[ref];
  }
  for (const removal of plan.remove) {
    rmSync(join(target, removal.ref));
    delete files[removal.ref];
  }
  const next: DocsManifest = { files: Object.fromEntries(Object.entries(files).sort()) };
  writeFileSync(join(target, MANIFEST_FILE), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
