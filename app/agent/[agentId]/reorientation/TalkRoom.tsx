'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import type { UIMessage } from 'ai';
import type { Id } from '@convex/_generated/dataModel';
import { REORIENTATION_COMPLETE } from '@/agent/reorientation-talk-prompts';
import { Button } from '../../../components/Button';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { REPLY_HELP, REPLY_PLACEHOLDER, ReplyInput, TurnFailureNotice } from '../ChatRoom';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';
import { ROOM_HEIGHT } from '../room-frame';
import { TurnText } from '../one-to-one/TurnText';
import { useReorientationTalk } from './use-reorientation-talk';

/** A turn of the talk, as either side's bubble draws it (the one-to-one room's shapes). */
const BUBBLE =
  'max-w-[92%] rounded-xl border px-4 py-3 text-[15px] leading-normal whitespace-pre-wrap sm:max-w-[76%]';

/** The employee's side: on the page, its tail to the left. */
const EMPLOYEE_BUBBLE =
  'justify-self-start rounded-bl-[4px] border-[var(--color-border)] bg-[var(--color-bg)]';

/** The manager's side: on the accent's tint, its tail to the right. */
const MANAGER_BUBBLE =
  'justify-self-end rounded-br-[4px] border-[var(--color-accent-line)] bg-[var(--color-accent-soft)]';

/** The closing line a `reorientationComplete` call carried, when it is text. */
function closingLineOf(part: UIMessage['parts'][number]): string | undefined {
  if (part.type !== `tool-${REORIENTATION_COMPLETE}`) return undefined;
  const line = (part as { input?: { closingLine?: unknown } }).input?.closingLine;
  return typeof line === 'string' && line.trim() !== '' ? line : undefined;
}

/** One turn of the talk. The model's input is drawn only as text, never handed to React whole. */
function TalkBubble({ message }: { message: UIMessage }) {
  const manager = message.role === 'user';
  return (
    <div className={`${BUBBLE} ${manager ? MANAGER_BUBBLE : EMPLOYEE_BUBBLE}`}>
      {/* The side and the colour say who spoke to a sighted reader; this says it to everyone else. */}
      <span className="sr-only">{manager ? 'You: ' : 'Employee: '}</span>
      {message.parts.map((part, index) => {
        if (part.type === 'text') {
          return <span key={index}>{manager ? part.text : <TurnText text={part.text} />}</span>;
        }
        const closing = closingLineOf(part);
        return closing === undefined ? null : (
          <span key={index} className="mt-1 block text-[var(--color-ok)] italic">
            {closing}
          </span>
        );
      })}
    </div>
  );
}

/** The card's address on the reorientation page, where its decisions are. */
function cardHref(agentId: Id<'agents'>, reorientationId: string): string {
  return `${employeeTabHref(agentId, 'needs-you')}/reorientation#card-${reorientationId}`;
}

/**
 * The Discuss room for one reorientation card (16-D; the wave file's 5.3 and section 7's words,
 * RM24): "Talking through: {what changed}", the talk so far, the composer and Put this on the
 * card. The card's talk holds the conversation (`useReorientationTalk`); a room opened on a talk
 * under way carries on from its last kept turn. The talk ends in a new proposal on the card and
 * applies nothing; a decided card's talk is drawn closed, as it stood.
 *
 * @param reorientationId - The card, as the page's address names it.
 * @param agentId - The employee whose card it is.
 * @param name - The employee's name.
 */
