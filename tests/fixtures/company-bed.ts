import { readFileSync } from 'node:fs';
import { credentialMarker } from '../../src/docs/redaction';
import { LINEAR_TOKEN_PLACEHOLDER, LOOKER_PASSWORD_PLACEHOLDER } from './notion-pages';

/**
 * The company bed's documentation set: one folder source carrying a handbook
 * per role and two Notion pages, as documentation sync stores them.
 *
 * The files under `tests/fixtures/company-bed/` are copied byte for byte from
 * `bed/company/folder/` and `bed/company/notion/`, and `tests/bed/company-docs.test.ts`
 * fails while a copy is stale. Only the pages sync reads are here; the paste
 * instructions and the manager's answers are not documentation.
 */

export interface CompanyPage {
  source: 'folder' | 'notion';
  ref: string;
  title: string;
  markdown: string;
}

/** Folder pages in the stable reference order the folder reader returns them. */
const FOLDER_REFS = [
  'finance/handbook.md',
  'finance/runbooks/close-status-note.md',
  'logistics/handbook.md',
  'logistics/runbooks/exception-note.md',
  'onboarding.md',
  'revops/handbook.md',
  'revops/runbooks/how-to-post-slack.md',
  'revops/runbooks/how-to-refresh-the-tile.md',
  'revops/runbooks/how-to-update-ticket.md',
  'revops/runbooks/q3-close-checklist.md',
  'systems/looker-pipeline-tile.md',
  'systems/netledger.md',
  'systems/northstar-crm.md',
] as const;

/** Notion pages keyed by a stable page id, as the Notion reader keys them. */
const NOTION_PAGES = [
  { ref: 'notion-linear-automation', file: 'linear-automation.md' },
  { ref: 'notion-slack-automation-policy', file: 'slack-automation-policy.md' },
] as const;

/**
 * Read one fixture file.
 *
 * Args:
 *   path: Path under `tests/fixtures/company-bed/`.
 *
 * Returns:
 *   The file's Markdown.
 */
function read(path: string): string {
  return readFileSync(new URL(`./company-bed/${path}`, import.meta.url), 'utf8');
}

/**
 * Title a page the way the readers do: its first `# ` heading.
 *
 * Args:
 *   markdown: Page content.
 *   fallback: Title when the page has no heading.
 *
 * Returns:
 *   The page title.
 */
function titleOf(markdown: string, fallback: string): string {
  return /^#\s+(.+)$/m.exec(markdown)?.[1]?.trim() ?? fallback;
}

/**
 * Read the company's pages as documentation sync stores them.
 *
 * The Linear token line and the dashboard login carry their stored markers,
 * as a synced and redacted page does.
 *
 * Returns:
 *   The folder pages in reference order, then the two Notion pages.
 */
export function companyPages(): CompanyPage[] {
  const redacted = (markdown: string): string =>
    markdown
      .replace(LINEAR_TOKEN_PLACEHOLDER, credentialMarker('linear service token'))
      .replace(
        LOOKER_PASSWORD_PLACEHOLDER,
        credentialMarker('looker pipeline tile dashboard login'),
      );
  const folder = FOLDER_REFS.map((ref): CompanyPage => {
    const markdown = redacted(read(`folder/${ref}`));
    return { source: 'folder', ref, title: titleOf(markdown, ref), markdown };
  });
  const notion = NOTION_PAGES.map(({ ref, file }): CompanyPage => {
    const markdown = redacted(read(`notion/${file}`));
    return { source: 'notion', ref, title: titleOf(markdown, ref), markdown };
  });
  return [...folder, ...notion];
}

/** One page of the company set by its reference. */
export function companyPage(ref: string): CompanyPage {
  const page = companyPages().find((candidate): boolean => candidate.ref === ref);
  if (!page) throw new Error(`no company page ${ref}`);
  return page;
}
