import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TopicProgress,
  topicProgressOf,
} from '../../../../../app/agent/[agentId]/one-to-one/TopicProgress';

describe('the topic progress line', (): void => {
  it('says which question it is and names no topic the employee may not be on, the ones before it done and the rest to come (review r2)', (): void => {
    expect(topicProgressOf({ kind: 'asking', topicIndex: 2 })).toEqual({
      line: 'Question 3 of 7',
      segments: ['done', 'done', 'now', 'next', 'next', 'next', 'next'],
    });
  });

  it('holds an index past either end to the seven questions', (): void => {
    expect(topicProgressOf({ kind: 'asking', topicIndex: 9 }).line).toBe('Question 7 of 7');
    expect(topicProgressOf({ kind: 'asking', topicIndex: -1 }).line).toBe('Question 1 of 7');
  });

  it('counts the answers once the one-to-one is over, and draws none lit before it opens', (): void => {
    expect(topicProgressOf({ kind: 'answered', count: 7 })).toEqual({
      line: '7 of 7 answered',
      segments: Array.from({ length: 7 }, () => 'done'),
    });
    expect(topicProgressOf({ kind: 'answered', count: 3 }).segments.join()).toBe(
      'done,done,done,next,next,next,next',
    );
    expect(topicProgressOf({ kind: 'waiting' })).toEqual({
      line: '7 questions, one at a time',
      segments: Array.from({ length: 7 }, () => 'next'),
    });
  });

  it('says the progress in words and hides the drawn line from assistive technology', (): void => {
    const html = renderToStaticMarkup(
      <TopicProgress progress={{ kind: 'asking', topicIndex: 0 }} />,
    );
    expect(html).toContain('>Question 1 of 7</p>');
    expect(html).toMatch(/<div aria-hidden="true"[^>]*data-topic-progress=""/);
    expect(html.match(/data-segment=/g)).toHaveLength(7);
  });
});

describe('the one-to-one in the browser bundle', (): void => {
  it('reads its topic titles without the charter synthesiser, which cannot enter the browser', (): void => {
    const sources = [
      'app/agent/[agentId]/ChatRoom.tsx',
      'app/agent/[agentId]/VoiceRoom.tsx',
      'app/agent/[agentId]/one-to-one/TopicProgress.tsx',
      'app/agent/[agentId]/one-to-one/NotedSoFar.tsx',
      'app/agent/[agentId]/one-to-one/DraftingNotice.tsx',
    ];
    for (const source of sources) {
      expect(readFileSync(source, 'utf8'), source).not.toMatch(
        /^import (?!type )[^;]*from '@\/agent\/charter';/m,
      );
    }
  });
});
