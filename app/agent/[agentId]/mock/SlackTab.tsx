'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id, Doc } from '@convex/_generated/dataModel';
import { Chip } from '../../../components/Chip';
import { clockTime, clockTimeWithSeconds, useAgentZone } from '../time';

/** What an empty channel list means. The tab is mock-only: real mode does not
 * render it, so it has no real-mode copy to show. */
export const EMPTY_CHANNELS = 'No channels are seeded in this office.';

/** What an empty conversation says. */
export const EMPTY_CONVERSATION = 'No messages in this channel yet.';

/** The label of a message the employee drafted and has not posted (N29: the employee). */
export const EMPLOYEE_DRAFT = 'Employee draft';

/** The label of a message the employee posted. */
export const EMPLOYEE_POSTED = 'Employee';

/**
 * The channel the office opens on: `#revops-asks`, where the asks the employee works arrive
 * (UX 8 (a)). The rail sorts `#revops` above it, and that channel is empty until the employee
 * posts there.
 */
export const OPENING_CHANNEL = 'revops-asks';

/**
 * The office's Slack, in the product's own Slack shape: the channels and direct messages as a
 * rail, the conversation beside it, opening on `#revops-asks`.
 */
export function SlackTab({ agentId }: { agentId: Id<'agents'> }) {
  const channels = useQuery(api.mock.listChannels, { agentId });
  const [pickedSlug, setPickedSlug] = useState<string | null>(null);

  /* listChannels reads the by_agent_slug index, so channels[0] is the
     alphabetically first slug - in the seeded office an empty DM three rows
     down the rail. Open on the intake channel, else the row the rail draws first. */
  const channelList = channels?.filter((c) => c.kind === 'channel') ?? [];
  const dmList = channels?.filter((c) => c.kind === 'dm') ?? [];
  const opening =
    channelList.find((channel) => channel.slug === OPENING_CHANNEL) ?? channelList[0] ?? dmList[0];
  const activeSlug = pickedSlug ?? opening?.slug ?? null;

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
    // The newest message in view; at once where the reader has asked for less motion.
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: still ? 'auto' : 'smooth',
    });
  }, [sortedMessages.length]);

  if (!channels) return <p className="text-sm text-[var(--color-muted)]">Loading the channels…</p>;
  if (channels.length === 0)
    return <p className="text-sm text-[var(--color-muted)]">{EMPTY_CHANNELS}</p>;

  /* A fixed 12rem rail took 114px of a 398px panel and left the conversation
     the rest, wrapping a 24-word message over nine lines. The rail earns its
     column only where there is one to spare: below that the channels sit above
     the conversation as a single row of chips, and the messages get the width. */
  return (
    <div className="@container h-full">
      {/* The panel's height is fixed, so the conversation scrolls on its own under the rail
          and the newest message can be brought into view. */}
      <div className="grid h-full grid-cols-1 grid-rows-[auto_minmax(0,1fr)] gap-3 @lg:grid-cols-[11rem_minmax(0,1fr)] @lg:grid-rows-[minmax(0,1fr)] @lg:gap-4">
        <nav
          aria-label="Channels and direct messages"
          className="min-w-0 border-[var(--color-border)] @lg:-mr-1 @lg:min-h-0 @lg:overflow-y-auto @lg:border-r @lg:pr-3"
        >
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
        </nav>

        {/* Focusable and named, so a keyboard can scroll the conversation. A
            region, not a log: switching channels replaces every message, and
            a log would read the whole channel out on each switch. */}
        <div
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label="Messages"
          className="min-h-0 min-w-0 space-y-3 overflow-y-auto @lg:pr-2"
        >
          {sortedMessages.length === 0 ? (
            <p className="text-sm text-[var(--color-muted)]">{EMPTY_CONVERSATION}</p>
          ) : (
            sortedMessages.map((m) => <MessageRow key={m._id} m={m} />)
          )}
        </div>
      </div>
    </div>
  );
}

/** One group of the rail: its heading and a row per channel, the open one marked. */
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
      <h3 className="mb-1.5 text-xs font-semibold tracking-[0.06em] text-[var(--color-muted)] uppercase @lg:mt-1 @lg:mb-2">
        {label}
      </h3>
      <ul className="flex flex-wrap gap-1 text-sm @lg:block @lg:space-y-1">
        {channels.map((c) => (
          <li key={c._id}>
            <button
              type="button"
              onClick={() => onPick(c.slug)}
              aria-current={c.slug === activeSlug ? 'true' : undefined}
              className={`min-h-11 rounded-lg px-2.5 py-1 text-left @lg:w-full ${
                c.slug === activeSlug
                  ? 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                  : 'text-[var(--color-fg-2)] hover:bg-[var(--color-inset)] hover:text-[var(--color-fg)]'
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

/** One message: who sent it, when, whether the employee drafted or posted it, and what it says. */
function MessageRow({ m }: { m: Doc<'mockSlackMessages'> }) {
  const zone = useAgentZone();
  const isEmployee = m.senderKind === 'agent-draft' || m.senderKind === 'agent-posted';
  const tone =
    m.senderKind === 'agent-draft'
      ? 'border-[var(--color-warn-line)] bg-[var(--color-warn-soft)]'
      : m.senderKind === 'agent-posted'
        ? 'border-[var(--color-accent-line)] bg-[var(--color-accent-soft)]'
        : m.senderKind === 'manager'
          ? 'border-[var(--color-border)] bg-[var(--color-inset)]'
          : 'border-[var(--color-border)]';
  const initial = m.sender.slice(0, 1).toUpperCase();
  return (
    <div className={`flex gap-3 rounded-lg border px-3 py-2.5 ${tone}`}>
      <span
        aria-hidden="true"
        className={`flex size-7 shrink-0 items-center justify-center rounded-md border text-xs font-semibold ${
          isEmployee
            ? 'border-[var(--color-accent-line)] text-[var(--color-accent)]'
            : 'border-[var(--color-border-2)] text-[var(--color-fg-2)]'
        }`}
      >
        {initial}
      </span>
      <div className="min-w-0 flex-1">
        {/* Wraps rather than squashing: the thread key used to break over three lines when the
            column was narrow. */}
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span className="text-sm font-semibold text-[var(--color-fg)]">{m.sender}</span>
          <span
            className="text-xs text-[var(--color-muted)]"
            title={clockTimeWithSeconds(m.timestamp, zone)}
          >
            {clockTime(m.timestamp, zone)}
          </span>
          {m.senderKind === 'agent-draft' ? <Chip tone="warn">{EMPLOYEE_DRAFT}</Chip> : null}
          {m.senderKind === 'agent-posted' ? <Chip tone="accent">{EMPLOYEE_POSTED}</Chip> : null}
          {m.threadKey ? (
            <span className="max-w-[14rem] truncate font-mono text-xs text-[var(--color-muted)]">
              <span aria-hidden="true">↳ </span>
              <span className="sr-only">in thread </span>
              {m.threadKey}
            </span>
          ) : null}
        </div>
        <p className="mt-1 max-w-[72ch] text-sm leading-relaxed whitespace-pre-wrap text-[var(--color-fg)]">
          {m.body}
        </p>
      </div>
    </div>
  );
}
