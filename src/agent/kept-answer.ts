import type { UIMessageChunk } from 'ai';
import { answerFailure, withKeptMark } from './one-to-one-conversation';
import { errorMessage } from '../lib/errors';

/** An employee turn that stood, as the session keeps it. */
export interface EmployeeAnswer {
  readonly id: string;
  readonly text: string;
  readonly topicIndex: number;
  /** Present when the turn closed the one-to-one. */
  readonly closingLine?: string;
}

/**
 * Keep an answer on the session. Resolves to null once it is kept, or to the sentence the room
 * shows when the session would not keep it; a rejection is said the same way.
 */
export type KeepAnswer = (answer: EmployeeAnswer) => Promise<string | null>;

/** What the room is told when the answer it was shown could not be kept. */
export const ANSWER_NOT_KEPT = 'Day0 could not keep that answer';

/** What `keptAnswer` needs beside the stream. */
export interface KeptAnswerOptions {
  /** The id the room draws the turn under, which the session keeps it under too. */
  readonly messageId: string;
  /** The question the turn is on (`topicIndexOf`). */
  readonly topicIndex: number;
  readonly keep: KeepAnswer;
}

/**
 * Keep one employee turn on the session as it finishes, before the room hears that it did.
 *
 * The turn is streamed to the room as it comes; its `start` carries the id the session will keep
 * it under, so a reopened room draws the same turn. Its `finish` is held back until the turn is
 * kept: a room that saw a turn finish may be closed at once, and the answer must be on the server
 * by then. A turn that fails (`answerFailure`) or is cut off is not kept, so a reopened room asks
 * for it again, as Ask again does. When keeping fails, the room is told with an error chunk and
 * offers Ask again. A kept turn's `finish` carries the kept mark (`withKeptMark`), so the room
 * knows which of the answers it drew the session holds.
 *
 * @param stream - One turn's UI message chunks, the close already gated (`dayOneTurnStream`).
 * @returns The same chunks, the start carrying the id and the finish after the keep.
 */
export function keptAnswer(
  stream: ReadableStream<UIMessageChunk>,
  options: KeptAnswerOptions,
): ReadableStream<UIMessageChunk> {
  let text = '';
  let closingLine: string | undefined;
  let finish: Extract<UIMessageChunk, { type: 'finish' }> | undefined;
  let broken = false;

  async function keep(): Promise<string | null> {
    try {
      return await options.keep({
        id: options.messageId,
        text,
        topicIndex: options.topicIndex,
        ...(closingLine === undefined ? {} : { closingLine }),
      });
    } catch (err: unknown) {
      return `${ANSWER_NOT_KEPT}: ${errorMessage(err)}`;
    }
  }

  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller): void {
        // Only these chunks matter to what is kept; every other one passes through as it came.
        if (chunk.type === 'start') {
          controller.enqueue({ ...chunk, messageId: options.messageId });
          return;
        }
        if (chunk.type === 'finish') {
          finish = chunk;
          return;
        }
        if (chunk.type === 'text-delta') text += chunk.delta;
        else if (chunk.type === 'tool-input-available' && chunk.toolName === 'dayOneComplete') {
          closingLine = closingLineOf(chunk.input);
        } else if (chunk.type === 'error' || chunk.type === 'abort') broken = true;
        controller.enqueue(chunk);
      },
      async flush(controller): Promise<void> {
        if (!finish) return;
        const failure = answerFailure({
          text,
          closed: closingLine !== undefined,
          finishReason: finish.finishReason,
        });
        if (broken || failure !== null) {
          controller.enqueue(finish);
          return;
        }
        const refusal = await keep();
        if (refusal !== null) {
          controller.enqueue({ type: 'error', errorText: refusal });
          controller.enqueue(finish);
          return;
        }
        // The room reads this mark off the turn: the session holds it (`isKeptAnswer`).
        controller.enqueue({ ...finish, messageMetadata: withKeptMark(finish.messageMetadata) });
      },
    }),
  );
}

/** The closing line a `dayOneComplete` call carried; a call without one closes with no words. */
function closingLineOf(input: unknown): string {
  if (typeof input !== 'object' || input === null || !('closingLine' in input)) return '';
  return typeof input.closingLine === 'string' ? input.closingLine : '';
}
