import { describe, expect, it } from 'vitest';
import {
  credentialInputIssues,
  bindSkillInputs,
  declaredInputsNote,
  declaredSkillInputs,
  declareUndeclaredInputs,
  renderSkillInputs,
  skillInputPlaceholders,
  systemDeclaredInputs,
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

  it('accepts a list item or table row whose first token is the placeholder in any of the four forms', (): void => {
    const procedure = [
      '## Procedure',
      'Open <analytics-surface>, enter <requested-value>, comment on <record-id>, post to <reply-channel>.',
    ].join('\n');
    const listed = [
      '# Skill',
      '## Inputs',
      '- <analytics-surface>: the tile the work names.',
      '- `<requested-value>`: the figure the candidate names.',
      '- `record-id`: the ticket identifier from the candidate id.',
      '- reply-channel: the Reply target line.',
      procedure,
    ].join('\n');
    expect(declaredSkillInputs(listed)).toEqual([
      'analytics-surface',
      'requested-value',
      'record-id',
      'reply-channel',
    ]);
    expect(undeclaredSkillInputs(listed)).toEqual([]);

    const table = [
      '# Skill',
      '## Inputs',
      '| Input | Where the executor reads it |',
      '|---|---|',
      '| <analytics-surface> | the surface record |',
      '| `<requested-value>` | the candidate body |',
      '| `record-id` | the candidate id |',
      '| reply-channel | the Reply target line |',
      procedure,
    ].join('\n');
    expect(declaredSkillInputs(table)).toEqual([
      'analytics-surface',
      'requested-value',
      'record-id',
      'reply-channel',
    ]);
    expect(undeclaredSkillInputs(table)).toEqual([]);

    const numbered = ['# Skill', '## Inputs', '1. analytics-surface - the tile', '2) `record-id` the ticket', procedure].join('\n');
    expect(declaredSkillInputs(numbered)).toEqual(['analytics-surface', 'record-id']);
  });

  it('declares a bare or backticked name only when the body uses it as a placeholder, and only as the first token', (): void => {
    const unused = ['# Skill', '## Inputs', '- record-id: the ticket.', '- `audit-expectation`: the read-back.', '## Procedure', 'Comment on <record-id>.'].join('\n');
    expect(declaredSkillInputs(unused)).toEqual(['record-id']);

    const midLine = ['# Skill', '## Inputs', '- the surface analytics-surface: the tile.', '## Procedure', 'Open <analytics-surface>.'].join('\n');
    expect(declaredSkillInputs(midLine)).toEqual([]);
    expect(undeclaredSkillInputs(midLine)).toEqual(['analytics-surface']);

    const prose = ['# Skill', '## Inputs', 'analytics-surface is the tile.', '## Procedure', 'Open <analytics-surface>.'].join('\n');
    expect(undeclaredSkillInputs(prose)).toEqual(['analytics-surface']);

    const bracketUnused = ['# Skill', '## Inputs', '- <reply-thread>: the thread.', '## Procedure', 'Nothing varies.'].join('\n');
    expect(declaredSkillInputs(bracketUnused)).toEqual(['reply-thread']);
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
    expect(
      bindSkillInputs('## Inputs\n- record-id: the ticket.\n## Procedure\nComment on <record-id>.', candidate),
    ).toEqual([{ name: 'record-id', value: 'REVOPS-11', source: 'the candidate id' }]);
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

describe('declaring the inputs an author used but did not declare', (): void => {
  const body = [
    '# Close a ticket',
    '',
    '## Inputs',
    '',
    '- `<record-id>`: the candidate id.',
    '',
    '## Procedure',
    '',
    'Set `<record-id>` to `<closing-state>` and reply `<reply-text>`.',
  ].join('\n');

  it('adds one line per missing name after the last declaration, moving nothing else', (): void => {
    const repaired = declareUndeclaredInputs(body);

    expect(repaired.declared).toEqual(['closing-state', 'reply-text']);
    expect(repaired.body).toBe(
      [
        '# Close a ticket',
        '',
        '## Inputs',
        '',
        '- `<record-id>`: the candidate id.',
        '- `<closing-state>`: read it from the candidate body, its Refs line or the runbook for this run. Declared by Day0: the author used it without declaring it.',
        '- `<reply-text>`: read it from the candidate body, its Refs line or the runbook for this run. Declared by Day0: the author used it without declaring it.',
        '',
        '## Procedure',
        '',
        'Set `<record-id>` to `<closing-state>` and reply `<reply-text>`.',
      ].join('\n'),
    );
    expect(undeclaredSkillInputs(repaired.body)).toEqual([]);
    expect(declareUndeclaredInputs(repaired.body)).toEqual({ body: repaired.body, declared: [], credentials: [] });
  });

  it('marks each line it added, so whoever reads the body later can tell the system wrote it', (): void => {
    const repaired = declareUndeclaredInputs(body);

    expect(systemDeclaredInputs(body)).toEqual([]);
    expect(systemDeclaredInputs(repaired.body)).toEqual(['closing-state', 'reply-text']);
    // The marker survives a park, a refusal and a retry that keeps the line, because it is in the body.
    expect(systemDeclaredInputs(declareUndeclaredInputs(repaired.body).body)).toEqual(['closing-state', 'reply-text']);
    // An author that writes the binding words itself has declared the input itself.
    expect(systemDeclaredInputs(body.replace('the candidate id.', 'read it from the candidate body, its Refs line or the runbook for this run.'))).toEqual([]);
  });

  it('declares in a section that ends the body, and gives a body without one its own', (): void => {
    const last = '# Close\n\nUse `<record-id>` and `<closing-state>`.\n\n## Inputs\n- `<record-id>`: the id.\n';
    expect(declareUndeclaredInputs(last).body).toBe(
      '# Close\n\nUse `<record-id>` and `<closing-state>`.\n\n## Inputs\n- `<record-id>`: the id.\n' +
        '- `<closing-state>`: read it from the candidate body, its Refs line or the runbook for this run. Declared by Day0: the author used it without declaring it.\n',
    );
    const none = '# Close\n\nUse `<record-id>`.';
    const repaired = declareUndeclaredInputs(none);
    expect(repaired.body).toBe(
      '# Close\n\nUse `<record-id>`.\n\n## Inputs\n\n- `<record-id>`: read it from the candidate body, its Refs line or the runbook for this run. Declared by Day0: the author used it without declaring it.\n',
    );
    expect(declaredSkillInputs(repaired.body)).toEqual(['record-id']);
  });

  it('never declares a name that says it is a credential: the gate refuses it and says where a credential goes', (): void => {
    const withToken = `${body}\nSend \`<slack-bot-token>\` as the bearer and sign with \`<api-key>\`; keep \`<monkey-count>\`.`;
    const repaired = declareUndeclaredInputs(withToken);

    expect(repaired.declared).toEqual(['closing-state', 'reply-text', 'monkey-count']);
    expect(repaired.credentials).toEqual(['slack-bot-token', 'api-key']);
    expect(undeclaredSkillInputs(repaired.body)).toEqual(['slack-bot-token', 'api-key']);
    expect(credentialInputIssues(repaired.credentials)).toEqual([
      'SKILL.md uses `<slack-bot-token>` as an input; a credential is never an input the executor reads from a candidate: write `{{secret}}` where it goes and the server substitutes the stored credential',
      'SKILL.md uses `<api-key>` as an input; a credential is never an input the executor reads from a candidate: write `{{secret}}` where it goes and the server substitutes the stored credential',
    ]);
  });

  it('leaves a body with nothing missing exactly as it was', (): void => {
    const complete = body.replace('- `<record-id>`: the candidate id.', '- `<record-id>`, `<closing-state>`, `<reply-text>`: from the candidate.');
    expect(declareUndeclaredInputs(complete)).toEqual({ body: complete, declared: [], credentials: [] });
  });

  it('names what was declared in the log', (): void => {
    expect(declaredInputsNote(['reply-text'])).toBe(
      'SKILL.md used `<reply-text>` without declaring it; it was declared under `## Inputs` as read from the candidate or its runbook at execution',
    );
    expect(declaredInputsNote(['a-b', 'c-d', 'e-f'])).toBe(
      'SKILL.md used `<a-b>`, `<c-d>` and `<e-f>` without declaring them; each was declared under `## Inputs` as read from the candidate or its runbook at execution',
    );
  });
});

