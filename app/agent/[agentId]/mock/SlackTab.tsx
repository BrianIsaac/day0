'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id, Doc } from '@convex/_generated/dataModel';

export function SlackTab({ agentId }: { agentId: Id<'agents'> }) {
  const channels = useQuery(api.mock.listChannels, { agentId });
  const [activeSlug, setActiveSlug] = useState<string | null>(null);

  useEffect(() => {
    if (channels && channels.length > 0 && !activeSlug) {
      setActiveSlug(channels[0].slug);
    }
  }, [channels, activeSlug]);

  const messages = useQuery(
    api.mock.listMessages,
    activeSlug ? { agentId, channelSlug: activeSlug } : 'skip',
  );

  const sortedMessages: Doc<'mockSlackMessages'>[] = useMemo(
    () => (messages ? [...messages].sort((a, b) => a.timestamp - b.timestamp) : []),
    [messages],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [sortedMessages.length]);

  if (!channels) return <div className="text-xs text-[var(--color-muted)]">loading slack…</div>;

  return (
    <div className="grid grid-cols-[12rem_1fr] gap-4 h-full">
      <aside className="border-r border-[var(--color-border)] pr-3 -mr-1 overflow-y-auto">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-2 mt-1">
          Channels
        </div>
        <ul className="space-y-1 text-xs">
          {channels
            .filter((c) => c.kind === 'channel')
            .map((c) => (
              <li key={c._id}>
                <button
                  onClick={() => setActiveSlug(c.slug)}
                  className={`w-full text-left px-2 py-1 rounded ${
                    c.slug === activeSlug
                      ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                      : 'text-[var(--color-fg)] hover:bg-[var(--color-bg)]'
                  }`}
                >
                  {c.displayName}
                </button>
              </li>
            ))}
        </ul>
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-2 mt-4">
          Direct messages
        </div>
        <ul className="space-y-1 text-xs">
          {channels
            .filter((c) => c.kind === 'dm')
            .map((c) => (
              <li key={c._id}>
                <button
                  onClick={() => setActiveSlug(c.slug)}
                  className={`w-full text-left px-2 py-1 rounded ${
                    c.slug === activeSlug
                      ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                      : 'text-[var(--color-fg)] hover:bg-[var(--color-bg)]'
                  }`}
                >
                  {c.displayName}
                </button>
              </li>
            ))}
        </ul>
      </aside>

      <div ref={scrollRef} className="overflow-y-auto pr-2 space-y-3">
        {sortedMessages.length === 0 ? (
          <div className="text-xs text-[var(--color-muted)]">no messages in this channel yet</div>
        ) : (
          sortedMessages.map((m) => <MessageRow key={m._id} m={m} />)
        )}
      </div>
    </div>
  );
}

function MessageRow({ m }: { m: Doc<'mockSlackMessages'> }) {
  const isAgent = m.senderKind === 'agent-draft' || m.senderKind === 'agent-posted';
  const tone =
    m.senderKind === 'agent-draft'
      ? 'border-[var(--color-warn)]/40 bg-[var(--color-warn)]/5'
      : m.senderKind === 'agent-posted'
        ? 'border-[var(--color-accent)]/40 bg-[var(--color-accent)]/5'
        : m.senderKind === 'manager'
          ? 'border-[var(--color-border)] bg-[var(--color-bg)]'
          : 'border-[var(--color-border)]';
  const initial = m.sender.slice(0, 1).toUpperCase();
  return (
    <div className={`border ${tone} rounded-md px-3 py-2`}>
      <div className="flex items-center gap-2 mb-1">
        <span
          className={`w-5 h-5 rounded-full text-[10px] font-medium flex items-center justify-center ${
            isAgent
              ? 'bg-[var(--color-accent)]/30 text-[var(--color-accent)]'
              : 'bg-[var(--color-muted)]/20 text-[var(--color-muted)]'
          }`}
        >
          {initial}
        </span>
        <span className="text-xs font-medium text-[var(--color-fg)]">{m.sender}</span>
        {m.senderKind === 'agent-draft' ? (
          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-warn)]/20 text-[var(--color-warn)]">
            agent draft
          </span>
        ) : null}
        {m.senderKind === 'agent-posted' ? (
          <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-[var(--color-accent)]/20 text-[var(--color-accent)]">
            agent
          </span>
        ) : null}
        {m.threadKey ? (
          <span className="text-[9px] text-[var(--color-muted)] font-mono">
            ↳ {m.threadKey}
          </span>
        ) : null}
        <span className="text-[9px] text-[var(--color-muted)] ml-auto">
          {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </span>
      </div>
      <p className="text-xs text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">{m.body}</p>
    </div>
  );
}
