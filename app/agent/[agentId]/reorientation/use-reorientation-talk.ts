'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatStatus, type UIMessage } from 'ai';
import { useMutation, useQuery } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import { INIT_PROMPT } from '@/agent/day-one-turn';
import {
  REPLY_MAX_CHARS,
  answerFailure,
  isKeptAnswer,
  owesAnswer,
  repliesIn,
  uiMessagesOf,
  type OneToOneTurn,
} from '@/agent/one-to-one-conversation';
import {
  answerSetAside,
  lastKeptReply,
  redrawn,
  replyInProgress,
  roomBehind,
  roomPosition,
  textOf,
  unkeptReplies,
} from '@/agent/one-to-one-room';
import { REORIENTATION_COMPLETE } from '@/agent/reorientation-talk-prompts';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { TURN_DEADLINE_MS, withDeadline, START_DEADLINE_MS } from '../one-to-one/deadline';
import {
  REPLY_DRAFT_KEEP_MS,
  askAgain,
  composerLocked,
  errorLine,
  turnRequestFor,
} from '../one-to-one/use-one-to-one-session';

/** The card and its talk as the room draws them (`reorientationTalk.forCard`). */
export type TalkView = FunctionReturnType<typeof api.reorientationTalk.forCard>;

/** What the room is told when the talk's route answered Put this on the card with no sentence. */
const FINISH_UNREACHABLE = 'The talk could not be put on the card';

/** Said after a finish that had no room left to keep the reply it carried. */
const UNKEPT_NOTE =
  'The talk was as long as it can be, so your last reply was not kept. It is back in your reply.';

/** The talk's route: the room posts only the turn it wants and the card it is about. */
const TALK_ROUTE = '/api/reorientation/chat';

/**
 * The transport a talk's room sends its turns on: the card and the turn (`turnRequestFor`), never
 * the history, which the card's talk keeps.
 */
function talkTransport(reorientationId: string): DefaultChatTransport<UIMessage> {
  return new DefaultChatTransport({
    api: TALK_ROUTE,
    prepareSendMessagesRequest: ({ messages, trigger, body }) => ({
      body: {
        reorientationId,
        request: turnRequestFor(
          messages,
          trigger,
          typeof body?.discarding === 'string' ? body.discarding : null,
        ),
      },
    }),
  });
}

/** Whether the room's message is the priming turn, which stands in for the manager and is never drawn. */
function isPriming(message: UIMessage): boolean {
  return message.role === 'user' && textOf(message).trim() === INIT_PROMPT;
}

/** The talk as the room draws it, and what the room can ask of it. */
export interface TalkRoomState {
  /** The card and its talk; undefined while it loads, null for a card that is gone. */
  readonly view: TalkView | undefined;
  /** The conversation without the priming turn. */
  readonly transcript: UIMessage[];
  readonly status: ChatStatus;
  /** The card was decided: the talk is closed and the room only draws it. */
  readonly closed: boolean;
  /** The talk ended in a proposal on the card, and nothing was said after it. */
  readonly onCard: boolean;
  readonly composerDisabled: boolean;
  /** Whether Put this on the card can be pressed: the manager has answered and nothing is in flight. */
  readonly canFinish: boolean;
  readonly finishing: boolean;
  readonly streamError: string | null;
  readonly finishFailure: string | null;
  /** What the room says once, after a finish that handed a reply back. */
  readonly note: string | null;
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly send: () => void;
  readonly askAgain: () => void;
  readonly finish: () => void;
}

/**
 * A Discuss talk's wiring for its room (16-D; the wave file's 5.3): the card's talk it draws, the
 * turns it sends to the talk's route, and what keeps the two in step, on the one-to-one room's
 * own helpers. The card's talk holds the conversation, turn by turn
 * (`convex/reorientationTalk.ts`); a room opened on a talk under way carries on from its last
 * kept turn, with the reply being typed back in the composer and an answer the employee still
 * owes asked for again. Put this on the card asks the route for the outcome outright.
 *
 * @param reorientationId - The card, as the page's address names it.
 * @param name - The employee's name, for the lines the room says.
 */
