import type { UIMessage, UIMessageChunk } from 'ai';
import { DAY_ONE_TOPIC_SPECS } from './day-one-prompts';

/** Prompts the agent's opening turn. Not the boss speaking, and never rendered. */
export const INIT_PROMPT = '__init__';

/** How many times one turn is put to the model before an empty answer stands. */
const TURN_ATTEMPTS = 2;

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; text: string }).text)
    .join('');
}

/**
 * Count the manager's replies: the turns in which the manager answered
 * something the agent had said.
 *
 * The priming turn is not one, and neither is a second message sent in a row
 * (the 19 Sep run's manager answered twice under an empty agent turn): a reply
 * needs a spoken agent turn directly before it.
 *
 * Args:
 *   messages: The chat room's history as it posts it, priming turn included.
 *
 * Returns:
 *   The number of question-and-answer exchanges the 1:1 has completed.
 */
export function managerReplies(messages: UIMessage[]): number {
  let replies = 0;
  messages.forEach((message, i) => {
    const text = textOf(message).trim();
    if (message.role !== 'user' || !text || text === INIT_PROMPT) return;
    const before = messages[i - 1];
    if (before?.role === 'assistant' && textOf(before).trim()) replies += 1;
  });
  return replies;
}

/**
 * Whether a turn puts a question to the manager. A question the turn only
 * quotes ("I have noted "who owns the tile?" as open") is not one, or a model
 * that reads the open questions back could never close.
 */
function asksSomething(text: string): boolean {
  const unquoted = text.replace(/"[^"]*"|“[^”]*”|`[^`]*`/g, '');
  return /[?？]/.test(unquoted);
}

function isToolChunk(chunk: UIMessageChunk): boolean {
  return chunk.type.startsWith('tool-');
}

/** A chunk the manager would see: words, a tool call, or an error line. */
function carriesContent(chunk: UIMessageChunk): boolean {
  if (chunk.type === 'text-delta') return chunk.delta.trim() !== '';
  return isToolChunk(chunk) || chunk.type === 'error';
}

async function* chunksOf(stream: ReadableStream<UIMessageChunk>): AsyncGenerator<UIMessageChunk> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Hold `dayOneComplete` to the one place it belongs: after the manager has
 * answered topic 7.
 *
 * On 19 Sep a model asked topic 7 and closed in the same turn, so the charter's
 * open questions were its own. A close is honoured only when every topic has had
 * a reply (seven exchanges, one per topic at the least) and the closing turn
 * itself asks nothing. Otherwise the tool call is dropped and the turn stands
 * as the question; a turn left with no question gets the scripted one for the
 * next topic, so the manager is never handed a turn with nothing to answer.
 *
 * Nothing is held until a tool chunk arrives, and a turn that is honoured is
 * released in the order it came, so every other turn is the SDK's bytes.
 *
 * Args:
 *   chunks: One attempt's UI message chunks.
 *   replies: `managerReplies` of the history this turn answers.
 *
 * Yields:
 *   The same chunks, less a close the 1:1 has not earned.
 */
async function* withEarnedClose(
  chunks: AsyncGenerator<UIMessageChunk>,
  replies: number,
): AsyncGenerator<UIMessageChunk> {
  let said = '';
  let held: UIMessageChunk[] | null = null;
  let dropped = false;

  function* release(stepFinished: boolean): Generator<UIMessageChunk> {
    const pending = held ?? [];
    held = null;
    if (replies >= DAY_ONE_TOPIC_SPECS.length && !asksSomething(said)) {
      yield* pending;
      return;
    }
    dropped = true;
    const kept = pending.filter((chunk) => !isToolChunk(chunk));
    if (!stepFinished || asksSomething(said)) {
      yield* kept;
      return;
    }
    const question = DAY_ONE_TOPIC_SPECS[Math.min(replies, DAY_ONE_TOPIC_SPECS.length - 1)].question;
    // The model's own last text part takes the question, so it reads on from
    // what was said; a turn with no words gets a part of its own.
    const lastTextEnd = kept.findLastIndex((chunk) => chunk.type === 'text-end');
    const stepEnd = kept.length - 1;
    const ending = kept[lastTextEnd];
    if (ending?.type === 'text-end') {
      yield* kept.slice(0, lastTextEnd);
      yield { type: 'text-delta', id: ending.id, delta: said.trim() ? `\n\n${question}` : question };
      yield* kept.slice(lastTextEnd);
      return;
    }
    const id = 'day-one-question';
    yield* kept.slice(0, stepEnd);
    yield { type: 'text-start', id };
    yield { type: 'text-delta', id, delta: question };
    yield { type: 'text-end', id };
    yield* kept.slice(stepEnd);
  }

  for await (const chunk of chunks) {
    if (chunk.type === 'text-delta') said += chunk.delta;
    if (held === null) {
      if (isToolChunk(chunk)) {
        held = [chunk];
      } else if (chunk.type === 'finish' && dropped) {
        yield { ...chunk, finishReason: 'stop' };
      } else {
        yield chunk;
      }
      continue;
    }
    held.push(chunk);
    if (chunk.type === 'finish-step') yield* release(true);
  }
  if (held !== null) yield* release(false);
}

/**
 * One turn of the Day-1 1:1 as the chat room receives it.
 *
 * A provider stall on 19 Sep came back as a 200 whose stream carried `start`,
 * `start-step`, `finish-step`, `finish` and nothing else, twice in one 1:1. A
 * turn that ends having said nothing and called nothing is put to the model
 * once more before it is answered; the first attempt's framing is withheld
 * until it says something, so the chat room sees one message either way. A turn
 * the deadline cut is not asked again: there is no time left to ask in.
 *
 * Args:
 *   attempt: Starts one model call and returns its UI message chunks.
 *   replies: `managerReplies` of the history this turn answers.
 *   signal: The route's deadline and the caller's disconnect.
 *
 * Returns:
 *   The stream to hand to `createUIMessageStreamResponse`.
 */
export function dayOneTurnStream({
  attempt,
  replies,
  signal,
}: {
  attempt: () => ReadableStream<UIMessageChunk>;
  replies: number;
  signal: AbortSignal;
}): ReadableStream<UIMessageChunk> {
  async function* turn(): AsyncGenerator<UIMessageChunk> {
    for (let n = 1; n <= TURN_ATTEMPTS; n += 1) {
      const framing: UIMessageChunk[] = [];
      let spoke = false;
      for await (const chunk of withEarnedClose(chunksOf(attempt()), replies)) {
        if (spoke) {
          yield chunk;
          continue;
        }
        framing.push(chunk);
        if (carriesContent(chunk)) {
          spoke = true;
          yield* framing;
        }
      }
      if (spoke) return;
      const cut = signal.aborted || framing.some((chunk) => chunk.type === 'abort');
      if (n === TURN_ATTEMPTS || cut) {
        yield* framing;
        return;
      }
    }
  }

  const chunks = turn();
  return new ReadableStream<UIMessageChunk>({
    async pull(controller): Promise<void> {
      const { done, value } = await chunks.next();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    async cancel(): Promise<void> {
      await chunks.return(undefined);
    },
  });
}
