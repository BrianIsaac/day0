'use client';

import { useContext, useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatStatus, type UIMessage } from 'ai';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { INIT_PROMPT, managerReplies } from '@/agent/day-one-turn';
import { DAY_ONE_TOPIC_COUNT, dayOneTurnMetadataOf, topicTitle } from '@/agent/day-one-progress';
import { oneToOnePhase } from '@/agent/one-to-one-phase';
import { answeredCount, transcriptTurns, type TranscriptTurn } from '@/agent/transcript-turns';
import {
  REPLY_MAX_CHARS,
  answerFailure,
  conversationTranscript,
  isClosed,
  owesAnswer,
  uiMessagesOf,
  type OneToOneTurn,
  type TurnRequest,
} from '@/agent/one-to-one-conversation';
import { errorMessage } from '@/lib/errors';
import { log } from '@/lib/logger';
import { SYNTHESIS_DEADLINE_MS, lateBy, postCharterSynthesis } from './charter-synthesis';
import { refusalText } from '../../components/use-change';
import { Button, buttonClass } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmployeeContext } from './employee-context';
import { ROOM_HEIGHT } from './room-frame';
import {
  DraftingNotice,
  draftingOutcome,
  draftingWords,
  type SynthesisPost,
} from './one-to-one/DraftingNotice';
import { StatusRegion } from '../../components/StatusRegion';
import { notedAnswers, notedFromTranscript, type NotedAnswer } from './one-to-one/NotedSoFar';
import { TopicProgress, type TopicProgressState } from './one-to-one/TopicProgress';
import { START_DEADLINE_MS, TURN_DEADLINE_MS, withDeadline } from './one-to-one/deadline';
import { TurnText } from './one-to-one/TurnText';

function textOf(message: UIMessage): string {
  return message.parts
    .filter((p) => p.type === 'text')
    .map((p) => (p as { type: 'text'; text: string }).text)
    .join('');
}

/** The turns that rise in as they arrive: the manager's last reply and the answer to it. */
const ARRIVING_TURNS = 2;

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
 * the session keeps the conversation and answers from its own (`oneToOne.takeTurn`). A turn asked
 * again names the reply it answers, so a reply whose send never reached the session is kept then.
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
  const last = messages.at(-1);
  const text = last ? textOf(last) : '';
  const reply = last && last.role === 'user' && text.trim() !== INIT_PROMPT ? last : undefined;
  if (trigger === 'regenerate-message') {
    return { kind: 'ask-again', reply: reply ? { id: reply.id, text } : null, discarding };
  }
  return reply ? { kind: 'reply', id: reply.id, text } : { kind: 'open' };
}

/** The last reply the room drew, which a reply being typed follows; null before the first. */
function lastReplyId(messages: readonly UIMessage[]): string | null {
  const reply = messages.findLast(
    (m: UIMessage): boolean => m.role === 'user' && textOf(m).trim() !== INIT_PROMPT,
  );
  return reply?.id ?? null;
}

/**
 * Whether the manager may end the 1:1 now. The agent closes only after every
 * topic and only by a tool call some models never make, so the manager can
 * end it once they have answered at least once and the agent is not mid-turn.
 */
export function canFinish(state: {
  status: ChatStatus;
  done: boolean;
  messages: UIMessage[];
}): boolean {
  const answering = state.status === 'submitted' || state.status === 'streaming';
  return !state.done && !answering && managerReplies(state.messages) > 0;
}

/**
 * How long the composer rests before the reply being typed is kept on the session, so a room
 * closed mid-reply reopens with it. Short enough that little is lost to a crash, long enough that
 * typing is not one write per key.
 */
export const REPLY_DRAFT_KEEP_MS = 800;

/**
 * Whether a key press sends the reply: Enter on its own, and never the Enter that confirms an
 * input method's composition (a Japanese or Chinese reply is composed with Enter), which the
 * browser marks as composing, and Safari as key code 229 after the composition has ended.
 */
