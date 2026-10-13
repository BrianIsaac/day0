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
 * - `edit-dates`: the whole days between the two pages' edit times in their sources, for a pair
 *   that shares enough text to be one document (wave 16, 16-FD; RM19 (a)).
 */
export const RELATION_MEASURES = [
  'shared-text',
  'title-version',
  'names-successor',
  'heading-figures',
  'edit-dates',
] as const;

/** One measure. */
export type RelationMeasure = (typeof RELATION_MEASURES)[number];

/** The percent of shared text from which two pages are proposed as one document twice. */
export const SHARED_TEXT_DUPLICATE = 60;

/**
 * A proposal's strongest measure in the card's words (the wave file's section 8): "share 78
 * percent of their text", "have the same title but for a version", "say different figures
 * under "Thresholds"", "one names the other as the page it replaces"; for a copy its source
 * dated later, the days between, the card naming the older page first (RM19 (a)).
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
  const days = has('edit-dates');
  if (days !== undefined) {
    const apart = days === 1 ? 'a day' : `${days} days`;
    return `share ${share ?? 0} percent of their text, and the second was edited ${apart} after the first`;
  }
  return `share ${share ?? 0} percent of their text`;
}

/**
 * The figures two pages say under one heading, as a conflict's card says them (16-J's W9a): only
 * the ones that differ, place for place. The measure keeps every figure of the differing line, so
 * "at most 60 words on a Q3 close ticket" against "120 words" read "3 60 against 3 120". Lines
 * whose figures do not line up one for one, or that do not differ, are said as they are.
 *
 * @param figures - Each page's figures on the line, space-separated, as the measure kept them.
 */
export function differingFigures(figures: { readonly from: string; readonly to: string }): {
  from: string;
  to: string;
} {
  const from = figures.from.split(/\s+/).filter((figure) => figure !== '');
  const to = figures.to.split(/\s+/).filter((figure) => figure !== '');
  if (from.length !== to.length) return { from: figures.from, to: figures.to };
  const differing = from.flatMap((figure, index) => (figure === to[index] ? [] : [index]));
  if (differing.length === 0) return { from: figures.from, to: figures.to };
  return {
    from: differing.map((index) => from[index]).join(' '),
    to: differing.map((index) => to[index]).join(' '),
  };
}
