'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatStatus, type UIMessage } from 'ai';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { INIT_PROMPT } from '@/agent/day-one-turn';

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; text: string }).text)
    .join('');
}

/**
 * The conversation proper. The priming turn wears the boss's role, so the
 * extractor would otherwise be entitled to read it as something the boss said.
 * Recognised by its sentinel text rather than by its position: it is normally
 * first, but it is sent from an effect, and a reply typed before that effect
 * lands would take the first slot and be dropped in its place.
 */
function withoutPrimingTurn(messages: UIMessage[]): UIMessage[] {
  return messages.filter((m) => !(m.role === 'user' && textOf(m).trim() === INIT_PROMPT));
}

/**
 * Name what went wrong with a turn that ended without an error, if anything did.
 *
 * A provider stall reaches the room as a stream that finished having said
 * nothing and called nothing; the route's 60-second deadline reaches it as a
 * stream that stopped without its `finish` chunk, and a spent output budget as
 * a finish of `length`. The SDK reports both as an
 * ordinary `ready`, so on 19 Sep the first left the composer waiting for good
 * and the second left half a sentence standing as the answer.
 *
 * Args:
 *   turn: What `useChat` hands `onFinish`.
 *
 * Returns:
 *   The line to show above Ask again, or null for a turn that needs none. A
 *   stream error is `onError`'s, and an aborted send was discarded on purpose.
 */
export function turnFailure(turn: {
  message: UIMessage;
  isAbort: boolean;
  isError: boolean;
  finishReason?: string;
}): string | null {
  if (turn.isError || turn.isAbort) return null;
  const closed = turn.message.parts.some((p) => p.type === 'tool-dayOneComplete');
  if (!closed && !textOf(turn.message).trim()) return 'Day0 returned nothing';
  if (turn.finishReason === undefined || turn.finishReason === 'length') {
    return 'Day0 was cut off mid-reply';
  }
  return null;
}

/**
 * The line for a stream error. The route answers a failure it can name with
 * JSON, which the transport hands over as the error's message, braces and all.
 */
export function errorLine(err: Error): string {
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON: the message is the sentence.
  }
  return err.message || 'agent unavailable';
}

/**
 * Whether the composer refuses input. `error` is a status of its own in the
 * SDK, not a return to `ready`, and a failed turn is exactly when the manager
 * needs the composer back.
 */
export function composerLocked(state: {
  status: ChatStatus;
  done: boolean;
  opened: boolean;
}): boolean {
  const answering = state.status === 'submitted' || state.status === 'streaming';
  return answering || state.done || !state.opened;
}

/**
 * Put the failed turn to Day0 again: the last thing the manager said, or the
 * opening prompt when the manager has said nothing yet. `regenerate` drops a
 * half-said answer first, so it is neither sent back as history nor left on
 * the page.
 */
export async function askAgain(
  chat: Pick<UseChatHelpers<UIMessage>, 'messages' | 'regenerate' | 'sendMessage'>,
): Promise<void> {
  if (chat.messages.length === 0) await chat.sendMessage({ text: INIT_PROMPT });
  else await chat.regenerate();
}

export function TurnFailureNotice({
  failure,
  onAskAgain,
}: {
  failure: string;
  onAskAgain: () => void;
}) {
  return (
    <div role="alert" className="flex items-center gap-3 text-[var(--color-warn)] text-xs">
      <span className="italic">{failure.replace(/\.$/, '')}.</span>
      <button
        onClick={onAskAgain}
        className="px-2 py-1 rounded-md border border-[var(--color-warn)]/60 hover:bg-[var(--color-warn)]/10 font-medium"
      >
        Ask again
      </button>
    </div>
  );
}

