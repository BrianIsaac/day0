import type { UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import {
  ANSWER_NOT_KEPT,
  keptAnswer,
  type EmployeeAnswer,
  type KeepAnswer,
} from '../../../src/agent/kept-answer';

function streamOf(chunks: readonly UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream<UIMessageChunk>({
    start(controller): void {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

/** A keeper that records what it kept, and the chunks the room had been sent when it did. */
function keeper(answer: (kept: EmployeeAnswer) => Promise<string | null> = async () => null): {
  keep: KeepAnswer;
  kept: EmployeeAnswer[];
} {
  const kept: EmployeeAnswer[] = [];
  return {
    kept,
    keep: async (offered: EmployeeAnswer): Promise<string | null> => {
      kept.push(offered);
      return await answer(offered);
    },
  };
}

const QUESTION: UIMessageChunk[] = [
  { type: 'start' },
  { type: 'start-step' },
  { type: 'text-start', id: 't' },
  { type: 'text-delta', id: 't', delta: 'Who should ' },
  { type: 'text-delta', id: 't', delta: 'I meet?' },
  { type: 'text-end', id: 't' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

describe('an employee turn kept as it finishes', (): void => {
  it('is kept before the room hears it finished, under the id the room draws it with', async (): Promise<void> => {
    const { keep, kept } = keeper();
    const chunks = await read(
      keptAnswer(streamOf(QUESTION), { messageId: 'turn-9', topicIndex: 2, keep }),
    );
    expect(kept).toEqual([{ id: 'turn-9', text: 'Who should I meet?', topicIndex: 2 }]);
    expect(chunks[0]).toEqual({ type: 'start', messageId: 'turn-9' });
    // The finish tells the room the session holds the turn it drew.
    expect(chunks.at(-1)).toEqual({
      type: 'finish',
      finishReason: 'stop',
      messageMetadata: { kept: true },
    });
    expect(chunks.map((chunk) => chunk.type)).toEqual(QUESTION.map((chunk) => chunk.type));
  });

  it('keeps the question number the finish already carried beside the kept mark', async (): Promise<void> => {
    const { keep } = keeper();
    const chunks = await read(
      keptAnswer(
        streamOf([
          ...QUESTION.slice(0, -1),
          { type: 'finish', finishReason: 'stop', messageMetadata: { topicIndex: 2 } },
        ]),
        { messageId: 'turn-9', topicIndex: 2, keep },
      ),
    );
    expect(chunks.at(-1)).toMatchObject({ messageMetadata: { topicIndex: 2, kept: true } });
  });

  it('keeps the closing line of a turn that closes the one-to-one', async (): Promise<void> => {
    const { keep, kept } = keeper();
    await read(
      keptAnswer(
        streamOf([
          { type: 'start' },
          {
            type: 'tool-input-available',
            toolCallId: 'call_close',
            toolName: 'dayOneComplete',
            input: { closingLine: 'Thanks, drafting now.' },
          },
          { type: 'finish', finishReason: 'tool-calls' },
        ]),
        { messageId: 'turn-15', topicIndex: 6, keep },
      ),
    );
    expect(kept).toEqual([
      { id: 'turn-15', text: '', topicIndex: 6, closingLine: 'Thanks, drafting now.' },
    ]);
  });

  it('keeps nothing for a turn that failed, was cut off or carried an error', async (): Promise<void> => {
    const { keep, kept } = keeper();
    const empty: UIMessageChunk[] = [{ type: 'start' }, { type: 'finish', finishReason: 'stop' }];
    const cut = QUESTION.slice(0, -1);
    const budget: UIMessageChunk[] = [
      ...QUESTION.slice(0, -1),
      { type: 'finish', finishReason: 'length' },
    ];
    const errored: UIMessageChunk[] = [
      ...QUESTION.slice(0, -1),
      { type: 'error', errorText: 'provider 503' },
      { type: 'finish', finishReason: 'stop' },
    ];
    for (const chunks of [empty, cut, budget, errored]) {
      await read(keptAnswer(streamOf(chunks), { messageId: 'x', topicIndex: 1, keep }));
    }
    expect(kept).toEqual([]);
  });

  it('tells the room when the session would not keep the answer, before the finish', async (): Promise<void> => {
    const { keep } = keeper(async () => 'The one-to-one moved on in another window.');
    const chunks = await read(
      keptAnswer(streamOf(QUESTION), { messageId: 'turn-9', topicIndex: 2, keep }),
    );
    expect(chunks.slice(-2)).toEqual([
      { type: 'error', errorText: 'The one-to-one moved on in another window.' },
      { type: 'finish', finishReason: 'stop' },
    ]);
  });

  it("says a keep that failed outright as not kept, never with the server's own message (review m5)", async (): Promise<void> => {
    const { keep } = keeper(async () => {
      throw new Error('fetch failed');
    });
    const chunks = await read(
      keptAnswer(streamOf(QUESTION), { messageId: 'turn-9', topicIndex: 2, keep }),
    );
    expect(chunks.at(-2)).toEqual({ type: 'error', errorText: ANSWER_NOT_KEPT });
    // A turn the session did not keep carries no kept mark.
    expect(chunks.at(-1)).toEqual({ type: 'finish', finishReason: 'stop' });
  });
});
