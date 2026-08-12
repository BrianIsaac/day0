'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { clockTime, clockTimeWithSeconds } from '../time';

export function SlackTab({ agentId }: { agentId: Id<'agents'> }) {
  const channels = useQuery(api.mock.listChannels, { agentId });
  const [pickedSlug, setPickedSlug] = useState<string | null>(null);
  const activeSlug = pickedSlug ?? channels?.[0]?.slug ?? null;

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

  const channelList = channels.filter((c) => c.kind === 'channel');
  const dmList = channels.filter((c) => c.kind === 'dm');

  /* A fixed 12rem rail took 114px of a 398px panel and left the conversation
     the rest, wrapping a 24-word message over nine lines. The rail earns its
     column only where there is one to spare: below that the channels sit above
     the conversation as a single row of chips, and the messages get the width. */
  return (
    <div className="@container h-full">
      <div className="grid grid-cols-1 @lg:grid-cols-[11rem_minmax(0,1fr)] gap-3 @lg:gap-4 h-full">
        <aside className="@lg:border-r border-[var(--color-border)] @lg:pr-3 @lg:-mr-1 @lg:overflow-y-auto min-w-0">
          <ChannelGroup
            label="Channels"
            channels={channelList}
            activeSlug={activeSlug}
            onPick={setPickedSlug}
          />
          <ChannelGroup
            label="Direct messages"
            channels={dmList}
            activeSlug={activeSlug}
            onPick={setPickedSlug}
            className="mt-2 @lg:mt-4"
          />
        </aside>

        <div ref={scrollRef} className="overflow-y-auto @lg:pr-2 space-y-3 min-w-0">
          {sortedMessages.length === 0 ? (
            <div className="text-xs text-[var(--color-muted)]">no messages in this channel yet</div>
          ) : (
            sortedMessages.map((m) => <MessageRow key={m._id} m={m} />)
          )}
        </div>
      </div>
    </div>
  );
}

function ChannelGroup({
  label,
  channels,
  activeSlug,
  onPick,
  className,
}: {
  label: string;
  channels: Doc<'mockSlackChannels'>[];
  activeSlug: string | null;
  onPick: (slug: string) => void;
  className?: string;
}) {
  if (channels.length === 0) return null;
  return (
    <div className={className}>
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-1.5 @lg:mb-2 @lg:mt-1">
        {label}
      </div>
      <ul className="flex flex-wrap gap-1 @lg:block @lg:space-y-1 text-xs">
        {channels.map((c) => (
          <li key={c._id}>
            <button
              onClick={() => onPick(c.slug)}
              className={`text-left px-2 py-1 rounded @lg:w-full ${
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
      {/* Wraps rather than squashing: the avatar used to be crushed to an
          ellipse and the thread key broken over three lines when the column
          was narrow. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mb-1">
        <span
          className={`w-5 h-5 shrink-0 rounded-full text-[10px] font-medium flex items-center justify-center ${
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
          <span className="text-[9px] text-[var(--color-muted)] font-mono truncate max-w-[14rem]">
            ↳ {m.threadKey}
          </span>
        ) : null}
        <span
          className="text-[9px] text-[var(--color-muted)] ml-auto shrink-0"
          title={clockTimeWithSeconds(m.timestamp)}
        >
          {clockTime(m.timestamp)}
        </span>
      </div>
      <p className="text-xs text-[var(--color-fg)] whitespace-pre-wrap leading-relaxed">{m.body}</p>
    </div>
  );
}
