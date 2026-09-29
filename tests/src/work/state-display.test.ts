import { describe, expect, it } from 'vitest';
import type { Doc } from '../../../convex/_generated/dataModel';
import { QUEUE_FILTERS, queueFilterOf, workItemGlossary } from '../../../src/work/state-display';
import { workItemStateLabel } from '../../../src/work/state-labels';

type State = Doc<'workItems'>['state'];

const STATES: readonly State[] = [
  'discovered',
  'claimed',
  'plan-pending',
  'plan-approved',
  'executing',
  'completed',
  'cancelled',
  'failed',
  'skipped',
  'deferred',
  'needs-skill',
  'actions-pending',
];

describe('queueFilterOf', (): void => {
  it('puts every state under exactly one filter besides All', (): void => {
    const none = new Set<string>();
    expect(
      Object.fromEntries(STATES.map((state) => [state, queueFilterOf({ _id: 'w', state }, none)])),
    ).toEqual({
      discovered: 'in-progress',
      claimed: 'in-progress',
      'plan-pending': 'needs-you',
      'plan-approved': 'in-progress',
      executing: 'in-progress',
      completed: 'done',
      cancelled: 'done',
      failed: 'done',
      skipped: 'skipped',
      deferred: 'in-progress',
      'needs-skill': 'in-progress',
      'actions-pending': 'needs-you',
    });
    expect(QUEUE_FILTERS).toEqual(['all', 'needs-you', 'in-progress', 'done', 'skipped']);
  });

  it('follows the inbox: what it lists needs the manager, a stop or a parked row included', (): void => {
    const inbox = new Set(['w-stopped', 'w-parked']);
    expect(queueFilterOf({ _id: 'w-stopped', state: 'failed' }, inbox)).toBe('needs-you');
    expect(queueFilterOf({ _id: 'w-parked', state: 'deferred' }, inbox)).toBe('needs-you');
    expect(queueFilterOf({ _id: 'w-other', state: 'failed' }, inbox)).toBe('done');
  });
});

describe('workItemGlossary', (): void => {
  it("lists every stored state in the chips' own words, a failed item both ways it reads", (): void => {
    const glossary = workItemGlossary();
    expect(new Set(glossary.flatMap((line) => line.states))).toEqual(new Set(STATES));
    for (const line of glossary) {
      for (const state of line.states) {
        if (state !== 'failed') expect(line.label).toEqual(workItemStateLabel({ state }));
      }
      // Read after the chip, so it runs on in lower case.
      expect(line.means).toMatch(/^[a-z]/);
    }
    expect(
      glossary.filter((line) => line.states.includes('failed')).map((line) => line.label.text),
    ).toEqual(['Rejected by you', 'Stopped']);
    expect(glossary.every((line) => line.label.tone !== ('danger' as never))).toBe(true);
    // Nothing overclaimed: a landing may be of no write at all, parking has five causes, and a
    // colleague's hold has no control to give it back.
    const means = (text: string): string | undefined =>
      glossary.find((line) => line.label.text === text)?.means;
    expect(means('Landed')).toBe('finished; the card lists what reached the work environment');
    expect(means('Parked')).toContain('its evaluations kept failing');
    expect(means('Skipped')).toBe('set aside with the reason; most skips you can give back');
    // One chip, one line: Working is the plan being drafted or the run under way.
    expect(glossary.filter((line) => line.label.text === 'Working')).toEqual([
      {
        label: { text: 'Working', tone: 'accent' },
        means: 'drafting a plan for work judged part of the job, or running the approved plan',
        states: ['claimed', 'executing'],
      },
    ]);
  });
});
