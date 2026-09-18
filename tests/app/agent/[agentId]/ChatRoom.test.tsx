import { Chat } from '@ai-sdk/react';
import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  TurnFailureNotice,
  askAgain,
  composerLocked,
  emphasisSegments,
  turnFailure,
} from '../../../../app/agent/[agentId]/ChatRoom';
import { INIT_PROMPT } from '../../../../src/agent/day-one-turn';

describe('the Day-1 transcript bubble', (): void => {
  it('leaves plain prose as one segment', (): void => {
    expect(emphasisSegments('Understood. What do you see me doing day-to-day?')).toEqual([
      { text: 'Understood. What do you see me doing day-to-day?', strong: false },
    ]);
  });

  it('marks an emphasised label as strong and drops its markers', (): void => {
    expect(emphasisSegments('Three intros queued. **Topic 4:** what should I read first?')).toEqual([
      { text: 'Three intros queued. ', strong: false },
      { text: 'Topic 4:', strong: true },
      { text: ' what should I read first?', strong: false },
    ]);
  });

  it('handles several emphasised runs in one turn', (): void => {
    expect(emphasisSegments('**One** and **two**')).toEqual([
      { text: 'One', strong: true },
      { text: ' and ', strong: false },
      { text: 'two', strong: true },
    ]);
  });

  it('leaves an unclosed marker exactly as the model wrote it', (): void => {
    expect(emphasisSegments('a ** b')).toEqual([{ text: 'a ** b', strong: false }]);
  });

  it('keeps an empty pair of markers as literal text', (): void => {
    expect(emphasisSegments('a **** b')).toEqual([{ text: 'a **** b', strong: false }]);
  });

  it('preserves the newlines the bubble renders', (): void => {
    expect(emphasisSegments('Hi Brian.\n\n**First up:** why this hire?')).toEqual([
      { text: 'Hi Brian.\n\n', strong: false },
      { text: 'First up:', strong: true },
      { text: ' why this hire?', strong: false },
    ]);
  });
});

/** What `useChat` hands `onFinish`, cut down to what the chat room reads. */
function finished(
  parts: UIMessage['parts'],
  finishReason?: 'stop' | 'tool-calls',
): Parameters<typeof turnFailure>[0] {
  return {
    message: { id: 'a1', role: 'assistant', parts },
    isAbort: false,
    isError: false,
    finishReason,
  };
}

describe('a turn that ends with nothing to answer', (): void => {
  it('is a failure when the stream finished with no text and no tool call', (): void => {
    // The 19 Sep stream: start, start-step, finish-step, finish (stop).
    expect(turnFailure(finished([{ type: 'step-start' }], 'stop'))).toBe('Day0 returned nothing');
  });

  it('is a failure when the text is only whitespace', (): void => {
    expect(
      turnFailure(finished([{ type: 'step-start' }, { type: 'text', text: '\n\n' }], 'stop')),
    ).toBe('Day0 returned nothing');
  });

  it('is a failure when the stream ended without finishing, as the 60-second cut does', (): void => {
    expect(turnFailure(finished([{ type: 'step-start' }, { type: 'text', text: 'Under' }]))).toBe(
      'Day0 was cut off mid-reply',
    );
  });

  it('is not a failure when Day0 said something and finished', (): void => {
    expect(
      turnFailure(finished([{ type: 'text', text: 'Understood. Who should I meet?' }], 'stop')),
    ).toBeNull();
  });

  it('is not a failure when the turn only closes the 1:1', (): void => {
    const close = {
      type: 'tool-dayOneComplete',
      toolCallId: 'call_close',
      state: 'input-available',
      input: { closingLine: 'Drafting the charter.' },
    } as UIMessage['parts'][number];

    expect(turnFailure(finished([close], 'tool-calls'))).toBeNull();
  });

  it('leaves a stream error and a discarded send to their own paths', (): void => {
    expect(turnFailure({ ...finished([]), isError: true })).toBeNull();
    expect(turnFailure({ ...finished([]), isAbort: true })).toBeNull();
  });
});

describe('the composer', (): void => {
  it('is locked while Day0 is answering, before it has opened, and once the 1:1 is done', (): void => {
    expect(composerLocked({ status: 'streaming', done: false, opened: true })).toBe(true);
    expect(composerLocked({ status: 'submitted', done: false, opened: true })).toBe(true);
    expect(composerLocked({ status: 'ready', done: false, opened: false })).toBe(true);
    expect(composerLocked({ status: 'ready', done: true, opened: true })).toBe(true);
  });

  it('is open after a stream error, which the SDK reports as its own status', (): void => {
    expect(composerLocked({ status: 'error', done: false, opened: true })).toBe(false);
  });
});

