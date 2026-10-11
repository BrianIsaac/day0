import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoutQueries } from '../../src/docs/select';
import { RETRIEVAL_CASES, retrievalCases, retrievalPages } from './fixture';
import {
  RECALL_BAR,
  buildRetrievalGrade,
  gradeCase,
  renderRetrievalGrade,
  scoutedBlocks,
  selectionRequestOf,
  type RetrievalGradeEvidence,
} from './matrix';

const COMMIT = '0123456789abcdef0123456789abcdef01234567';

/** Every tracked grade, with its file. */
function trackedGrades(): { file: URL; grade: RetrievalGradeEvidence }[] {
  return readdirSync(new URL('./', import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== 'pages')
    .map((entry) => new URL(`./${entry.name}/grade.json`, import.meta.url))
    .filter((url) => existsSync(url))
    .map((file) => ({
      file,
      grade: JSON.parse(readFileSync(file, 'utf8')) as RetrievalGradeEvidence,
    }));
}

describe('the retrieval labelled set', (): void => {
  // Re-pinned on 11 October 2026: the set gained two items over four pages of mixed trust
  // (W15-R23), so it is 32 over 21 now and still the 30 over 17 as of any earlier day.
  it('labels 32 items over the bed’s fifteen pages, the rehearsal’s own page, a Chinese runbook and four pages of mixed trust', (): void => {
    const pages = retrievalPages();
    expect(RETRIEVAL_CASES).toHaveLength(32);
    expect(pages).toHaveLength(21);
    const keys = new Set(pages.map((page) => page.key));
    for (const entry of RETRIEVAL_CASES) {
      for (const key of entry.pages) expect(keys, entry.id).toContain(key);
      for (const section of entry.sections) expect(entry.pages, entry.id).toContain(section.page);
      if (entry.order) {
        expect(keys, entry.id).toContain(entry.order.first);
        expect(keys, entry.id).toContain(entry.order.then);
      }
    }
    expect(new Set(RETRIEVAL_CASES.map((entry) => entry.id)).size).toBe(32);
  });

  it('is the set as it stood on the day a grade was taken: 30 items over 17 pages before 11 October 2026', (): void => {
    const before = new Date('2026-10-10T23:59:59.999Z');
    const since = new Date('2026-10-11T00:00:00.000Z');
    expect(retrievalCases(before)).toEqual(RETRIEVAL_CASES.slice(0, 30));
    expect(retrievalPages(before)).toEqual(retrievalPages().slice(0, 17));
    expect(retrievalCases(since)).toEqual(RETRIEVAL_CASES);
    expect(retrievalPages(since)).toHaveLength(21);
    expect(retrievalPages(before).every((page) => page.authority === undefined)).toBe(true);
    expect(
      retrievalPages()
        .filter((page) => page.authority !== undefined)
        .map((page) => [page.key, page.authority]),
    ).toEqual([
      ['policy:credit-control-policy.md', 'official'],
      ['policy:supplier-payment-runs.md', 'official'],
    ]);
  });

  it('holds the order between two pages of different trust: the team runbook that answers before the official page that names it, and the official page before the team copy of it', (): void => {
    const pages = retrievalPages();
    const ordered = RETRIEVAL_CASES.filter((entry) => entry.order !== undefined);
    expect(ordered.map((entry) => entry.id)).toEqual([
      'fin-overdue-invoice',
      'fin-payment-run-cut-off',
    ]);
    expect(ordered.map((entry) => gradeCase(entry, pages).order)).toEqual([
      {
        first: 'notion:overdue-invoice-escalation.md',
        then: 'policy:credit-control-policy.md',
        held: true,
      },
      {
        first: 'policy:supplier-payment-runs.md',
        then: 'notion:supplier-payment-runs.md',
        held: true,
      },
    ]);
    for (const entry of ordered) {
      const row = gradeCase(entry, pages);
      expect(row.pages.recall, entry.id).toBe(1);
      expect(row.sections.recall, entry.id).toBe(1);
    }
    // An item that names no order records none, so an older grade's rows read as they did.
    expect(gradeCase(RETRIEVAL_CASES[0], pages)).not.toHaveProperty('order');
  });

  it('orders the same document in two sources by their trust and by nothing else', (): void => {
    const copies = RETRIEVAL_CASES.find((entry) => entry.id === 'fin-payment-run-cut-off')!;
    const pages = retrievalPages();
    const [official, team] = [copies.order!.first, copies.order!.then].map(
      (key) => pages.find((page) => page.key === key)!,
    );
    expect(official.body).toBe(team.body);
    expect(official.title).toBe(team.title);
    // The trust exchanged between the two sources: the copy that was the team's is first.
    const exchanged = pages.map((page) =>
      page.key === official.key
        ? { ...page, authority: 'team' as const }
        : page.key === team.key
          ? { ...page, authority: 'official' as const }
          : page,
    );
    expect(gradeCase(copies, exchanged).order?.held).toBe(false);
    // No trust said for either: the tie goes to the corpus's order, where the team's copy is first.
    const untold = pages.map((page) =>
      page.key === official.key ? { ...page, authority: undefined } : page,
    );
    expect(gradeCase(copies, untold).order?.held).toBe(false);
  });

  it('recalls at or above R2’s bar, the prompt and the ranked pick alone: 0.9 at 6 pages and 0.8 at 12 blocks, without a model', (): void => {
    const evidence = buildRetrievalGrade(COMMIT, new Date('2026-10-08T00:00:00.000Z'));
    expect(evidence.noModelCalls).toBe(true);
    expect(evidence.cases).toBe(30);
    expect(evidence.recall.pages).toBeGreaterThanOrEqual(RECALL_BAR.pages);
    expect(evidence.recall.blocks).toBeGreaterThanOrEqual(RECALL_BAR.blocks);
    // The ranked pick alone, on what the pages always included leave to find.
    expect(evidence.rankedRecall.pages).toBeGreaterThanOrEqual(RECALL_BAR.pages);
    expect(evidence.rankedRecall.blocks).toBeGreaterThanOrEqual(RECALL_BAR.blocks);
    expect(evidence.meetsBar).toBe(true);
    for (const row of evidence.observations) expect(row.chars).toBeLessThanOrEqual(24_000);
    expect(renderRetrievalGrade(evidence)).toContain('n=30');
  });

  it('meets the bar on the set as it stands, and says how many ordered items held', (): void => {
    const evidence = buildRetrievalGrade(COMMIT, new Date('2026-10-11T12:00:00.000Z'));
    expect(evidence.cases).toBe(32);
    expect(evidence.meetsBar).toBe(true);
    expect(evidence.order).toEqual({ cases: 2, held: 2 });
    const markdown = renderRetrievalGrade(evidence);
    expect(markdown).toContain('n=32');
    expect(markdown).toContain(
      'Order between two pages of different trust (2 items, each naming the page that must rank first): held on 2.',
    );
    // A grade of the set before it had such items says nothing of order.
    const earlier = buildRetrievalGrade(COMMIT, new Date('2026-10-08T00:00:00.000Z'));
    expect(earlier.order).toBeUndefined();
    expect(renderRetrievalGrade(earlier)).not.toContain('Order between');
  });

  it('finds the Chinese runbook for a Chinese item through its bigrams alone', (): void => {
    const pages = retrievalPages();
    const zh = RETRIEVAL_CASES.find((entry) => entry.id === 'zh-handover-signature')!;
    expect(gradeCase(zh, pages).pages.recall).toBe(1);
    // The runbook's sentences are runs of eleven or more characters, which the index keeps only
    // as bigrams; a whole-run query term finds nothing.
    expect(scoutedBlocks(['交接清单缺少签字不能交接'], pages)).toEqual([]);
    expect(scoutedBlocks(['签字'], pages).map((block) => block.pageKey)).toEqual([
      'company:logistics/runbooks/warehouse-handover-zh.md',
    ]);
  });

  // Since 11 October 2026 each tracked grade is reproduced over the set as it stood on the grade's
  // own day: the set grew that day, and a grade of 30 items is still held to the selector.
  it('reproduces every tracked grade of the emulated scout from the current selector, so a published recall cannot drift', (): void => {
    const emulated = trackedGrades().filter(({ grade }) => grade.scout !== 'backend');
    expect(emulated.length).toBeGreaterThanOrEqual(1);
    for (const { file, grade } of emulated) {
      const current = buildRetrievalGrade(COMMIT, new Date(grade.generatedAt));
      expect(current.cases, file.pathname).toBe(grade.cases);
      expect({ observations: current.observations, recall: current.recall }, file.pathname).toEqual(
        { observations: grade.observations, recall: grade.recall },
      );
      expect(current.order, file.pathname).toEqual(grade.order);
    }
    // The newest of them is of the set as it stands.
    const newest = emulated
      .map(({ grade }) => grade)
      .sort((a, b) => a.generatedAt.localeCompare(b.generatedAt))
      .at(-1)!;
    expect(newest.cases).toBe(RETRIEVAL_CASES.length);
  });

  it('grades with the scout it is given, the emulation by default', (): void => {
    const pages = retrievalPages();
    const entry = RETRIEVAL_CASES[0];
    const asked: string[][] = [];
    gradeCase(entry, pages, (queries) => {
      asked.push([...queries]);
      return [];
    });
    expect(asked).toEqual([scoutQueries(selectionRequestOf(entry), pages)]);
    expect(gradeCase(entry, pages, scoutedBlocks)).toEqual(gradeCase(entry, pages));
    // A scout that finds nothing leaves the pages always included alone: reader 2's probe of the
    // review (W14-R30) read 25.0% of pages from them.
    const alone = buildRetrievalGrade(COMMIT, new Date('2026-10-09T00:00:00.000Z'), {
      scout: () => [],
    });
    expect(alone.recall.pages).toBeCloseTo(0.25, 3);
    expect(alone.observations.every((row) => row.ranked.pages?.recall !== 1)).toBe(true);
  });

  it('lists a grade whose scout was the backend’s search and does not reproduce it, since no test can run the backend', (): void => {
    const backend = trackedGrades().filter(({ grade }) => grade.scout === 'backend');
    expect(backend.length).toBeGreaterThanOrEqual(1);
    for (const { file, grade } of backend) {
      // The set as it stood on the grade's day: 30 items over 17 pages before 11 October 2026.
      const gradedOn = new Date(grade.generatedAt);
      expect(grade.cases, file.pathname).toBe(retrievalCases(gradedOn).length);
      expect(grade.backend?.pagesStored, file.pathname).toBe(retrievalPages(gradedOn).length);
      expect(grade.backend?.image, file.pathname).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(grade.backend?.searches, file.pathname).toBeGreaterThan(0);
      const emulated = trackedGrades().find(
        ({ file: other }) => other.pathname.split('/').at(-2) === grade.backend?.emulated.stamp,
      );
      expect(emulated?.grade.scout, file.pathname).toBeUndefined();
      expect(grade.backend?.emulated.recall, file.pathname).toEqual(emulated?.grade.recall);
      expect(renderRetrievalGrade(grade), file.pathname).toContain('the backend’s search');
    }
  });
});