export function ChatRoom({
  agentId,
  bossLabel,
  onSwitchMode,
}: {
  agentId: Id<'agents'>;
  bossLabel: string;
  onSwitchMode?: () => void;
}) {
  const startSession = useMutation(api.voice.start);
  const [draft, setDraft] = useState('');
  // A latch, not UI state — nothing renders off it, so a ref keeps the
  // once-only guard out of the render cycle.
  const synthFired = useRef(false);
  // The session this 1:1 belongs to, read by the finalisation post below. A ref
  // rather than state because the effect that posts must see the id the mount
  // effect obtained, not whatever a stale render closed over.
  const sessionRef = useRef<Id<'voiceSessions'> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const transport = new DefaultChatTransport({
    api: '/api/voice/chat',
    body: { bossLabel },
  });

  const [streamError, setStreamError] = useState<string | null>(null);
  const { messages, sendMessage, regenerate, status } = useChat({
    transport,
    onError: (err) => {
      // Provider 503s and similar transient failures land here, and the hook
      // parks at status 'error'. Surface it so the boss can ask again.
      setStreamError(errorLine(err));
    },
    onFinish: (turn) => {
      const failure = turnFailure(turn);
      if (failure) setStreamError(failure);
    },
  });

  // Kick the agent's opening turn once the session row exists. Strict Mode
  // invokes this twice and the discarded invocation cancels its own send, so one
  // mount asks one opening question. It still asks for a session twice, and any
  // remount asks again — `voice.start` answers all of them with the same row,
  // which is why nothing here has to be latched to keep the count at one.
  useEffect(() => {
    let cancelled = false;
    startSession({ agentId, mode: 'chat' }).then((started) => {
      sessionRef.current = started.sessionId;
      if (!cancelled) sendMessage({ text: INIT_PROMPT });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Pin transcript to the bottom on every token tick. `useChat` mutates
  // the messages array on every streamed chunk, so the dep covers both
  // new messages and updates to the in-flight assistant turn. RAF wraps
  // the call so layout has settled before we read scrollHeight.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  const done = messages.some((m) => m.parts.some((p) => p.type === 'tool-dayOneComplete'));

  // Fire charter synthesis once the agent emits the dayOneComplete tool.
  useEffect(() => {
    if (!done || synthFired.current) return;
    synthFired.current = true;
    const transcript = withoutPrimingTurn(messages)
      .map((m) => {
        const text = textOf(m);
        const closing = m.parts
          .filter((p) => p.type === 'tool-dayOneComplete')
          .map((p) => (p as { input?: { closingLine?: string } }).input?.closingLine ?? '')
          .join('');
        const body = [text, closing].filter(Boolean).join(' ');
        return `${m.role.toUpperCase()}: ${body}`;
      })
      .filter((line) => !line.endsWith(': '))
      .join('\n\n');
    void fetch('/api/onboarding/synthesise', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Naming the session is what ends it: the chat 1:1 goes through the same
      // claim-once finalisation as a call, so the row it opened reaches `done`
      // carrying its transcript, instead of sitting at `active` for good while
      // the charter it produced is on the page.
      body: JSON.stringify({ agentId, bossLabel, transcript, voiceSessionId: sessionRef.current }),
    });
  }, [done, messages, agentId, bossLabel]);

  // The opening turn is sent from an effect, so for a moment after mount the
  // composer is live with nothing yet asked. A reply typed into that gap arrives
  // ahead of the agent's own first turn and answers a question it has not put —
  // an error surfaces instead, because then there is nothing else to wait for.
  const opened = messages.some((m) => m.role === 'assistant') || !!streamError;
  const composerDisabled = composerLocked({ status, done, opened });

  function send() {
    const trimmed = draft.trim();
    if (!trimmed || composerDisabled) return;
    setStreamError(null);
    sendMessage({ text: trimmed });
    setDraft('');
  }

  function retryTurn() {
    setStreamError(null);
    void askAgain({ messages, regenerate, sendMessage });
  }

  return (
    <section className="bg-[var(--color-card)] border border-[var(--color-accent)]/40 rounded-xl flex flex-col h-[28rem]">
      <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <h2 className="text-sm font-semibold">Day-1 1:1 · chat mode</h2>
        <div className="flex items-center gap-3">
          {/* Said "streaming" whatever was happening, including after the
              conversation had closed and the charter was on the page. */}
          <span className="text-[10px] text-[var(--color-muted)]">
            {done
              ? 'complete'
              : status === 'streaming' || status === 'submitted'
                ? 'streaming'
                : 'ready'}
          </span>
          {onSwitchMode && !done ? (
            <button
              onClick={() => {
                if (
                  messages.length > 1 &&
                  !confirm('Switch to voice? The current chat will be discarded.')
                ) {
                  return;
                }
                onSwitchMode();
              }}
              className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-accent)] underline underline-offset-2"
            >
              switch to voice
            </button>
          ) : null}
        </div>
      </header>
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
        {withoutPrimingTurn(messages).map((m) => (
          <MessageBubble key={m.id} message={m} />
        ))}
        {status === 'submitted' || status === 'streaming' ? (
          <div className="text-[var(--color-muted)] text-xs">…</div>
        ) : null}
        {done ? (
          <div className="text-[var(--color-ok)] text-xs">
            conversation complete · drafting your charter…
          </div>
        ) : null}
        {streamError && !done ? (
          <TurnFailureNotice failure={streamError} onAskAgain={retryTurn} />
        ) : null}
      </div>
      <div className="border-t border-[var(--color-border)] p-2 flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          disabled={composerDisabled}
          placeholder={
            done ? 'conversation complete' : opened ? 'type your reply…' : 'waiting for Day0…'
          }
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] text-sm disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={composerDisabled || !draft.trim()}
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50 text-sm"
        >
          Send
        </button>
      </div>
    </section>
  );
}

