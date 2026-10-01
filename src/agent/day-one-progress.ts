import type { UIMessageChunk } from 'ai';
import type { DayOneTopic } from './charter';
import { DAY_ONE_TOPIC_SPECS } from './day-one-prompts';

/** How many questions the Day-1 one-to-one asks, one per topic. */
export const DAY_ONE_TOPIC_COUNT = DAY_ONE_TOPIC_SPECS.length;

/** Each topic as the progress line names it, in the manager's words. */
export const DAY_ONE_TOPIC_TITLES: Readonly<Record<DayOneTopic, string>> = {
  'why-this-hire': 'Why this hire',
  'role-and-goals': 'The role itself',
  collaborators: 'Who to talk to',
  reading: 'What to read',
  tools: 'Where work lives',
  immediate: 'Anything immediate',
  'open-questions': 'Anything else',
};

/**
 * The title of the question at an index (from 0, held to the seven), read from the one-to-one's
 * own topic list. Client code reads titles here and never from `./charter`, whose synthesiser
 * pulls the model client into the browser bundle.
 */
export function topicTitle(topicIndex: number): string {
  const index = Math.max(0, Math.min(Math.floor(topicIndex), DAY_ONE_TOPIC_COUNT - 1));
  return DAY_ONE_TOPIC_TITLES[DAY_ONE_TOPIC_SPECS[index].topic];
}

/**
 * What the one-to-one's counter says for the question at an index (from 0, held to the seven):
 * "Question n of 7". It counts the questions the employee has put, which is what the close gate
 * counts (`topicIndexOf`) and the question the turn is told to ask (`dayOneTurnNote`). It names
 * no topic, which the employee is asked never to announce (the round review's r2).
 */
export function questionLine(topicIndex: number): string {
  const index = Math.max(0, Math.min(Math.floor(topicIndex), DAY_ONE_TOPIC_COUNT - 1));
  return `Question ${index + 1} of ${DAY_ONE_TOPIC_COUNT}`;
}

/** What the chat route says about a turn beside its words: the question it is on, from 0. */
export interface DayOneTurnMetadata {
  readonly topicIndex: number;
}

/**
 * The question a turn is on, from the replies the manager has given before it.
 *
 * This is the close gate's own count (`withEarnedClose` honours `dayOneComplete` only after seven
 * replies, and puts the scripted question for this index when a turn asks nothing), so the
 * progress line and the gate never disagree: the seventh segment lights exactly when the 1:1 may
 * close. It is also the question the turn is told to ask (`dayOneTurnNote`), so the count is the
 * question asked, not an estimate of it.
 *
 * @param replies - `managerReplies` of the history the turn answers.
 */
export function topicIndexOf(replies: number): number {
  return Math.max(0, Math.min(Math.floor(replies), DAY_ONE_TOPIC_COUNT - 1));
}

/** The metadata a turn carries, when the value is that shape; anything else reads as none. */
export function dayOneTurnMetadataOf(value: unknown): DayOneTurnMetadata | undefined {
  if (typeof value !== 'object' || value === null || !('topicIndex' in value)) return undefined;
  const { topicIndex } = value;
  return typeof topicIndex === 'number' &&
    Number.isInteger(topicIndex) &&
    topicIndex >= 0 &&
    topicIndex < DAY_ONE_TOPIC_COUNT
    ? { topicIndex }
    : undefined;
}

/**
 * Put the turn's question on its `start` chunk as message metadata, which the chat room reads
 * off the message it builds. Every other chunk passes through as it came.
 *
 * @param stream - One turn's UI message chunks.
 * @param topicIndex - The question the turn is on (`topicIndexOf`).
 */
export function withTopicIndex(
  stream: ReadableStream<UIMessageChunk>,
  topicIndex: number,
): ReadableStream<UIMessageChunk> {
  const metadata: DayOneTurnMetadata = { topicIndex };
  return stream.pipeThrough(
    new TransformStream<UIMessageChunk, UIMessageChunk>({
      transform(chunk, controller): void {
        controller.enqueue(
          chunk.type === 'start' ? { ...chunk, messageMetadata: metadata } : chunk,
        );
      },
    }),
  );
}
