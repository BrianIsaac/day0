import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL(
  '../../evaluation/results/2026-10-14T06-31-17Z-second-model-gpt56terra/',
  import.meta.url,
);
const read = (path: string): string => readFileSync(new URL(path, DIR), 'utf8');

/** The cites of one draft as the walk printed them: the step, and whether the passage is disputed. */
function cites(draft: string): Array<{ step: number; conflict: boolean; label: string }> {
  return draft.split('\n').flatMap((line) => {
    const match = /^\s*cite step (\d+): (.*?)( \[conflict\])?$/.exec(line);
    return match
      ? [{ step: Number(match[1]), conflict: match[3] !== undefined, label: match[2]! }]
      : [];
  });
}

describe('the second model’s readings of 14 October 2026', (): void => {
  it('cites both disputed passages on REVOPS-2’s asking step and on the step that writes, and asks', (): void => {
    const draft = read('walk/terra-draft-revops2.txt');
    const disputed = cites(draft).filter((cite) => cite.conflict);
    expect([...new Set(disputed.map((cite) => cite.step))]).toEqual([1, 2]);
    expect(disputed.map((cite) => cite.label.split('#')[0])).toEqual([
      'Revops folder/runbooks/close-comment-limits.md',
      'Policies folder/close-comment-limits.md',
      'Revops folder/runbooks/close-comment-limits.md',
      'Policies folder/close-comment-limits.md',
    ]);
    expect(draft).toContain(
      'QUESTION open | k97b4z2afb4dg33ka8w3knrnh58g91g5 | Two pages disagree',
    );
    expect(draft).toContain('holds its writes to Slack and Linear until you answer and Retry');
  });

  it('cites no disputed passage on REVOPS-1’s first draft and asks nothing about the comment’s length', (): void => {
    const draft = read('walk/terra-draft-revops1.txt');
    expect(cites(draft).some((cite) => cite.conflict)).toBe(false);
    expect(cites(draft).map((cite) => cite.label)).toContain(
      'Revops folder/runbooks/close-comment-limits.md#Close comment limits > What a comment carries',
    );
    expect(draft).not.toContain('Two pages disagree');
  });

  it('keeps the redrafted comment under the shorter limit, so that it satisfies both pages', (): void => {
    const draft = read('walk/terra-draft-revops1-redraft.txt');
    expect(draft).toContain(
      'Keep it below 60 words, so it complies with both documented comment limits.',
    );
    expect(cites(draft)).toContainEqual({
      step: 2,
      conflict: false,
      label: 'Revops folder/runbooks/close-comment-limits.md#Close comment limits > Comment length',
    });
  });

  it('withheld the comment and the status change while the question was open, on the manager’s go-ahead', (): void => {
    const retry = read('walk/terra-revops2-retry.txt');
    expect(retry).toContain('"tool": "save_comment"');
    expect(retry).toContain(
      "withheld: the approved plan leaves step 2 to the manager's answer, and the question put to the manager is still open",
    );
  });

  it('proposes the same kind on every card under both models', (): void => {
    const { cards } = JSON.parse(read('judgement-cards.json')) as {
      cards: Array<{ trigger: string; proposed: Record<string, { kind: string }> }>;
    };
    expect(
      cards.map((card) => [
        card.trigger,
        card.proposed['zai-org/GLM-5.3-Flash']!.kind,
        card.proposed['gpt-5.6-terra']!.kind,
      ]),
    ).toEqual([
      ['access-revoked', 'none', 'none'],
      ['access-revoked', 'skill-action', 'skill-action'],
      ['role-changed', 'charter-change', 'charter-change'],
    ]);
  });
});