export function sendsReply(key: {
  key: string;
  shiftKey: boolean;
  isComposing: boolean;
  keyCode: number;
}): boolean {
  return key.key === 'Enter' && !key.shiftKey && !key.isComposing && key.keyCode !== 229;
}

/**
 * The composer's placeholder once the employee has asked. The bed's rehearsal driver finds the
 * composer by it (`scripts/bed/rehearsal/driver.ts`), so it changes with the driver.
 */
export const REPLY_PLACEHOLDER = 'type your reply…';

/** How to send a reply, said under the composer and read with the field. */
export const REPLY_HELP = 'Enter sends. Shift+Enter starts a new line. Short answers are enough.';

/**
 * The composer's field, labelled for everyone: Enter sends, Shift+Enter starts a new line, and a
 * reply is bounded at `REPLY_MAX_CHARS`.
 *
 * @param helpId - The id of the line that says how to send, which the field is described by.
 */
export function ReplyInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
  helpId,
  inputRef,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
  helpId: string;
  inputRef?: Ref<HTMLTextAreaElement>;
}) {
  const id = useId();
  return (
    <div className="grid gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-[var(--color-fg-2)]">
        Your reply
      </label>
      <textarea
        ref={inputRef}
        id={id}
        value={value}
        rows={2}
        maxLength={REPLY_MAX_CHARS}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (!sendsReply({ ...e, isComposing: e.nativeEvent.isComposing })) return;
          e.preventDefault();
          onSend();
        }}
        disabled={disabled}
        placeholder={placeholder}
        aria-describedby={helpId}
        enterKeyHint="send"
        className="min-h-11 w-full resize-none rounded-lg border border-[var(--color-border-2)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-accent)] disabled:opacity-50"
      />
    </div>
  );
}

/** The manager's control for ending the 1:1 and drafting the charter from it. */
export function FinishControl({ disabled, onFinish }: { disabled: boolean; onFinish: () => void }) {
  return (
    <Button
      onClick={onFinish}
      disabled={disabled}
      title="End the 1:1 and draft the charter from what you have said so far"
    >
      Finish
    </Button>
  );
}

/** Why the employee's last turn did not arrive, with the control that asks it again. */
export function TurnFailureNotice({
  failure,
  onAskAgain,
}: {
  failure: string;
  onAskAgain: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 text-sm text-[var(--color-warn)]"
    >
      <span>{failure.replace(/\.$/, '')}.</span>
      {/* A plain button, drawn as the shared one: the bed's rehearsal driver reads this control's markup. */}
      <button type="button" className={buttonClass('retry', 'small')} onClick={onAskAgain}>
        Ask again
      </button>
    </div>
  );
}

/** The question a turn put, as the chat route numbered it, or none before the first turn. */
export function progressOf(messages: readonly UIMessage[]): TopicProgressState {
  const asked = messages.findLast((m) => m.role === 'assistant');
  const metadata = asked ? dayOneTurnMetadataOf(asked.metadata) : undefined;
  return metadata ? { kind: 'asking', topicIndex: metadata.topicIndex } : { kind: 'waiting' };
}

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

/** A decision the room asks the manager to confirm before it acts. */
type Confirming = 'finish' | 'switch' | null;

/**
 * The Day-1 one-to-one held in text: the question it is on, the transcript, the composer, and,
 * once it is over, the drafting of the charter beside the transcript.
 *
 * The session holds the conversation, turn by turn (`convex/oneToOne.ts`); the room draws it. A
 * room opened on a conversation under way (a reload, a closed tab, a crash, a lost connection)
 * carries on from its last kept turn: the reply being typed back in the composer, and an answer
 * the employee still owes asked for again. A session already drafting (the close kept, Finish, or
 * a draft sent back with a note) is shown drafting from what it kept, and never opened as a new
 * conversation over the draft; the draft itself runs on the server from the close.
 *
 * @param onNoted - Told the answers so far whenever they change, for the page's "Noted so far".
 */
