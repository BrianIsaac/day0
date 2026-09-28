import { readFileSync } from 'node:fs';
import { credentialMarker } from '../../src/docs/redaction';

/**
 * The handbook pages the orientation and sync tests read. Four are the
 * company bed's own pages byte for byte (`bed/company/folder/`,
 * `bed/company/notion/`; `tests/bed/company-docs.test.ts` fails while a copy
 * is stale). `slack-day0-app` is the Slack policy page of the operator's
 * September 2026 Notion workspace, kept because it carries the app manifest
 * the provisioning tests read and the bed's Slack page does not; see
 * `tests/fixtures/README.md`.
 */
export type NotionPageName =
  | 'onboarding'
  | 'linear-automation'
  | 'slack-day0-app'
  | 'northstar-crm'
  | 'looker-pipeline-tile';

/** The placeholder the Linear template carries where the operator pastes the service token. */
export const LINEAR_TOKEN_PLACEHOLDER = 'PASTE_LINEAR_API_KEY_HERE';
export const LOOKER_PASSWORD_PLACEHOLDER = 'pipeline-tile-local';

/**
 * Read one page template exactly as it is published.
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
  return notionPageTemplate(name)
    .replace(LINEAR_TOKEN_PLACEHOLDER, credentialMarker('linear service token'))
    .replace(
      LOOKER_PASSWORD_PLACEHOLDER,
      credentialMarker('looker pipeline tile dashboard login'),
    );
}
