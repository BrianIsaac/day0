import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  CHARTER,
  DOCUMENTATION,
  HELD_WRITE,
  ONE_TO_ONE,
} from '../../../../app/marketing/frames/fixtures';
import { companyPages } from '../../../fixtures/company-bed';
import { DAY_ONE_TRANSCRIPT_2026_09_14 } from '../../../fixtures/day-one-transcript-2026-09-14';
import { strikeRefusalBody } from '../../../fixtures/charter-strike-refusal-2026-09-15';
import {
  log2Candidate,
  log2PhaseOneActions,
} from '../../../fixtures/work/full-run-2026-09-19-log-2';

describe('the frames’ fixture data', () => {
  it('shows the company bed’s documentation: its sources, its page count and real page titles', () => {
    const pages = companyPages();
    expect(new Set(pages.map((page) => page.source)).size).toBe(DOCUMENTATION.sources);
    expect(pages).toHaveLength(DOCUMENTATION.pages);
    for (const row of DOCUMENTATION.rows) {
      const page = pages.find((candidate) => candidate.title === row.title);
      expect(page?.source, row.title).toBe(row.source.toLowerCase());
    }
  });

  it('opens the one-to-one with the recorded first question and answer', () => {
    const lines = DAY_ONE_TRANSCRIPT_2026_09_14.split('\n');
    expect(lines[0]).toBe(`ASSISTANT: ${ONE_TO_ONE.question}`);
    expect(lines[1]).toBe(`USER: ${ONE_TO_ONE.answer}`);
    expect(lines.filter((line) => line.startsWith('ASSISTANT:'))).toHaveLength(ONE_TO_ONE.topics);
  });

  it('reviews the recorded charter: the manager’s boundary kept, the derived rule struck', () => {
    const charter = strikeRefusalBody();
    expect(charter.version).toBe(CHARTER.version);
    const [kept, struck] = CHARTER.rules;
    const boundary = charter.constraints?.find((constraint) => constraint.quote === kept.quote);
    expect(boundary?.kind).toBe('system-boundary');
    expect(boundary?.struck).toBeUndefined();
    expect(boundary?.wording).toContain(kept.clause);
    expect(charter.proposedBoundaries.willNotDo).toContain(kept.clause);
    const derived = charter.constraints?.find((constraint) => constraint.quote === struck.quote);
    expect(derived).toMatchObject({ kind: 'candidate-property', origin: 'derived', struck: true });
    expect(derived?.wording).toEqual([struck.clause]);
  });

  it('holds the exact comment the run held on LOG-2, for the recorded item', () => {
    expect(log2Candidate.title).toBe(HELD_WRITE.item);
    const held = log2PhaseOneActions.find(
      (action) => action.tool === 'mcp.call' && String(action.args.tool) === 'save_comment',
    );
    const args = JSON.parse(String(held?.args.toolArgsJson)) as { issueId: string; body: string };
    expect(args.issueId).toBe('LOG-2');
    expect(args.body).toBe(HELD_WRITE.body);
    expect(held?.args.surface).toBe('linear');
  });

  it('cites each source by the path it names', () => {
    const source = readFileSync(
      new URL('../../../../app/marketing/frames/fixtures.ts', import.meta.url),
      'utf8',
    );
    for (const path of [
      'bed/company/',
      'tests/fixtures/day-one-transcript-2026-09-14.ts',
      'tests/fixtures/charter-strike-refusal-2026-09-15.ts',
      'tests/fixtures/work/full-run-2026-09-19-log-2.ts',
    ]) {
      expect(source).toContain(path);
    }
  });
});
