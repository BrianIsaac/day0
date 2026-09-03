import type { MockSurfaceSnapshot } from './types';

/**
 * Render the loaded how-to guides for a model prompt.
 *
 * Args:
 *   guides: The how-to guides read from the linked documentation.
 *
 * Returns:
 *   One titled block per guide, or a line saying none is loaded.
 */
export function renderHowTos(guides: MockSurfaceSnapshot['howToGuides']): string {
  if (guides.length === 0) return '(no how-to guides loaded)';
  return guides.map((g) => `--- ${g.title} ---\n${g.body}`).join('\n\n');
}

/**
 * Render the loaded team documents for a model prompt.
 *
 * Args:
 *   docs: The team documents read from the linked documentation.
 *
 * Returns:
 *   One titled block per document, or a line saying none is loaded.
 */
export function renderTeamDocs(docs: MockSurfaceSnapshot['teamDocs']): string {
  if (docs.length === 0) return '(no team docs loaded)';
  return docs.map((d) => `--- ${d.title} ---\n${d.body}`).join('\n\n');
}
