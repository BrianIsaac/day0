import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const DIR = new URL(
  '../../evaluation/results/2026-10-15T00-33-02Z-second-model-gpt56terra/',
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

/** The steps whose cites carry the conflict tag, in order and without repeats. */
function disputedSteps(draft: string): number[] {
  return [
    ...new Set(
      cites(draft)
        .filter((cite) => cite.conflict)
        .map((cite) => cite.step),
    ),
  ];
}

describe('the second model’s readings on the v0.22.0 release commit', (): void => {
  it('cites both disputed passages on the step that writes REVOPS-2’s comment, asks, and keeps under the shorter limit', (): void => {
    const draft = read('walk/terra-draft-revops2.txt');
    expect(disputedSteps(draft)).toEqual([2]);
    expect(draft).toContain('  step 2: After the manager literally approves the payload, add');
    expect(
      cites(draft)
        .filter((cite) => cite.conflict)
        .map((cite) => cite.label.split('#')[0]),
    ).toEqual([
      'Revops folder/runbooks/close-comment-limits.md',
      'Policies folder/close-comment-limits.md',
    ]);
    expect(draft).toContain(
      'The comment will remain within 60 words, so it complies with both conflicting comment limits without selecting either one.',
    );
    expect(draft).toContain('holds its writes to Linear until you answer and Retry');
  });

  it('cites the disputed passage on GLM’s REVOPS-2 only on a step of its own that asks the manager', (): void => {
    const draft = read('walk/glm-draft-revops2.txt');
    expect(disputedSteps(draft)).toEqual([2]);
    expect(draft).toContain('ask which comment word limit applies');
    expect(draft).toContain('holds its writes to Slack and Linear until you answer and Retry');
  });

  it('cites no disputed passage on the second model’s REVOPS-1, and the tagged one on GLM’s comment step', (): void => {
    const terra = read('walk/terra-draft-revops1.txt');
    expect(disputedSteps(terra)).toEqual([]);
    expect(terra).not.toContain('Two pages disagree');
    expect(terra).toContain(
      'Keep the comment within 60 words, so it complies with both documented limits.',
    );
    const glm = read('walk/glm-draft-revops1.txt');
    expect(disputedSteps(glm)).toEqual([2]);
    expect(glm).toContain('  step 2: Post the drafted audit comment to REVOPS-1');
    expect(glm).toContain('QUESTION open | k970wt9xmydpdjzkba5ke7m6z58ga490 | Two pages disagree');
  });

  it('ended REVOPS-2’s retry completed with the work not done and nothing written to Linear, then held both writes once the pair was answered', (): void => {
    const retry = read('walk/terra-revops2-retry.txt');
    expect(retry).toContain('REVOPS-2 state=completed');
    expect(retry).toContain('workDone: "not-done"');
    expect(retry).toContain('{"email":"manager@acme.test"} | applied: {"actionClass": "read"');
    expect(retry).not.toContain('save_comment');
    const after = read('walk/terra-revops2-after-both.txt');
    expect(after).toContain('REVOPS-2 state=actions-pending');
    expect(after).toContain('mcp.call save_comment');
    expect(after).toContain('{"id":"REVOPS-2","state":"Done"} | applied: None');
  });

  it('proposes the same kind on every card under both models, after GLM’s first judgement of the revocation card failed', (): void => {
    const { cards } = JSON.parse(read('judgement-cards.json')) as {
      cards: Array<{
        trigger: string;
        proposed: Record<string, { kind: string }>;
        earlierDraws?: Array<{ model: string; proposed: { kind: string; failure?: string } }>;
      }>;
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
    expect(cards[0]!.earlierDraws).toEqual([
      expect.objectContaining({
        model: 'zai-org/GLM-5.3-Flash',
        proposed: { kind: 'pending', failure: 'unreadable' },
      }),
    ]);
  });
});