export function useReorientationTalk(reorientationId: string, name: string): TalkRoomState {
  const view = useQuery(api.reorientationTalk.forCard, { reorientationId });
  const keepReplyDraft = useMutation(api.reorientationTalk.keepReplyDraft);
  const transport = useMemo(() => talkTransport(reorientationId), [reorientationId]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [finishFailure, setFinishFailure] = useState<string | null>(null);
  const [finishing, setFinishing] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const keptDraft = useRef('');
  const { messages, sendMessage, regenerate, setMessages, status, stop } = useChat({
    id: `reorientation-talk-${reorientationId}`,
    transport,
    onError: (err) => setStreamError(errorLine(err)),
    onFinish: (turn) => {
      if (turn.isError || turn.isAbort) return;
      const failure = answerFailure({
        text: textOf(turn.message),
        closed: turn.message.parts.some((part) => part.type === `tool-${REORIENTATION_COMPLETE}`),
        finishReason: turn.finishReason === 'tool-calls' ? 'stop' : turn.finishReason,
      });
      if (failure) setStreamError(failure);
    },
  });

  const talk = view?.talk ?? null;
  const kept: readonly OneToOneTurn[] = useMemo(() => talk?.turns ?? [], [talk]);
  const closed =
    view !== undefined &&
    view !== null &&
    (view.status === 'applied' || view.status === 'dismissed');
  const standing = view !== undefined && view !== null && !closed;
  const waiting = status === 'submitted' || status === 'streaming';

  // Open the talk once the card has loaded, or carry on the one it holds: once per room. A ref,
  // not state: Strict Mode runs the effect twice with one closure, and a second open would be
  // refused as the talk moving on (the second pass's m10).
  const resumed = useRef(false);
  const [drawn, setDrawn] = useState(false);
  useEffect(() => {
    if (resumed.current || view === undefined || view === null) return;
    resumed.current = true;
    setDrawn(true);
    if (!standing) {
      setMessages(uiMessagesOf(kept));
      return;
    }
    if (kept.length === 0) {
      // A turn that fails is reported through useChat's onError, which says it in the room.
      void sendMessage({ text: INIT_PROMPT });
      return;
    }
    setMessages(uiMessagesOf(kept));
    const typed = talk?.replyDraft ?? '';
    keptDraft.current = typed;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the room resumes once, when the card first loads
    if (typed) setDraft((current) => current || typed);
    // As above: a turn asked again that fails is said in the room by onError.
    if (owesAnswer(kept)) void regenerate();
  }, [view, standing, kept, talk, sendMessage, regenerate, setMessages]);

  // Every turn the subscription has reported for this talk: an answer reported and then gone was
  // set aside by another window (`answerSetAside`, the one-to-one room's rule; the second pass's
  // m9). Kept from the previous render in state, as React's docs set out.
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  if (kept.some((turn) => !seen.has(turn.id))) {
    setSeen(new Set([...seen, ...kept.map((turn) => turn.id)]));
  }

  // The talk moved past the room (another window replied, a lost answer was kept, or another
  // window set aside an answer drawn here): drawn again from what the talk holds, the replies it
  // never received put back in the composer.
  const behind =
    drawn &&
    standing &&
    !waiting &&
    !finishing &&
    (roomBehind(messages, kept) || answerSetAside(messages, kept, seen));
  useEffect(() => {
    if (!behind) return;
    const redrawnRoom = redrawn(messages, kept);
    setMessages(redrawnRoom.messages);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server moved the talk on under the room
    setStreamError(null);
    if (redrawnRoom.unsent.length > 0) {
      setDraft((current) =>
        [...redrawnRoom.unsent, current].filter((text) => text.trim()).join('\n\n'),
      );
    }
  }, [behind, kept, messages, setMessages]);

  // A turn that never answers stops being waited on, with Ask again: the reply is kept on the talk.
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout((): void => {
      // Stopping settles the turn as aborted, which says nothing; the line below says why. Stop only
      // aborts the request in flight and cannot reject, so its result is discarded.
      void stop();
      setStreamError(`${name} did not answer within ${TURN_DEADLINE_MS / 1000} seconds`);
    }, TURN_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [waiting, stop, name]);

  // Keep the reply being typed once the composer rests, so a room closed mid-reply reopens with it.
  const unsent = unkeptReplies(messages, kept);
  const typing = replyInProgress(unsent, draft);
  const after = lastKeptReply(kept);
  const talkId = talk?._id;
  const conversation = talk?.conversation;
  useEffect(() => {
    if (talkId === undefined || conversation === undefined || !standing || waiting) return;
    if (typing === keptDraft.current) return;
    const timer = setTimeout((): void => {
      // The chain ends in its own rejection handler: a keep that fails costs a crash's typing.
      void keepReplyDraft({ talkId, conversation, text: typing, after }).then(
        (result): void => {
          if (result.kept) keptDraft.current = typing;
        },
        (err: unknown): void => {
          log.warn('talk reply being typed not kept', { reason: errorMessage(err) });
        },
      );
    }, REPLY_DRAFT_KEEP_MS);
    return () => clearTimeout(timer);
  }, [talkId, conversation, standing, waiting, typing, after, keepReplyDraft]);

  const opened = messages.some(isKeptAnswer);
  const composerDisabled = !standing || composerLocked({ status, done: finishing, opened });
  const transcript = messages.filter((message) => !isPriming(message));
  const onCard = talk?.state === 'finished' && !waiting && !finishing && unsent.length === 0;

  function send(): void {
    const trimmed = draft.trim().slice(0, REPLY_MAX_CHARS);
    if (!trimmed || composerDisabled) return;
    setStreamError(null);
    setFinishFailure(null);
    // An answer that failed is not one the talk holds; the reply answers the question before it.
    const last = messages.at(-1);
    if (last?.role === 'assistant' && !isKeptAnswer(last)) setMessages(messages.slice(0, -1));
    // A turn that fails is reported through useChat's onError, which says it in the room.
    void sendMessage({ text: trimmed });
    setDraft('');
    keptDraft.current = '';
  }

  function retryTurn(): void {
    setStreamError(null);
    // askAgain reports its own failure through onError and never rejects.
    void askAgain({ messages, regenerate, sendMessage });
  }

  /**
   * Ask the talk's route to put the talk on the card, delivering any reply it never received first.
   * A reply the talk had no room left to keep leaves the conversation and goes back to the
   * composer, and the room says so (the second pass's M3).
   */
  function finish(): void {
    setStreamError(null);
    setFinishFailure(null);
    setNote(null);
    setFinishing(true);
    const request = { kind: 'finish' as const, ...roomPosition(messages) };
    // The chain ends in its own rejection handler, which says the failure in the room.
    void withDeadline(
      fetch(TALK_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reorientationId, request }),
      }).then(async (response): Promise<number> => {
        // A body that is not JSON is read as no sentence: the line below then says it plainly.
        const body = (await response.json().catch((): null => null)) as {
          error?: unknown;
          unkept?: unknown;
        } | null;
        if (!response.ok) {
          throw new Error(typeof body?.error === 'string' ? body.error : FINISH_UNREACHABLE);
        }
        return typeof body?.unkept === 'number' ? body.unkept : 0;
      }),
      TURN_DEADLINE_MS + START_DEADLINE_MS,
      `${name} did not answer within ${(TURN_DEADLINE_MS + START_DEADLINE_MS) / 1000} seconds`,
    ).then(
      (unkept): void => {
        setFinishing(false);
        if (unkept === 0) return;
        const set = new Set(request.replies.slice(-unkept).map((reply) => reply.id));
        setMessages(messages.filter((message) => !set.has(message.id)));
        setDraft((current) =>
          [...request.replies.slice(-unkept).map((reply) => reply.text), current]
            .filter((text) => text.trim())
            .join('\n\n'),
        );
        setNote(UNKEPT_NOTE);
      },
      (err: unknown): void => {
        setFinishing(false);
        setFinishFailure(errorLine(err instanceof Error ? err : new Error(String(err))));
      },
    );
  }

  return {
    view,
    transcript,
    status,
    closed,
    onCard,
    composerDisabled,
    // A talk already on the card is not asked for its outcome again (the second pass's m4).
    canFinish: standing && !waiting && !finishing && !onCard && repliesIn(kept) + unsent.length > 0,
    note,
    finishing,
    streamError,
    // Once the talk is on the card, an earlier press's refusal is no longer true of it: a press
    // answered 503 while the proposal reached the card left the room saying both (the v0.20.0
    // hosted walk's finding 5).
    finishFailure: onCard ? null : finishFailure,
    draft,
    setDraft,
    send,
    askAgain: retryTurn,
    finish,
  };
}