describe('the failure notice', (): void => {
  it('says what happened and offers Ask again', (): void => {
    const html = renderToStaticMarkup(
      <TurnFailureNotice failure="Day0 returned nothing" onAskAgain={() => undefined} />,
    );

    expect(html).toContain('Day0 returned nothing');
    expect(html).toMatch(/<button[^>]*>Ask again<\/button>/);
  });
});

/** A transport that answers each request with the next scripted chunk list. */
function scriptedTransport(replies: UIMessageChunk[][]): {
  transport: ChatTransport<UIMessage>;
  requests: UIMessage[][];
} {
  const requests: UIMessage[][] = [];
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages }) => {
      requests.push(structuredClone(messages));
      const chunks = replies[requests.length - 1];
      return new ReadableStream<UIMessageChunk>({
        start(controller): void {
          chunks.forEach((chunk) => controller.enqueue(chunk));
          controller.close();
        },
      });
    },
    reconnectToStream: async () => null,
  };
  return { transport, requests };
}

const EMPTY_TURN: UIMessageChunk[] = [
  { type: 'start' },
  { type: 'start-step' },
  { type: 'finish-step' },
  { type: 'finish', finishReason: 'stop' },
];

function spoken(text: string): UIMessageChunk[] {
  return [
    { type: 'start' },
    { type: 'start-step' },
    { type: 'text-start', id: '0' },
    { type: 'text-delta', id: '0', delta: text },
    { type: 'text-end', id: '0' },
    { type: 'finish-step' },
    { type: 'finish', finishReason: 'stop' },
  ];
}

const lastText = (messages: UIMessage[]): string =>
  messages
    .at(-1)!
    .parts.filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('');

describe('Ask again, against the SDK chat the room runs on', (): void => {
  it('re-sends the opening prompt after an empty opening turn', async (): Promise<void> => {
    const { transport, requests } = scriptedTransport([EMPTY_TURN, spoken('Welcome. Why this hire?')]);
    const failures: (string | null)[] = [];
    const chat = new Chat<UIMessage>({ transport, onFinish: (f) => failures.push(turnFailure(f)) });

    await chat.sendMessage({ text: INIT_PROMPT });

    expect(failures).toEqual(['Day0 returned nothing']);
    expect(chat.messages.some((m) => m.role === 'assistant')).toBe(false);

    await askAgain(chat);

    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(lastText(requests[1])).toBe(INIT_PROMPT);
    expect(failures).toEqual(['Day0 returned nothing', null]);
    expect(lastText(chat.messages)).toBe('Welcome. Why this hire?');
  });

  it('re-sends the last reply, without the half-said answer, after a cut', async (): Promise<void> => {
    const cut: UIMessageChunk[] = [
      { type: 'start' },
      { type: 'start-step' },
      { type: 'text-start', id: '0' },
      { type: 'text-delta', id: '0', delta: 'Under' },
      { type: 'abort' },
    ];
    const { transport, requests } = scriptedTransport([
      spoken('Why this hire?'),
      cut,
      spoken('Understood. Who should I meet?'),
    ]);
    const failures: (string | null)[] = [];
    const chat = new Chat<UIMessage>({ transport, onFinish: (f) => failures.push(turnFailure(f)) });

    await chat.sendMessage({ text: INIT_PROMPT });
    await chat.sendMessage({ text: 'The close is drowning the analysts.' });

    expect(failures.at(-1)).toBe('Day0 was cut off mid-reply');

    await askAgain(chat);

    expect(requests[2]).toEqual(requests[1]);
    expect(lastText(requests[2])).toBe('The close is drowning the analysts.');
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(lastText(chat.messages)).toBe('Understood. Who should I meet?');
  });

  it('sends the opening prompt when nothing was ever sent', async (): Promise<void> => {
    const { transport, requests } = scriptedTransport([spoken('Welcome. Why this hire?')]);
    const chat = new Chat<UIMessage>({ transport });

    await askAgain(chat);

    expect(lastText(requests[0])).toBe(INIT_PROMPT);
  });
});
