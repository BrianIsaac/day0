import type { UIMessage } from 'ai';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  NOTED_MAX_CHARS,
  NotedSoFar,
  WhatThisBecomes,
  notedAnswers,
} from '../../../../../app/agent/[agentId]/one-to-one/NotedSoFar';
import { INIT_PROMPT } from '../../../../../src/agent/day-one-turn';

function turn(role: UIMessage['role'], text: string, topicIndex?: number): UIMessage {
  return {
    id: `${role}-${text.length}`,
    role,
    parts: [{ type: 'text', text }],
    ...(topicIndex === undefined ? {} : { metadata: { topicIndex } }),
  } as UIMessage;
}

describe('what the one-to-one has noted', (): void => {
  it('puts each answer under the question the route numbered before it', (): void => {
    expect(
      notedAnswers([
        turn('user', INIT_PROMPT),
        turn('assistant', 'Why this hire?', 0),
        turn('user', 'Tier-2 asks swamp the close.'),
        turn('user', 'And the audit.'),
        turn('assistant', 'Who should I meet?'),
        turn('user', 'Priya.'),
      ]),
    ).toEqual([
      { topic: 'Why this hire', text: 'Tier-2 asks swamp the close.' },
      { topic: null, text: 'Priya.' },
    ]);
  });

  it('cuts a long answer at a word and marks the cut', (): void => {
    const long = `${'word '.repeat(60)}end`;
    const [answer] = notedAnswers([turn('assistant', 'Why?', 0), turn('user', long)]);
    expect(answer.text.length).toBeLessThanOrEqual(NOTED_MAX_CHARS + 1);
    expect(answer.text.endsWith('word…')).toBe(true);
  });

  it('lists the answers, and says where they will gather before there are any', (): void => {
    expect(renderToStaticMarkup(<NotedSoFar answers={[]} />)).toContain(
      'Nothing yet: your answers gather here.',
    );
    const html = renderToStaticMarkup(
      <NotedSoFar answers={[{ topic: 'Why this hire', text: 'The close.' }]} />,
    );
    expect(html).toContain('Noted so far');
    expect(html).toMatch(/<li><span[^>]*>Why this hire: <\/span>The close.<\/li>/);
    expect(renderToStaticMarkup(<WhatThisBecomes name="Mira" />)).toContain(
      'After the seventh answer Mira drafts a charter',
    );
  });
});
