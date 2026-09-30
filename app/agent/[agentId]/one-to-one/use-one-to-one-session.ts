'use client';

import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatStatus, type UIMessage } from 'ai';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { INIT_PROMPT } from '@/agent/day-one-turn';
import { oneToOnePhase, type OneToOnePhase } from '@/agent/one-to-one-phase';
import {
  REPLY_MAX_CHARS,
  answerFailure,
  conversationOf,
  conversationTranscript,
  isClosed,
  isKeptAnswer,
  owesAnswer,
  uiMessagesOf,
  type OneToOneTurn,
  type SentReply,
  type TurnRequest,
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
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { refusalText } from '../../../components/use-change';
import { SYNTHESIS_DEADLINE_MS, lateBy, postCharterSynthesis } from '../charter-synthesis';
import type { SynthesisPost } from './DraftingNotice';
import { START_DEADLINE_MS, TURN_DEADLINE_MS, withDeadline } from './deadline';

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
 * Name what went wrong with a turn that ended without an error, if anything did (`answerFailure`,
 * which the route reads too, so a turn the room says failed is one the session did not keep).
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
  return answerFailure({
    text: textOf(turn.message),
    closed: turn.message.parts.some((p) => p.type === 'tool-dayOneComplete'),
    finishReason: turn.finishReason,
  });
}

/**
 * What a browser says when a request never reached the server: Chromium, Firefox and Safari in
 * turn. A developer's sentence, not a manager's.
 */
const UNREACHABLE =
  /^(failed to fetch|networkerror when attempting to fetch resource\.?|load failed)$/i;

/**
 * The line for a stream error. The route answers a failure it can name with
 * JSON, which the transport hands over as the error's message, braces and all;
 * a request that never reached the route is said in the page's own words.
 */
