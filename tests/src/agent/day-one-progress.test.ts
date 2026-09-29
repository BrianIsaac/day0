import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  DAY_ONE_TOPIC_COUNT,
  DAY_ONE_TOPIC_TITLES,
  dayOneTurnMetadataOf,
  topicIndexOf,
  topicTitle,
  withTopicIndex,
} from '../../../src/agent/day-one-progress';
import { DAY_ONE_TOPICS } from '../../../src/agent/charter';

async function chunksOf(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const out: UIMessageChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

describe('the one-to-one progress', (): void => {
  it('counts seven questions and names each topic', (): void => {
    expect(DAY_ONE_TOPIC_COUNT).toBe(7);
    expect(DAY_ONE_TOPICS.map((topic) => DAY_ONE_TOPIC_TITLES[topic])).toEqual([
      'Why this hire',
      'The role itself',
      'Who to talk to',
      'What to read',
      'Where work lives',
      'Anything immediate',
      'Anything else',
    ]);
  });

  it("names the question at an index from the one-to-one's own topics, held to the seven", (): void => {
    expect(topicTitle(0)).toBe('Why this hire');
    expect(topicTitle(6)).toBe('Anything else');
    expect(topicTitle(9)).toBe('Anything else');
    expect(topicTitle(-2)).toBe('Why this hire');
  });

  it('puts a turn on the question after the replies given, never past the seventh', (): void => {
    expect([0, 1, 6, 7, 12, -1].map(topicIndexOf)).toEqual([0, 1, 6, 6, 6, 0]);
  });

  it('reads the metadata the route sends and nothing else', (): void => {
    expect(dayOneTurnMetadataOf({ topicIndex: 4 })).toEqual({ topicIndex: 4 });
    for (const value of [undefined, null, 'x', {}, { topicIndex: 7 }, { topicIndex: 1.5 }]) {
      expect(dayOneTurnMetadataOf(value)).toBeUndefined();
    }
  });

  it('puts the index on the start chunk and passes every other chunk as it came', async (): Promise<void> => {
    const chunks: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Why this hire?' },
      { type: 'text-end', id: '0' },
      { type: 'finish', finishReason: 'stop' },
    ];
    const stream = new ReadableStream<UIMessageChunk>({
      start(controller): void {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    });
    expect(await chunksOf(withTopicIndex(stream, 2))).toEqual([
      { type: 'start', messageMetadata: { topicIndex: 2 } },
      ...chunks.slice(1),
    ]);
  });
});