/**
 * Split one turn into plain and emphasised runs.
 *
 * The bubble renders the model's text verbatim, and some models write the
 * topic label as `**Topic 4:**`. Terra's recorded run wrote none, so the
 * markers only became visible once another model was configured - and a judge
 * reads this transcript closely. Rendering the emphasis is model-agnostic and
 * changes nothing that is sent: the transcript the charter is synthesised from
 * is still the model's own text.
 *
 * Only a matched, non-empty `**…**` pair counts. An unclosed or empty marker is
 * kept exactly as written rather than guessed at.
 *
 * Args:
 *   text: One text part of a transcript message.
 *
 * Returns:
 *   Consecutive runs in order, each flagged as emphasised or not.
 */
export function emphasisSegments(text: string): { text: string; strong: boolean }[] {
  const segments: { text: string; strong: boolean }[] = [];
  let plain = '';
  let rest = text;
  const emphasised = /\*\*([^*]+?)\*\*/;
  for (let match = emphasised.exec(rest); match; match = emphasised.exec(rest)) {
    plain += rest.slice(0, match.index);
    if (plain) segments.push({ text: plain, strong: false });
    plain = '';
    segments.push({ text: match[1], strong: true });
    rest = rest.slice(match.index + match[0].length);
  }
  if (plain + rest) segments.push({ text: plain + rest, strong: false });
  return segments;
}

function MessageBubble({ message }: { message: UIMessage }) {
  return (
    <div className={message.role === 'user' ? 'text-right' : ''}>
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <div
              key={i}
              className={`inline-block max-w-[85%] px-3 py-2 rounded-lg whitespace-pre-wrap ${
                message.role === 'user'
                  ? 'bg-[var(--color-accent)]/20 text-[var(--color-accent)]'
                  : 'bg-[var(--color-bg)] border border-[var(--color-border)]'
              }`}
            >
              {emphasisSegments((part as { type: 'text'; text: string }).text).map((seg, s) =>
                seg.strong ? (
                  <strong key={s} className="font-semibold">
                    {seg.text}
                  </strong>
                ) : (
                  <span key={s}>{seg.text}</span>
                ),
              )}
            </div>
          );
        }
        if (part.type === 'tool-dayOneComplete') {
          const input = (part as { input?: { closingLine?: string } }).input;
          return (
            <div
              key={i}
              className="inline-block max-w-[85%] px-3 py-2 rounded-lg bg-[var(--color-ok)]/15 text-[var(--color-ok)] text-xs italic"
            >
              {input?.closingLine ?? '(closing)'}
            </div>
          );
        }
        return null;
      })}
    </div>
  );
}