export function errorLine(err: Error): string {
  try {
    const body = JSON.parse(err.message) as { error?: unknown };
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON: the message is the sentence.
  }
  if (UNREACHABLE.test(err.message.trim())) return 'The page could not reach Day0';
  return err.message || 'employee unavailable';
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
 * the page; the session is told which answer that was, and sets aside only it.
 */
export async function askAgain(
  chat: Pick<UseChatHelpers<UIMessage>, 'messages' | 'regenerate' | 'sendMessage'>,
): Promise<void> {
  const last = chat.messages.at(-1);
  if (!last) await chat.sendMessage({ text: INIT_PROMPT });
  else if (last.role === 'assistant') await chat.regenerate({ body: { discarding: last.id } });
  else await chat.regenerate();
}

/**
 * The turn a send asks the session for. The room posts only this, never its copy of the history:
 * the session keeps the conversation and answers from its own (`oneToOne.takeTurn`). A reply, and
 * a turn asked again, names the question it answers (`roomPosition`) and carries every reply the
 * room drew since, so a reply whose send never reached the session is delivered first, in order,
 * and a reply is never filed under a question this room did not draw.
 *
 * @param messages - The room's conversation with the send's own message last.
 * @param trigger - Whether the send is a new message or the last turn asked again.
 * @param discarding - The answer the room set aside to ask again, when it had one.
 */
export function turnRequestFor(
  messages: readonly UIMessage[],
  trigger: 'submit-message' | 'regenerate-message',
  discarding: string | null,
): TurnRequest {
  // The answer being set aside is no longer where the room stands.
  const position = roomPosition(messages.filter((m: UIMessage): boolean => m.id !== discarding));
  if (trigger === 'regenerate-message') return { kind: 'ask-again', ...position, discarding };
  return position.replies.length > 0 ? { kind: 'reply', ...position } : { kind: 'open' };
}

/**
 * How long the composer rests before the reply being typed is kept on the session, so a room
 * closed mid-reply reopens with it. Short enough that little is lost to a crash, long enough that
 * typing is not one write per key.
 */
export const REPLY_DRAFT_KEEP_MS = 800;

/**
 * The transport a chat room sends its turns on. The employee's session keeps the conversation,
 * so a turn names itself (`turnRequestFor`) and the employee, and never carries the history.
 */
export function chatTurnTransport(
  agentId: Id<'agents'>,
  bossLabel: string,
): DefaultChatTransport<UIMessage> {
  return new DefaultChatTransport({
    api: '/api/voice/chat',
    prepareSendMessagesRequest: ({ messages, trigger, body }) => ({
      body: {
        agentId,
        bossLabel,
        request: turnRequestFor(
          messages,
          trigger,
          typeof body?.discarding === 'string' ? body.discarding : null,
        ),
      },
    }),
  });
}

/** The turn ids a room's subscription has reported, and the session and conversation they are of. */
interface SeenTurns {
  readonly for: string;
  readonly ids: ReadonlySet<string>;
}

/** What the one-to-one's session wiring is given. */
export interface OneToOneSessionOptions {
  readonly agentId: Id<'agents'>;
  readonly bossLabel: string;
  /** The employee's name, for the lines the room says. */
  readonly name: string;
  /** The employee row's state, which tells a draft sent back with nothing to redraft from. */
  readonly employeeState: Doc<'agents'>['state'] | undefined;
  /** Told when the manager holds the one-to-one again, so the room can move focus back. */
  readonly onHeldAgain?: () => void;
}

/** The one-to-one as the room draws it, and what the room can ask of it. */
export interface OneToOneSession {
  /** The employee's newest session, undefined while it loads. */
  readonly session: Doc<'voiceSessions'> | null | undefined;
  readonly serverPhase: OneToOnePhase;
  /** The turns the session keeps. */
  readonly kept: readonly OneToOneTurn[] | undefined;
  readonly messages: UIMessage[];
  /** The conversation without the priming turn. */
  readonly transcript: UIMessage[];
  readonly status: ChatStatus;
  /** Whether the one-to-one is over: closed, finished, or drafting on the server. */
  readonly over: boolean;
  /** Whether the session holds a question to answer, so the composer can open. */
  readonly opened: boolean;
  readonly composerDisabled: boolean;
  /** A call in another window holds the session now. */
  readonly movedToCall: boolean;
  /** The replies the room shows that never reached the session. */
  readonly unsent: readonly SentReply[];
  readonly streamError: string | null;
  readonly startFailure: string | null;
  readonly finishFailure: string | null;
  /** Why the room was drawn again from the session, while that is worth saying. */
  readonly redrawNote: string | null;
  readonly post: SynthesisPost;
  /** The reply being typed. */
  readonly draft: string;
  readonly setDraft: (value: string) => void;
  readonly send: () => void;
  readonly askAgain: () => void;
  readonly finish: (withoutUnsent?: readonly SentReply[]) => void;
  readonly draftAgain: () => void;
  readonly holdAgain: () => void;
  readonly startAgain: () => void;
}

/**
 * The Day-1 one-to-one's session wiring for the chat room: the session it draws, the chat turns
 * it sends, and everything that keeps the two in step. The session holds the conversation, turn by
 * turn (`convex/oneToOne.ts`); a room opened on a conversation under way carries on from its last
 * kept turn, with the reply being typed back in the composer and an answer the employee still owes
 * asked for again. A session already drafting is shown drafting and never opened again.
 *
 * @param options - The employee, the manager's label and what the room is told.
 */
export function useOneToOneSession({
  agentId,
  bossLabel,
  name,
  employeeState,
  onHeldAgain,
}: OneToOneSessionOptions): OneToOneSession {
  const startSession = useMutation(api.voice.start);
  const restartSession = useMutation(api.voice.restart);
  const finishSession = useMutation(api.oneToOne.finish);
  const session = useQuery(api.voice.latest, { agentId });
  const serverPhase = oneToOnePhase(session);
  const [draft, setDraft] = useState('');
  // The reply being typed as the session last kept it, so an unchanged field is not written again.
  const keptDraft = useRef('');
  // The session this 1:1 belongs to, read by Finish and the reply keeper. A ref rather than state
  // because they must see the id the mount effect obtained, not whatever a stale render closed
  // over.
  const sessionRef = useRef<Id<'voiceSessions'> | null>(null);
  // The conversation this room draws (`conversationOf`), from the start that opened it; null until
  // then. Finish and the reply keeper name it, so the session refuses them once it has set the
  // conversation aside, and the room starts again when it sees the session has.
  const [conversation, setConversation] = useState<number | null>(null);

  const transport = useMemo(() => chatTurnTransport(agentId, bossLabel), [agentId, bossLabel]);

  const [streamError, setStreamError] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [post, setPost] = useState<SynthesisPost>({ kind: 'idle' });
  const { messages, sendMessage, regenerate, setMessages, status, stop } = useChat({
    // The hook keeps the chat it first made, transport and all, until its id changes.
    id: `one-to-one-${agentId}`,
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

  // Finish was pressed: the session is starting the draft, and the room waits for it to say so.
  const [finishing, setFinishing] = useState(false);
  // Why the last Finish did not reach the session; Finish stays on the page to press again.
  const [finishFailure, setFinishFailure] = useState<string | null>(null);
  const kept = session?.turns;
  // The employee's last turn closed the one-to-one. A close the room was shown but the session
  // did not keep came with an error, and a reply sent after it moved on from it: neither ends it.
  const closedInRoom =
    messages.at(-1)?.role === 'assistant' &&
    messages.at(-1)?.parts.some((p) => p.type === 'tool-dayOneComplete') === true;
  const done = (closedInRoom && !streamError) || isClosed(kept ?? []) || finishing;
  const transcript = withoutPrimingTurn(messages);
  // Drafting on the server without a conversation in this room: the room came back to it. A
  // finished session with the employee back at `deployed` is a draft sent back with nothing to
  // redraft from, so the next one-to-one starts (`voice.start` opens a new session).
  const serverOver =
    serverPhase.kind === 'drafting' ||
    serverPhase.kind === 'failed' ||
    (serverPhase.kind === 'drafted' && employeeState !== 'deployed');
  const over = done || serverOver;
  const startable = session !== undefined && !serverOver;

  /**
   * Carry the conversation on from where the session holds it, or open it when it holds none. The
   * employee still owes an answer when the manager's reply is the last kept turn (the room closed
   * while it answered), so that turn is asked for again. A session from before the conversation
   * was kept names no turns and no stamp, and is read as the first conversation with none kept.
   */
  function resume(started: {
    readonly conversation?: number;
    readonly turns?: readonly OneToOneTurn[];
    readonly replyDraft?: string | null;
  }): void {
    const turns = started.turns ?? [];
    setConversation(started.conversation ?? 0);
    if (turns.length === 0) {
      // A turn that fails is reported through useChat's onError, which says it in the room.
      void sendMessage({ text: INIT_PROMPT });
      return;
    }
    setMessages(uiMessagesOf(turns));
    const typed = started.replyDraft ?? '';
    keptDraft.current = typed;
    if (typed) setDraft((current) => current || typed);
    // As above: a turn asked again that fails is said in the room by onError.
    if (owesAnswer(turns)) void regenerate();
  }

  // Open the one-to-one once the session row exists, or carry on the one the session holds.
  // Strict Mode invokes this twice and the discarded invocation does nothing with its answer, so
  // one mount asks one turn. It still asks for a session twice, and any remount asks again -
  // `voice.start` answers all of them with the same row and the conversation it keeps, which is
  // why nothing here has to be latched. A session already drafting is not opened again (finding
  // 1 of the wave 6 C handover): the room waits for the session to load before it decides.
  useEffect(() => {
    if (!startable) return;
    let cancelled = false;
    // The chain ends in its own rejection handler, which says why in the room: a start that failed
    // or ran out of time, and a conversation the room could not draw.
    void withDeadline(
      startSession({ agentId, mode: 'chat' }),
      START_DEADLINE_MS,
      `${name} did not answer within ${START_DEADLINE_MS / 1000} seconds`,
    )
      .then((started): void => {
        sessionRef.current = started.sessionId;
        if (!cancelled) resume(started);
      })
      // A 1:1 that could not start says why, with the way to try again,
      // rather than leaving the composer waiting for an opening that never comes.
      .catch((err: unknown): void => {
        if (!cancelled) setStartFailure(refusalText(err, 'The 1:1 could not start.'));
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session is asked for once per start attempt; the other values are stable for the room's life
  }, [startAttempt, startable]);

  // A room that comes back to a one-to-one already over draws the conversation the session kept.
  useEffect(() => {
    if (startable || !kept || kept.length === 0 || messages.length > 0) return;
    setMessages(uiMessagesOf(kept));
  }, [startable, kept, messages.length, setMessages]);

  // A turn that never answers stops being waited on, with Ask again (hosted walk m30): the reply
  // is kept on the session, so asking again answers it.
  const waitingOnTurn = status === 'submitted' || status === 'streaming';

  // The replies the room shows that never reached the session. They are delivered before anything
  // else is: the next Send carries them first, Finish names them, and the keeper keeps them.
  const unsent = unkeptReplies(messages, kept ?? []);

  // Keep the reply being typed once the composer rests, so a room closed mid-reply reopens with it,
  // and with any reply the room shows that never reached the session. It follows the last reply
  // the session kept; while a turn is in flight the session is about to move, so it waits.
  useReplyDraftKeeper({
    sessionId: sessionRef,
    conversation,
    paused: over || waitingOnTurn,
    typing: replyInProgress(unsent, draft),
    after: lastKeptReply(kept ?? []),
    keptDraft,
  });

  // Why the room was drawn again from the session, while that is worth saying.
  const [redrawNote, setRedrawNote] = useState<string | null>(null);

  // Every turn the subscription has reported for this conversation: an answer reported and then
  // gone was set aside (`answerSetAside`). Kept from the previous render in state, as React's docs
  // set out; a new session or conversation starts the record afresh.
  const seenFor = `${session?._id ?? ''}:${conversation ?? ''}`;
  const [seen, setSeen] = useState<SeenTurns>({ for: seenFor, ids: new Set() });
  const reported = kept ?? [];
  if (seen.for !== seenFor || reported.some((turn) => !seen.ids.has(turn.id))) {
    const earlier = seen.for === seenFor ? [...seen.ids] : [];
    setSeen({ for: seenFor, ids: new Set([...earlier, ...reported.map((turn) => turn.id)]) });
  }

  // The session moved past this room: another window replied, an answer the room lost on the way
  // was kept, another window set aside an answer the room drew, or the one-to-one started again.
  // The room is drawn again from what the session holds, rather than offering a turn the session
  // would refuse. A turn in flight settles first.
  const behind = !over && !waitingOnTurn && conversation !== null && !!session;
  const startedAgain = behind && conversationOf(session) !== conversation;
  const movedToCall = startedAgain && session.mode !== 'chat';
  const drawnBehind =
    behind &&
    !startedAgain &&
    (roomBehind(messages, reported) || answerSetAside(messages, reported, seen.ids));
  useEffect(() => {
    if (!startedAgain || movedToCall) return;
    // The conversation this room drew was set aside elsewhere: open the one the session holds.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server set the conversation aside under the room
    setConversation(null);
    setMessages([]);
    setStreamError(null);
    setStartAttempt((attempt) => attempt + 1);
  }, [startedAgain, movedToCall, setMessages]);
  useEffect(() => {
    if (!drawnBehind || !kept) return;
    const drawn = redrawn(messages, kept);
    setMessages(drawn.messages);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the server moved the conversation on under the room
    setStreamError(null);
    if (drawn.unsent.length > 0) {
      setDraft((current) => [...drawn.unsent, current].filter((text) => text.trim()).join('\n\n'));
      setRedrawNote(
        'The one-to-one moved on in another window. What you had not sent is back in your reply.',
      );
    }
  }, [drawnBehind, kept, messages, setMessages]);
  useTurnDeadline(waitingOnTurn, stop, (): void =>
    setStreamError(`${name} did not answer within ${TURN_DEADLINE_MS / 1000} seconds`),
  );

  // The session drafts on its own; the room says so once it has waited longer than usual.
  useDraftWait(serverPhase.kind === 'drafting' && post.kind === 'idle', (): void =>
    setPost({ kind: 'settled', outcome: lateBy(SYNTHESIS_DEADLINE_MS) }),
  );

  /** Post a transcript for drafting and keep what became of it. */
  function postTranscript(text: string): void {
    setPost({ kind: 'posting' });
    // postCharterSynthesis never rejects: every outcome, failures included, is kept and said.
    void postCharterSynthesis({
      agentId,
      bossLabel,
      transcript: text,
      voiceSessionId: sessionRef.current ?? session?._id ?? null,
    }).then((outcome) => setPost({ kind: 'settled', outcome }));
  }

  // The composer opens once the session holds a question to answer: a reply typed ahead of the
  // opening, or after an opening that failed, answers nothing the session holds and would be
  // refused on every send and every Ask again. A failed opening is asked again from its notice.
  const opened = messages.some(isKeptAnswer);
  // A call in another window holds the session now: nothing this room writes belongs to it.
  const composerDisabled = composerLocked({ status, done: over, opened }) || movedToCall;

  function send(): void {
    const trimmed = draft.trim().slice(0, REPLY_MAX_CHARS);
    if (!trimmed || composerDisabled) return;
    setStreamError(null);
    setFinishFailure(null);
    setRedrawNote(null);
    // An answer that failed is not one the session holds; the reply answers the question before
    // it, so the failed words leave the page rather than stand as the question being answered.
    const last = messages.at(-1);
    if (last?.role === 'assistant' && !isKeptAnswer(last)) setMessages(messages.slice(0, -1));
    // A turn that fails is reported through useChat's onError, which says it in the room.
    void sendMessage({ text: trimmed });
    setDraft('');
    // The session clears the reply being typed when it takes the reply.
    keptDraft.current = '';
  }

  function retryTurn(): void {
    setStreamError(null);
    // askAgain reports its own failure through setStreamError and never rejects.
    void askAgain({ messages, regenerate, sendMessage });
  }

  /**
   * End the one-to-one at the manager's word: the session drafts from what it kept. A reply the
   * room shows that never reached the session is not left out silently: the manager chose to
   * finish without it (`withoutUnsent`), and it leaves the page with the choice.
   */
  function finish(withoutUnsent: readonly SentReply[] = []): void {
    setStreamError(null);
    setFinishFailure(null);
    const sessionId = sessionRef.current ?? session?._id;
    if (!sessionId || conversation === null) return;
    // The page as it stood, so a Finish that fails puts back what the manager chose to leave out.
    const shown = messages;
    if (withoutUnsent.length > 0) {
      const set = new Set(withoutUnsent.map((reply: SentReply): string => reply.id));
      setMessages(messages.filter((m: UIMessage): boolean => !set.has(m.id)));
    }
    setFinishing(true);
    // The chain ends in its own rejection handler, which says the refusal in the room. A client
    // that has lost its connection queues the mutation and would show "Drafting" for good.
    void withDeadline(
      finishSession({ sessionId, conversation, bossLabel }),
      START_DEADLINE_MS,
      `Day0 could not be reached within ${START_DEADLINE_MS / 1000} seconds`,
    ).then(
      (): void => undefined,
      (err: unknown): void => {
        setFinishing(false);
        if (withoutUnsent.length > 0) setMessages(shown);
        const reason = refusalText(err, 'Day0 could not be reached').replace(/\.$/, '');
        setFinishFailure(`The one-to-one could not finish: ${reason}. Nothing you said is lost.`);
      },
    );
  }

  /** Draft again from what was said: the transcript the session drafts from. */
  function draftAgain(): void {
    const text = session?.pendingTranscript ?? conversationTranscript(kept ?? []);
    if (text) postTranscript(text);
  }

  /**
   * Start over after a draft failed for good: the session sets the failed conversation aside
   * (`voice.restart`), then a new one opens on it.
   */
  function holdAgain(): void {
    if (!session) return;
    // The chain ends in its own rejection handler, which says the refusal in the room.
    void withDeadline(
      restartSession({ sessionId: session._id }),
      START_DEADLINE_MS,
      `${name} did not answer within ${START_DEADLINE_MS / 1000} seconds`,
    ).then(
      () => {
        // The session's stamp has moved on; the start that follows reads the new one.
        setConversation(null);
        setMessages([]);
        setFinishing(false);
        setFinishFailure(null);
        setDraft('');
        keptDraft.current = '';
        onHeldAgain?.();
        setPost({ kind: 'idle' });
        setStreamError(null);
        setStartAttempt((attempt) => attempt + 1);
      },
      (err: unknown) => setStartFailure(refusalText(err, 'The one-to-one could not start again.')),
    );
  }

  /** Ask for the session again after a start that failed. */
  function startAgain(): void {
    setStartFailure(null);
    setStartAttempt((attempt) => attempt + 1);
  }

  return {
    session,
    serverPhase,
    kept,
    messages,
    transcript,
    status,
    over,
    opened,
    composerDisabled,
    movedToCall,
    unsent,
    streamError,
    startFailure,
    finishFailure,
    redrawNote,
    post,
    draft,
    setDraft,
    send,
    askAgain: retryTurn,
    finish,
    draftAgain,
    holdAgain,
    startAgain,
  };
}

/** What the reply keeper is given (`useReplyDraftKeeper`). */
interface ReplyDraftKeeperOptions {
  /** The session the room opened, once its start has answered. */
  readonly sessionId: RefObject<Id<'voiceSessions'> | null>;
  /** The conversation the room draws, null until its start has answered. */
  readonly conversation: number | null;
  /** The one-to-one is over, or a turn is in flight and the session is about to move. */
  readonly paused: boolean;
  /** The reply being typed, with any reply the room shows that never reached the session. */
  readonly typing: string;
  /** The last reply the session kept, which the kept draft follows. */
  readonly after: string | null;
  /** The words the session last took, so an unchanged field is not written again. */
  readonly keptDraft: RefObject<string>;
}

/**
 * Keep the reply being typed on the session once the composer rests, so a room closed mid-reply
 * reopens with it. The words count as kept only once the session took them: a keep refused
 * because another window replied is written again once the room has drawn that reply (`after`
 * changes). A keep that fails costs a crash's worth of typing, and is logged.
 */
function useReplyDraftKeeper({
  sessionId,
  conversation,
  paused,
  typing,
  after,
  keptDraft,
}: ReplyDraftKeeperOptions): void {
  const keepReplyDraft = useMutation(api.oneToOne.keepReplyDraft);
  useEffect(() => {
    const session = sessionId.current;
    if (!session || conversation === null || paused) return;
    if (typing === keptDraft.current) return;
    const timer = setTimeout((): void => {
      // The chain ends in its own rejection handler.
      void keepReplyDraft({ sessionId: session, conversation, text: typing, after }).then(
        (result): void => {
          if (result.kept) keptDraft.current = typing;
        },
        (err: unknown): void => {
          log.warn('reply being typed not kept', { reason: errorMessage(err) });
        },
      );
    }, REPLY_DRAFT_KEEP_MS);
    return () => clearTimeout(timer);
  }, [sessionId, typing, paused, after, conversation, keptDraft, keepReplyDraft]);
}

/**
 * Stop waiting on a turn that never answers, and say so (the hosted walk's m30): the reply is kept
 * on the session, so asking again answers it.
 *
 * @param waiting - Whether a turn is in flight.
 * @param stop - The chat's stop, which settles the turn as aborted.
 * @param timedOut - Says why in the room.
 */
function useTurnDeadline(waiting: boolean, stop: () => Promise<void>, timedOut: () => void): void {
  const said = useRef(timedOut);
  useEffect(() => {
    said.current = timedOut;
  });
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout((): void => {
      // Stopping settles the turn as aborted, which says nothing; the line below says why. The
      // result is discarded because stop only aborts the request in flight and cannot reject, so
      // no rejection is left to land anywhere (the second review's m11).
      void stop();
      said.current();
    }, TURN_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [waiting, stop]);
}

/**
 * Say the draft is taking longer than usual once the session has drafted on its own for
 * `SYNTHESIS_DEADLINE_MS`.
 *
 * @param waiting - Whether the session is drafting and the room has posted nothing itself.
 * @param late - Says so in the room.
 */
function useDraftWait(waiting: boolean, late: () => void): void {
  const said = useRef(late);
  useEffect(() => {
    said.current = late;
  });
  useEffect(() => {
    if (!waiting) return;
    const timer = setTimeout((): void => said.current(), SYNTHESIS_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [waiting]);
}
