import { readFileSync } from 'node:fs';
import { credentialMarker } from '../../src/docs/redaction';

/** The four handbook pages the operator pastes into Notion, committed as twins of `docs/submission/notion-pages/`. */
export type NotionPageName = 'onboarding' | 'linear-automation' | 'slack-day0-app' | 'northstar-crm';

/** The placeholder the Linear template carries where the operator pastes the service token. */
export const LINEAR_TOKEN_PLACEHOLDER = 'PASTE_LINEAR_API_KEY_HERE';

/**
 * Read one page template exactly as it is pasted into Notion.
 *
 * Args:
 *   name: The page's file stem under `tests/fixtures/notion-pages/`.
 *
 * Returns:
 *   The raw Markdown, token placeholder included.
 */
export function notionPageTemplate(name: NotionPageName): string {
  return readFileSync(new URL(`./notion-pages/${name}.md`, import.meta.url), 'utf8');
}

/**
 * Read one page as documentation sync stores it: the pasted token replaced by its marker.
 *
 * Args:
 *   name: The page's file stem under `tests/fixtures/notion-pages/`.
 *
 * Returns:
 *   The Markdown a synced, redacted mirror of the page carries.
 */
export function sanitisedNotionPage(name: NotionPageName): string {
  return notionPageTemplate(name).replace(
    LINEAR_TOKEN_PLACEHOLDER,
    credentialMarker('linear service token'),
  );
}
