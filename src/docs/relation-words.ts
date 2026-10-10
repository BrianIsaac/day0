/*
 * The names of the measures that propose a relation between two pages, and each in the card's
 * words (wave 15, 15-A; the wave file's section 8). Apart from `./relations`, which reads pages'
 * front matter to measure them: the Documentation tab draws these words in the browser and needs
 * none of that.
 */

/**
 * The measures a proposal's evidence names (`docRelations.evidence.measure`), which the card
 * turns into words:
 *
 * - `shared-text`: the percent of the two pages' text they hold in common, block for block.
 * - `title-version`: the two titles are one title but for a version, a year or a draft word.
 * - `names-successor`: one page's front matter names the other (`supersedes:`,
 *   `superseded_by:`).
 * - `heading-figures`: under one heading the two pages say the same sentence with other figures.
 */
export const RELATION_MEASURES = [
  'shared-text',
  'title-version',
  'names-successor',
  'heading-figures',
] as const;

/** One measure. */
export type RelationMeasure = (typeof RELATION_MEASURES)[number];

/** The percent of shared text from which two pages are proposed as one document twice. */
export const SHARED_TEXT_DUPLICATE = 60;

/**
 * A proposal's strongest measure in the card's words (the wave file's section 8): "share 78
 * percent of their text", "have the same title but for a version", "say different figures
 * under "Thresholds"", "one names the other as the page it replaces".
 *
 * @param evidence - The relation's evidence, as stored.
 * @param heading - The heading a conflict sits under, when the caller read it.
 */
export function relationWords(
  evidence: ReadonlyArray<{ readonly measure: string; readonly value: number }>,
  heading?: string,
): string {
  const has = (measure: RelationMeasure): number | undefined =>
    evidence.find((entry) => entry.measure === measure)?.value;
  if (has('names-successor') !== undefined) return 'one names the other as the page it replaces';
  if (has('heading-figures') !== undefined) {
    return heading === undefined || heading === ''
      ? 'say different figures under the same heading'
      : `say different figures under "${heading}"`;
  }
  const share = has('shared-text');
  if (has('title-version') !== undefined) {
    return share !== undefined && share >= SHARED_TEXT_DUPLICATE
      ? `have the same title but for a version and share ${share} percent of their text`
      : 'have the same title but for a version';
  }
  return `share ${share ?? 0} percent of their text`;
}
