import { describe, expect, it } from 'vitest';
import {
  bindSkillInputs,
  declaredSkillInputs,
  renderSkillInputs,
  skillInputPlaceholders,
  undeclaredSkillInputs,
} from '../../../src/work/skill-inputs';
import type { WorkCandidate } from '../../../src/work/types';

const body = [
  '# Value refresh on an analytics surface',
  '',
  '## When to invoke',
  'A ticket asks for the tile figure to be set to a stated value.',
  '',
  '## Inputs',
  '- `<record-id>`: the ticket identifier from the candidate id.',
  '- `<requested-value>`: the figure the candidate or the runbook names.',
  '- `<reply-channel>` and `<reply-thread>`: from the Reply target line, when present.',
  '- `<originating-surface>`: where the ticket lives.',
  '',
  '## Procedure',
  '1. Fill `Pipeline coverage` with `<requested-value>` and click `Save`.',
  '2. Comment on `<record-id>` with the audit line `Last updated by <user> at <time> UTC`.',
  '',
  '## Verification',
  'The snapshot shows the audit line and `<requested-value>`.',
].join('\n');

const candidate: WorkCandidate = {
  sourceCategory: 'ticket-queue',
  sourceSystem: 'linear',
  externalId: 'REVOPS-11',
  title: 'Refresh the Looker pipeline tile',
  contentSummary: 'Set the pipeline coverage figure to 68%.',
  contentRefs: ['ticket://REVOPS-11'],
  observedAt: new Date('2026-09-15T01:00:00.000Z'),
  priority: 'P1',
  requesterLabel: 'Manager',
};

describe('skill input placeholders', (): void => {
  it('reads two-or-more-word angle-bracket names and ignores runbook prose brackets', (): void => {
    expect(skillInputPlaceholders(body)).toEqual([
      'record-id',
      'requested-value',
      'reply-channel',
      'reply-thread',
      'originating-surface',
    ]);
    expect(skillInputPlaceholders('Last updated by <user> at <time> UTC, <credential: stored>')).toEqual([]);
  });

  it('declares the inputs under the Inputs heading and nothing from other sections', (): void => {
    expect(declaredSkillInputs(body)).toEqual([
      'record-id',
      'requested-value',
      'reply-channel',
      'reply-thread',
      'originating-surface',
    ]);
    expect(declaredSkillInputs('# No inputs section\n<record-id>')).toBeUndefined();
    expect(declaredSkillInputs('## Inputs\n(none)\n## Procedure\n<record-id>')).toEqual([]);
  });

  it('names every placeholder used without a declaration', (): void => {
    expect(undeclaredSkillInputs(body)).toEqual([]);
    expect(undeclaredSkillInputs(`${body}\nAlso post to <audit-channel>.`)).toEqual(['audit-channel']);
    expect(undeclaredSkillInputs('# Bare\nComment on <record-id>.')).toEqual(['record-id']);
  });
});

describe('binding skill inputs from the candidate', (): void => {
  it('binds the record id and the originating surface, and defers the requested value to the executor', (): void => {
    const bindings = bindSkillInputs(body, candidate);
    expect(bindings).toEqual([
      { name: 'record-id', value: 'REVOPS-11', source: 'the candidate id' },
      {
        name: 'requested-value',
        source:
          'read it from the candidate body, its Refs line or the runbook for this run; the skill body carries no value for it',
      },
      { name: 'reply-channel', source: 'no Reply target line: the work did not come from a chat channel' },
      { name: 'reply-thread', source: 'no Reply target line: the work did not come from a chat channel' },
      { name: 'originating-surface', value: 'linear', source: 'the surface the work came from' },
    ]);
  });

  it('binds the reply channel and thread from the reply target', (): void => {
    const ask: WorkCandidate = {
      ...candidate,
      sourceSystem: 'slack',
      externalId: 'C0BSF04TZ19:1789000500.000200',
      replyTarget: { channel: 'C0BSF04TZ19', channelName: 'revops-asks', threadTs: '1789000500.000200' },
    };
    const bindings = bindSkillInputs(body, ask);
    expect(bindings.find((binding) => binding.name === 'reply-channel')).toEqual({
      name: 'reply-channel',
      value: 'C0BSF04TZ19',
      source: 'the Reply target line',
    });
    expect(bindings.find((binding) => binding.name === 'reply-thread')).toEqual({
      name: 'reply-thread',
      value: '1789000500.000200',
      source: 'the Reply target line',
    });
    const topLevel = bindSkillInputs(body, { ...ask, replyTarget: { channel: 'C0BSF04TZ19' } });
    expect(topLevel.find((binding) => binding.name === 'reply-thread')).toEqual({
      name: 'reply-thread',
      source: 'the Reply target line names a top-level post, so there is no thread',
    });
  });

  it('binds nothing for a body that declares no inputs', (): void => {
    expect(bindSkillInputs('Comment, then close.', candidate)).toEqual([]);
    expect(renderSkillInputs([])).toEqual([]);
  });

  it('renders a value line for a bound input and a source line for the rest', (): void => {
    expect(renderSkillInputs(bindSkillInputs(body, candidate))).toEqual([
      '  - <record-id> = REVOPS-11 (the candidate id)',
      '  - <requested-value>: read it from the candidate body, its Refs line or the runbook for this run; the skill body carries no value for it',
      '  - <reply-channel>: no Reply target line: the work did not come from a chat channel',
      '  - <reply-thread>: no Reply target line: the work did not come from a chat channel',
      '  - <originating-surface> = linear (the surface the work came from)',
    ]);
  });
});
