import { describe, expect, it } from 'vitest';
import * as copy from '../../../app/marketing/copy';

/** Every string the copy module exports, however deeply it is nested. */
function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(strings);
  return [];
}

describe('the landing copy', () => {
  it('carries the operator’s replacement for the second problem card word for word (UX round four, 1.1)', () => {
    expect(copy.PROBLEM.cards[1]).toEqual({
      title: 'What day0 does instead',
      body: 'Day0 is deployed with a name and nothing else. It reads the documentation you point it at, holds a Day-1 one-to-one with you, and drafts its own work charter (like a JD) for your approval. From there it works with you, with clear, distinct roles, and drives work autonomously under your supervision.',
    });
    expect(copy.PROBLEM.heading).toBe('Today, deploying an agent means engineering one.');
  });

  it('keeps the pilot sentence and the words round three removed off the page', () => {
    const all = strings(copy).join('\n');
    for (const removed of [
      'It is the main reason agents stall at the pilot.',
      'What a new colleague gets instead',
      'See a recorded run',
      'Source',
    ]) {
      expect(all).not.toContain(removed);
    }
  });

  it('writes no em dash and no American spelling in any sentence', () => {
    for (const sentence of strings(copy)) {
      expect(sentence).not.toContain('—');
      expect(sentence).not.toMatch(/\b(color|behavior|organiz|recogniz|summariz|prioritiz)/i);
    }
  });

  it('lists four how-it-works steps, one per frame', () => {
    expect(copy.HOW.steps.map((step) => step.title)).toEqual([
      'Reads the documentation',
      'Holds a Day-1 one-to-one',
      'Drafts a charter the manager approves',
      'Works behind an exact-action gate',
    ]);
  });

  it('points the footer at the repository, its disclosures and its changelog', () => {
    expect(copy.FOOTER.links.map((link) => link.href)).toEqual([
      'https://github.com/BrianIsaac/day0',
      'https://github.com/BrianIsaac/day0#disclosures',
      'https://github.com/BrianIsaac/day0/blob/main/CHANGELOG.md',
    ]);
  });
});