export function ChatRoom({
  agentId,
  bossLabel,
  onSwitchMode,
  onNoted,
}: {
  agentId: Id<'agents'>;
  bossLabel: string;
  onSwitchMode?: () => void;
  onNoted?: (answers: readonly NotedAnswer[]) => void;
}) {
  const employee = useContext(EmployeeContext);
  const name = employee?.agent.name ?? 'Your employee';
  const startSession = useMutation(api.voice.start);
  const restartSession = useMutation(api.voice.restart);
  const finishSession = useMutation(api.oneToOne.finish);
  const keepReplyDraft = useMutation(api.oneToOne.keepReplyDraft);
  const session = useQuery(api.voice.latest, { agentId });
  const serverPhase = oneToOnePhase(session);
  const [draft, setDraft] = useState('');
  // The reply being typed as the session last kept it, so an unchanged field is not written again.
  const keptDraft = useRef('');
  // The session this 1:1 belongs to, read by Finish and the reply keeper. A ref rather than state
  // because they must see the id the mount effect obtained, not whatever a stale render closed
  // over.
  const sessionRef = useRef<Id<'voiceSessions'> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Set when the manager holds the one-to-one again: the composer takes focus once it is back.
  const refocusReply = useRef(false);

  const transport = useMemo(() => chatTurnTransport(agentId, bossLabel), [agentId, bossLabel]);

  const [streamError, setStreamError] = useState<string | null>(null);
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [post, setPost] = useState<SynthesisPost>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<Confirming>(null);
  const { messages, sendMessage, regenerate, setMessages, status, stop } = useChat({
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
    (serverPhase.kind === 'drafted' && employee?.agent.state !== 'deployed');
  const over = done || serverOver;
  const startable = session !== undefined && !serverOver;

  /**
   * Carry the conversation on from where the session holds it, or open it when it holds none. The
   * employee still owes an answer when the manager's reply is the last kept turn (the room closed
   * while it answered), so that turn is asked for again.
   */
  function resume(conversation: {
    readonly turns: readonly OneToOneTurn[];
    readonly replyDraft: string | null;
  }): void {
    if (conversation.turns.length === 0) {
      // A turn that fails is reported through useChat's onError, which says it in the room.
      void sendMessage({ text: INIT_PROMPT });
      return;
    }
    setMessages(uiMessagesOf(conversation.turns));
    const typed = conversation.replyDraft ?? '';
    keptDraft.current = typed;
    if (typed) setDraft((current) => current || typed);
    // As above: a turn asked again that fails is said in the room by onError.
    if (owesAnswer(conversation.turns)) void regenerate();
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
    withDeadline(
      startSession({ agentId, mode: 'chat' }),
      START_DEADLINE_MS,
      `${name} did not answer within ${START_DEADLINE_MS / 1000} seconds`,
    ).then(
      (started) => {
        sessionRef.current = started.sessionId;
        if (!cancelled) resume(started);
      },
      // A 1:1 that could not start says why, with the way to try again,
      // rather than leaving the composer waiting for an opening that never comes.
      (err: unknown) => {
        if (!cancelled) setStartFailure(refusalText(err, 'The 1:1 could not start.'));
      },
    );
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

  // Keep the reply being typed once the composer rests, so a room closed mid-reply reopens with it.
  const after = lastReplyId(messages);
  useEffect(() => {
    const sessionId = sessionRef.current;
    if (!sessionId || over || draft === keptDraft.current) return;
    const timer = setTimeout((): void => {
      keptDraft.current = draft;
      // The reply is still in the field; a keep that fails costs only a crash's worth of typing.
      void keepReplyDraft({ sessionId, text: draft, after }).catch((err: unknown): void => {
        log.warn('reply being typed not kept', { reason: errorMessage(err) });
      });
    }, REPLY_DRAFT_KEEP_MS);
    return () => clearTimeout(timer);
  }, [draft, over, after, keepReplyDraft]);

  // A turn that never answers stops being waited on, with Ask again (hosted walk m30): the reply
  // is kept on the session, so asking again answers it.
  const waitingOnTurn = status === 'submitted' || status === 'streaming';
  useEffect(() => {
    if (!waitingOnTurn) return;
    const timer = setTimeout((): void => {
      // Stopping settles the turn as aborted, which says nothing; the line below says why.
      void stop();
      setStreamError(`${name} did not answer within ${TURN_DEADLINE_MS / 1000} seconds`);
    }, TURN_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [waitingOnTurn, stop, name]);

  // The session drafts on its own; the room says so once it has waited longer than usual.
  const waitingOnDraft = serverPhase.kind === 'drafting' && post.kind === 'idle';
  useEffect(() => {
    if (!waitingOnDraft) return;
    const timer = setTimeout(
      (): void => setPost({ kind: 'settled', outcome: lateBy(SYNTHESIS_DEADLINE_MS) }),
      SYNTHESIS_DEADLINE_MS,
    );
    return () => clearTimeout(timer);
  }, [waitingOnDraft]);

  // Keep the newest turn in view as it streams. An instant jump, not a smooth
  // scroll: a smooth one replayed on every streamed chunk (round two 4.4).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const id = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight });
    });
    return () => cancelAnimationFrame(id);
  }, [messages]);

  const pendingTranscript = session?.pendingTranscript;
  const noted = useMemo(
    () =>
      messages.length > 0 || !pendingTranscript
        ? notedAnswers(messages)
        : notedFromTranscript(pendingTranscript),
    [messages, pendingTranscript],
  );
  useEffect(() => {
    onNoted?.(noted);
  }, [noted, onNoted]);

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

  // The opening turn is sent from an effect, so for a moment after mount the
  // composer is live with nothing yet asked. A reply typed into that gap arrives
  // ahead of the agent's own first turn and answers a question it has not put -
  // an error surfaces instead, because then there is nothing else to wait for.
  const opened = messages.some((m) => m.role === 'assistant') || !!streamError;
  const composerDisabled = composerLocked({ status, done: over, opened });

  function send() {
    const trimmed = draft.trim().slice(0, REPLY_MAX_CHARS);
    if (!trimmed || composerDisabled) return;
    setStreamError(null);
    setFinishFailure(null);
    // A turn that fails is reported through useChat's onError, which says it in the room.
    void sendMessage({ text: trimmed });
    setDraft('');
    // The session clears the reply being typed when it takes the reply.
    keptDraft.current = '';
  }

  function retryTurn() {
    setStreamError(null);
    // askAgain reports its own failure through setStreamError and never rejects.
    void askAgain({ messages, regenerate, sendMessage });
  }

  /** End the one-to-one at the manager's word: the session drafts from what it kept. */
  function finish(): void {
    setConfirming(null);
    setStreamError(null);
    setFinishFailure(null);
    const sessionId = sessionRef.current ?? session?._id;
    if (!sessionId) return;
    setFinishing(true);
    // The chain ends in its own rejection handler, which says the refusal in the room.
    void finishSession({ sessionId, bossLabel }).then(
      (): void => undefined,
      (err: unknown): void => {
        setFinishing(false);
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
        setMessages([]);
        setFinishing(false);
        setFinishFailure(null);
        setDraft('');
        keptDraft.current = '';
        refocusReply.current = true;
        setPost({ kind: 'idle' });
        setStreamError(null);
        setStartAttempt((attempt) => attempt + 1);
      },
      (err: unknown) => setStartFailure(refusalText(err, 'The one-to-one could not start again.')),
    );
  }

  const words = over ? draftingWords(name, serverPhase, post) : null;
  const drafting = words === null ? null : words.failed ? 'failed' : 'drafting';

  // Focus follows the room when the control that moved it has left the page: Finish, Draft
  // again and Hold again each unmount their own button.
  useEffect(() => {
    const lost = document.activeElement === null || document.activeElement === document.body;
    if (drafting !== null && lost) noticeRef.current?.focus();
    if (drafting === null && opened && refocusReply.current) {
      refocusReply.current = false;
      replyRef.current?.focus();
    }
  }, [drafting, opened]);

  const answering = status === 'submitted' || status === 'streaming';
  // A session drafting from a transcript it kept no turns for (a call, or a draft from before the
  // turns were kept) is drawn from the transcript itself.
  const stored =
    transcript.length === 0 && !kept?.length && session?.pendingTranscript
      ? transcriptTurns(session.pendingTranscript)
      : [];
  const progress: TopicProgressState = over
    ? {
        kind: 'answered',
        count: stored.length > 0 ? answeredCount(stored) : managerReplies(messages),
      }
    : progressOf(messages);

  return (
    <section
      aria-labelledby={`${agentId}-room-title`}
      className={`flex flex-col rounded-xl border border-[var(--color-accent-line)] bg-[var(--color-card)] ${ROOM_HEIGHT}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 border-b border-[var(--color-border)] px-4 py-2 sm:px-5">
        <h2 id={`${agentId}-room-title`} className="py-2.5 text-[15px] font-semibold">
          Day-1 1:1 · chat mode
        </h2>
        {over ? (
          <span className="text-[13px] text-[var(--color-muted)]">conversation complete</span>
        ) : onSwitchMode ? (
          <Button
            variant="text"
            size="small"
            onClick={() => (transcript.length > 0 ? setConfirming('switch') : onSwitchMode())}
          >
            Switch to voice
          </Button>
        ) : null}
      </header>
      <div className="px-4 pt-3 sm:px-5">
        <TopicProgress progress={progress} />
      </div>
      <div
        ref={scrollRef}
        tabIndex={0}
        role="log"
        aria-label="The 1:1 so far"
        // A turn streams in token by token; the log is read once it is whole.
        aria-busy={answering}
        className="grid flex-1 content-start gap-3.5 overflow-y-auto px-4 py-3 sm:px-5"
      >
        {transcript.map((m, index) => (
          <MessageBubble
            key={m.id}
            message={m}
            arrive={index >= transcript.length - ARRIVING_TURNS}
          />
        ))}
        {stored.map((turn, index) => (
          <StoredBubble key={index} turn={turn} />
        ))}
        {status === 'submitted' ? (
          <p
            role="status"
            className={`${BUBBLE} ${EMPLOYEE_BUBBLE} text-[var(--color-muted)] italic`}
          >
            {name} is thinking…
          </p>
        ) : null}
        {startFailure ? (
          <TurnFailureNotice
            failure={startFailure}
            onAskAgain={() => {
              setStartFailure(null);
              setStartAttempt((attempt) => attempt + 1);
            }}
          />
        ) : null}
        {streamError && !over ? (
          <TurnFailureNotice failure={streamError} onAskAgain={retryTurn} />
        ) : null}
        {finishFailure && !over ? (
          <p role="alert" className="text-sm text-[var(--color-warn)]">
            {finishFailure}
          </p>
        ) : null}
      </div>
      <div className="border-t border-[var(--color-border)] px-4 py-3 sm:px-5">
        {/* On the page before the words change, so the drafting line is said as it changes. */}
        <div className="sr-only">
          <StatusRegion outcome={words ? draftingOutcome(words) : null} />
        </div>
        {over ? (
          <DraftingNotice
            name={name}
            phase={serverPhase}
            post={post}
            onDraftAgain={draftAgain}
            onHoldAgain={holdAgain}
            focusRef={noticeRef}
          />
        ) : (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              send();
            }}
          >
            <ReplyInput
              value={draft}
              onChange={setDraft}
              onSend={send}
              disabled={composerDisabled}
              placeholder={opened ? REPLY_PLACEHOLDER : `waiting for ${name}…`}
              inputRef={replyRef}
              helpId={`${agentId}-reply-help`}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button type="submit" variant="primary" disabled={composerDisabled || !draft.trim()}>
                Send
              </Button>
              <FinishControl
                disabled={!canFinish({ status, done: over, messages })}
                onFinish={() => setConfirming('finish')}
              />
              <p id={`${agentId}-reply-help`} className="text-[13px] text-[var(--color-muted)]">
                {REPLY_HELP}
              </p>
            </div>
          </form>
        )}
      </div>
      {confirming === 'finish' ? (
        <Dialog
          title="Finish the one-to-one now?"
          description={`${name} drafts your charter from what you have said so far.`}
          onClose={() => setConfirming(null)}
        >
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" onClick={finish}>
              Finish and draft
            </Button>
            <Button onClick={() => setConfirming(null)}>Keep talking</Button>
          </div>
        </Dialog>
      ) : null}
      {confirming === 'switch' && onSwitchMode ? (
        <Dialog
          title="Switch to voice?"
          description="The chat so far is not carried over: the voice one-to-one starts from the first question."
          onClose={() => setConfirming(null)}
        >
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              onClick={() => {
                setConfirming(null);
                onSwitchMode();
              }}
            >
              Switch to voice
            </Button>
            <Button onClick={() => setConfirming(null)}>Stay in chat</Button>
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}

/** A turn of the one-to-one, as either side's bubble draws it. */
const BUBBLE =
  'max-w-[92%] rounded-xl border px-4 py-3 text-[15px] leading-normal whitespace-pre-wrap sm:max-w-[76%]';

/** The employee's side: on the page, its tail to the left. */
const EMPLOYEE_BUBBLE =
  'justify-self-start rounded-bl-[4px] border-[var(--color-border)] bg-[var(--color-bg)]';

/** The manager's side: on the accent's tint, its tail to the right. */
const MANAGER_BUBBLE =
  'justify-self-end rounded-br-[4px] border-[var(--color-accent-line)] bg-[var(--color-accent-soft)]';

/** The question an employee turn put, as the chat route numbered it. */
function TopicLabel({ message }: { message: UIMessage }) {
  const metadata =
    message.role === 'assistant' ? dayOneTurnMetadataOf(message.metadata) : undefined;
  if (!metadata) return null;
  return (
    <span className="mb-1 block text-xs font-semibold text-[var(--color-accent)]">
      {metadata.topicIndex + 1} of {DAY_ONE_TOPIC_COUNT} · {topicTitle(metadata.topicIndex)}
    </span>
  );
}

/**
 * One turn of the 1:1. `arrive` marks it among the newest, which rise in as they arrive (v3
 * section 5.2); the transcript above them stays still.
 */
function MessageBubble({ message, arrive }: { message: UIMessage; arrive: boolean }) {
  const manager = message.role === 'user';
  return (
    <div
      data-arrive={arrive ? '' : undefined}
      className={`${BUBBLE} ${manager ? MANAGER_BUBBLE : EMPLOYEE_BUBBLE}`}
    >
      {/* The side and the colour say who spoke to a sighted reader; this says it to everyone else. */}
      <span className="sr-only">{manager ? 'You: ' : 'Employee: '}</span>
      <TopicLabel message={message} />
      {message.parts.map((part, i) => {
        if (part.type === 'text') {
          return (
            <span key={i}>
              {manager ? (
                (part as { type: 'text'; text: string }).text
              ) : (
                <TurnText text={(part as { type: 'text'; text: string }).text} />
              )}
            </span>
          );
        }
        if (part.type === 'tool-dayOneComplete') {
          const input = (part as { input?: { closingLine?: string } }).input;
          return (
            <span key={i} className="mt-1 block text-[var(--color-ok)] italic">
              {input?.closingLine ?? '(closing)'}
            </span>
          );
        }
        return null;
      })}
    </div>
  );
}

/** One turn of a transcript the session stored, drawn as the conversation drew it. */
function StoredBubble({ turn }: { turn: TranscriptTurn }) {
  const manager = turn.speaker === 'manager';
  return (
    <div className={`${BUBBLE} ${manager ? MANAGER_BUBBLE : EMPLOYEE_BUBBLE}`}>
      <span className="sr-only">{manager ? 'You: ' : 'Employee: '}</span>
      {manager ? turn.text : <TurnText text={turn.text} />}
    </div>
  );
}
