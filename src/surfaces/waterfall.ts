export interface WaterfallPage {
  content: string;
  title?: string;
}

export interface WaterfallSurface {
  class: string;
  displayName: string;
  slug: string;
}

const SYSTEMS_HEADING = /^#{1,6}\s+systems and access owners\s*$/i;
const MARKDOWN_HEADING = /^#{1,6}\s+/;
const TABLE_SEPARATOR = /^:?-{3,}:?$/;
const CLASS_PRIORITY = new Map<string, number>([
  ['kanban', 0],
  ['chat', 1],
  ['spreadsheet', 2],
  ['social', 3],
]);

/**
 * Normalise a documented product name for stable equality checks.
 *
 * Args:
 *   value: Markdown table cell or persisted surface label.
 *
 * Returns:
 *   Lowercase alphanumeric product key.
 */
function systemKey(value: string): string {
  return value
    .replace(/[`*_~]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * Read the first column of a Systems and access owners Markdown table.
 *
 * Args:
 *   content: One redacted documentation page.
 *
 * Returns:
 *   Documented product names in table order.
 */
function orderFromPage(content: string): string[] {
  const lines = content.split(/\r?\n/);
  const headingIndex = lines.findIndex((line: string): boolean =>
    SYSTEMS_HEADING.test(line.trim()),
  );
  if (headingIndex < 0) return [];

  const names: string[] = [];
  for (const rawLine of lines.slice(headingIndex + 1)) {
    const line = rawLine.trim();
    if (MARKDOWN_HEADING.test(line)) break;
    if (!line.startsWith('|') || !line.endsWith('|')) continue;
    const firstCell = line.slice(1, -1).split('|')[0]?.trim() ?? '';
    const key = systemKey(firstCell);
    if (!key || key === 'system' || TABLE_SEPARATOR.test(key.replace(/\s/g, ''))) continue;
    names.push(firstCell.replace(/[`*_~]/g, '').trim());
  }
  return names;
}

/**
 * Extract the documented waterfall order from onboarding pages.
 *
 * Pages whose title contains "onboarding" are authoritative when present.
 * Otherwise every supplied page is searched as a compatibility fallback.
 * Duplicate system names are kept only once.
 *
 * Args:
 *   markdownPages: Redacted documentation pages visible to the agent.
 *
 * Returns:
 *   Product display names in documented order.
 */
export function extractDocumentedSystemOrder(markdownPages: readonly WaterfallPage[]): string[] {
  const onboardingPages = markdownPages.filter((page: WaterfallPage): boolean =>
    /\bonboarding\b/i.test(page.title ?? ''),
  );
  const candidates = onboardingPages.length > 0 ? onboardingPages : markdownPages;
  const names = new Map<string, string>();
  for (const page of candidates) {
    for (const name of orderFromPage(page.content)) {
      const key = systemKey(name);
      if (!names.has(key)) names.set(key, name);
    }
  }
  return [...names.values()];
}

/**
 * Sort surfaces by documented onboarding order, then by class priority.
 *
 * Args:
 *   surfaces: Persisted surfaces in their current stable order.
 *   documentedNames: Product names extracted from the onboarding table.
 *
 * Returns:
 *   A new ordered array. The input array is never mutated.
 */
export function orderSurfaceWaterfall<T extends WaterfallSurface>(
  surfaces: readonly T[],
  documentedNames: readonly string[],
): T[] {
  const documentedRank = new Map<string, number>();
  documentedNames.forEach((name: string, index: number): void => {
    const key = systemKey(name);
    if (!documentedRank.has(key)) documentedRank.set(key, index);
  });

  return surfaces
    .map((surface: T, index: number): { surface: T; index: number } => ({ surface, index }))
    .sort((left, right): number => {
      const leftRank = documentedRank.get(systemKey(left.surface.displayName));
      const rightRank = documentedRank.get(systemKey(right.surface.displayName));
      if (leftRank !== undefined || rightRank !== undefined) {
        if (leftRank === undefined) return 1;
        if (rightRank === undefined) return -1;
        if (leftRank !== rightRank) return leftRank - rightRank;
      }
      const leftClass = CLASS_PRIORITY.get(left.surface.class) ?? Number.MAX_SAFE_INTEGER;
      const rightClass = CLASS_PRIORITY.get(right.surface.class) ?? Number.MAX_SAFE_INTEGER;
      if (leftClass !== rightClass) return leftClass - rightClass;
      return left.index - right.index;
    })
    .map(({ surface }): T => surface);
}
