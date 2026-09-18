import type { UIMessageChunk } from 'ai';

/** Prompts the agent's opening turn. Not the boss speaking, and never rendered. */
export const INIT_PROMPT = '__init__';

/** How many times one turn is put to the model before an empty answer stands. */
const TURN_ATTEMPTS = 2;

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
 *   signal: The route's deadline and the caller's disconnect.
 *
 * Returns:
 *   The stream to hand to `createUIMessageStreamResponse`.
 */
export function dayOneTurnStream({
  attempt,
  signal,
}: {
  attempt: () => ReadableStream<UIMessageChunk>;
  signal: AbortSignal;
}): ReadableStream<UIMessageChunk> {
  async function* turn(): AsyncGenerator<UIMessageChunk> {
    for (let n = 1; n <= TURN_ATTEMPTS; n += 1) {
      const framing: UIMessageChunk[] = [];
      let spoke = false;
      for await (const chunk of chunksOf(attempt())) {
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
