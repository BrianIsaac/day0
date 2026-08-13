'use client';

import { useEffect, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

/** Prompts the agent's opening turn. Not the boss speaking, and never rendered. */
const INIT_PROMPT = '__init__';

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
  const { messages, sendMessage, status } = useChat({
    transport,
    onError: (err) => {
      // OpenAI 503s and similar transient failures land here. The hook
      // sets status back to 'ready' so the input unlocks; surface the
      // error to the boss so they know to retry their last turn.
      setStreamError(err.message ?? 'agent unavailable — please retry');
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
  const composerDisabled = status !== 'ready' || done || !opened;

  function send() {
    const trimmed = draft.trim();
    if (!trimmed || composerDisabled) return;
    sendMessage({ text: trimmed });
    setDraft('');
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
        {streamError ? (
          <div className="text-[var(--color-warn)] text-xs italic">
            {streamError} — re-send your last message to retry.
          </div>
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
              {(part as { type: 'text'; text: string }).text}
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