export function TalkRoom({
  reorientationId,
  agentId,
  name,
}: {
  reorientationId: string;
  agentId: Id<'agents'>;
  name: string;
}) {
  const talk = useReorientationTalk(reorientationId, name);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { view, transcript, status } = talk;

  // Keep the newest turn in view as it streams: an instant jump, never a smooth scroll per chunk.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => el.scrollTo({ top: el.scrollHeight }));
    return () => cancelAnimationFrame(id);
  }, [transcript]);

  if (view === undefined) {
    return (
      <p role="status" className="text-sm text-[var(--color-muted)]">
        Loading the talk
      </p>
    );
  }
  if (view === null || view.agentId !== agentId) {
    return (
      <Card title="This card is gone.">
        <p className="text-sm text-[var(--color-fg-2)]">
          <Link href={`${employeeTabHref(agentId, 'needs-you')}/reorientation`}>
            See {name}&apos;s reorientation cards
          </Link>
        </p>
      </Card>
    );
  }
  const answering = status === 'submitted' || status === 'streaming';
  const titleId = `talk-${reorientationId}-title`;
  return (
    <section
      aria-labelledby={titleId}
      className={`flex flex-col rounded-xl border border-[var(--color-accent-line)] bg-[var(--color-card)] ${ROOM_HEIGHT}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 border-b border-[var(--color-border)] px-4 py-2 sm:px-5">
        <h2 id={titleId} className="py-2.5 text-[15px] font-semibold [overflow-wrap:anywhere]">
          Talking through: {view.summary}
        </h2>
        <Link
          href={cardHref(agentId, reorientationId)}
          className="inline-flex min-h-11 items-center text-[13px]"
        >
          Back to the card
        </Link>
      </header>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="log"
        aria-label="The talk so far"
        // A turn streams in token by token; the log is read once it is whole.
        aria-busy={answering}
        className="grid flex-1 content-start gap-3.5 overflow-y-auto px-4 py-3 sm:px-5"
      >
        {transcript.map((message) => (
          <TalkBubble key={message.id} message={message} />
        ))}
        {status === 'submitted' ? (
          <p
            role="status"
            className={`${BUBBLE} ${EMPLOYEE_BUBBLE} text-[var(--color-muted)] italic`}
          >
            {name} is thinking…
          </p>
        ) : null}
        {talk.streamError && !talk.closed ? (
          <TurnFailureNotice failure={talk.streamError} onAskAgain={talk.askAgain} />
        ) : null}
      </div>
      <div className="grid gap-2 border-t border-[var(--color-border)] px-4 py-3 sm:px-5">
        {talk.closed ? (
          <p role="status" className="text-sm text-[var(--color-fg-2)]">
            The card was decided, so the talk about it is closed.
          </p>
        ) : (
          <>
            {talk.onCard ? (
              <p role="status" className="text-sm text-[var(--color-ok)]">
                {name} put a new proposal on the card. Nothing changes until you approve it there.
              </p>
            ) : null}
            {talk.note ? (
              <p role="status" className="text-sm text-[var(--color-fg-2)]">
                {talk.note}
              </p>
            ) : null}
            {talk.finishFailure ? (
              <p role="alert" className="text-sm text-[var(--color-warn)]">
                {talk.finishFailure.replace(/\.$/, '')}.
              </p>
            ) : null}
            <form
              className="grid gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                talk.send();
              }}
            >
              <ReplyInput
                value={talk.draft}
                onChange={talk.setDraft}
                onSend={talk.send}
                disabled={talk.composerDisabled}
                placeholder={talk.composerDisabled ? `waiting for ${name}…` : REPLY_PLACEHOLDER}
                helpId={`${titleId}-help`}
              />
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={talk.composerDisabled || !talk.draft.trim()}
                >
                  Send
                </Button>
                <Button disabled={!talk.canFinish} onClick={talk.finish}>
                  {talk.finishing ? 'Putting this on the card…' : 'Put this on the card'}
                </Button>
                <p id={`${titleId}-help`} className="text-[13px] text-[var(--color-muted)]">
                  {REPLY_HELP}
                </p>
              </div>
            </form>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * What a talk is for, beside the room (the prototype's aside): a short conversation about this
 * change only, ending in a new proposal on the card.
 */
function WhatTheTalkBecomes({ name }: { name: string }) {
  return (
    <Card title="What this becomes">
      <p className="text-[13px] text-[var(--color-fg-2)]">
        A short conversation with {name} about this change only. It ends in a new proposal on the
        card, and nothing changes until you approve the card.
      </p>
    </Card>
  );
}

/**
 * The Discuss page of one card (`/agent/<id>/reorientation/talk/<card>`), under the Needs you tab:
 * the room beside the employee's rail and what the talk becomes.
 *
 * @param reorientationId - The card, as the page's address names it.
 */
export function TalkView({ reorientationId }: { reorientationId: string }) {
  const { agent, arriving } = useEmployee();
  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <EmployeeRail />
          <WhatTheTalkBecomes name={agent.name} />
        </>
      }
    >
      {/* Keyed by the card: another card's talk is a room of its own, never this one's state. */}
      <TalkRoom
        key={reorientationId}
        reorientationId={reorientationId}
        agentId={agent._id}
        name={agent.name}
      />
    </Columns>
  );
}
