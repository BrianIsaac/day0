'use client';

import { useEffect, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type UIMessage } from 'ai';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

export function ChatRoom({ agentId, bossLabel }: { agentId: Id<'agents'>; bossLabel: string }) {
  const startSession = useMutation(api.voice.start);
  const [draft, setDraft] = useState('');
  const [synthFired, setSynthFired] = useState(false);

  const transport = new DefaultChatTransport({
    api: '/api/voice/chat',
    body: { bossLabel },
  });

  const [streamError, setStreamError] = useState<string | null>(null);
  const { messages, sendMessage, status, error } = useChat({
    transport,
    onError: (err) => {
      // OpenAI 503s and similar transient failures land here. The hook
      // sets status back to 'ready' so the input unlocks; surface the
      // error to the boss so they know to retry their last turn.
      setStreamError(err.message ?? 'agent unavailable — please retry');
    },
  });

  // Kick the agent's opening turn once the voice session row is created.
  useEffect(() => {
    let cancelled = false;
    startSession({ agentId, mode: 'chat' }).then(() => {
      if (!cancelled) sendMessage({ text: '__init__' });
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const done = messages.some((m) => m.parts.some((p) => p.type === 'tool-dayOneComplete'));

  // Fire charter synthesis once the agent emits the dayOneComplete tool.
  useEffect(() => {
    if (!done || synthFired) return;
    setSynthFired(true);
    const transcript = messages
      .map((m) => {
        const text = m.parts
          .filter((p) => p.type === 'text')
          .map((p) => (p as { type: 'text'; text: string }).text)
          .join('');
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
      body: JSON.stringify({ agentId, bossLabel, transcript }),
    });
  }, [done, synthFired, messages, agentId, bossLabel]);

  function send() {
    const trimmed = draft.trim();
    if (!trimmed || status !== 'ready' || done) return;
    sendMessage({ text: trimmed });
    setDraft('');
  }

  return (
    <section className="bg-[var(--color-card)] border border-[var(--color-accent)]/40 rounded-xl flex flex-col h-[28rem]">
      <header className="px-4 py-3 border-b border-[var(--color-border)] flex items-center justify-between">
        <h2 className="text-sm font-semibold">Day-1 1:1 · chat mode</h2>
        <span className="text-[10px] text-[var(--color-muted)]">GPT-5.5 · streaming</span>
      </header>
      <div className="flex-1 overflow-y-auto p-4 space-y-3 text-sm">
        {messages
          .filter((m) => !(m.role === 'user' && m.id === messages[0]?.id))
          .map((m) => (
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
          disabled={status !== 'ready' || done}
          placeholder={done ? 'conversation complete' : 'type your reply…'}
          className="flex-1 px-3 py-2 rounded-lg bg-[var(--color-bg)] border border-[var(--color-border)] focus:outline-none focus:border-[var(--color-accent)] text-sm disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={status !== 'ready' || done || !draft.trim()}
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
