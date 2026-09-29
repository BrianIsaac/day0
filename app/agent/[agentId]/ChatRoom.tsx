'use client';

import { useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import { useChat, type UseChatHelpers } from '@ai-sdk/react';
import { DefaultChatTransport, type ChatStatus, type UIMessage } from 'ai';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { INIT_PROMPT, managerReplies } from '@/agent/day-one-turn';
import { DAY_ONE_TOPIC_COUNT, dayOneTurnMetadataOf, topicTitle } from '@/agent/day-one-progress';
import { oneToOnePhase } from '@/agent/one-to-one-phase';
import { answeredCount, transcriptTurns, type TranscriptTurn } from '@/agent/transcript-turns';
import { postCharterSynthesis } from './charter-synthesis';
import { refusalText } from '../../components/use-change';
import { Button } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmployeeContext } from './employee-context';
import { ROOM_HEIGHT } from './room-frame';
import { DraftingNotice, type SynthesisPost } from './one-to-one/DraftingNotice';
import { notedAnswers, type NotedAnswer } from './one-to-one/NotedSoFar';
import { TopicProgress, type TopicProgressState } from './one-to-one/TopicProgress';
import { START_DEADLINE_MS, withDeadline } from './one-to-one/deadline';

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
  // A moderation stop is the provider's refusal, whatever text preceded it.
  if (turn.finishReason === 'content-filter') return "Day0's model provider refused to answer";
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
 * the page.
 */
export async function askAgain(
  chat: Pick<UseChatHelpers<UIMessage>, 'messages' | 'regenerate' | 'sendMessage'>,
): Promise<void> {
  if (chat.messages.length === 0) await chat.sendMessage({ text: INIT_PROMPT });
  else await chat.regenerate();
}

/**
 * The conversation as the charter is drafted from it: one line per turn,
 * speaker first, the priming turn left out and the agent's closing line kept.
 *
 * @returns The turns joined by blank lines.
 */
export function charterTranscript(messages: UIMessage[]): string {
  return withoutPrimingTurn(messages)
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
 * The most characters one reply in the 1:1 may carry. The route bounds only
 * the output, so without this one pasted document is sent whole on every
 * later turn of the conversation.
 */
export const REPLY_MAX_CHARS = 4000;

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
 * The composer's field, labelled for everyone: Enter sends, Shift+Enter starts a new line, and a
 * reply is bounded at `REPLY_MAX_CHARS`.
 */
export function ReplyInput({
  value,
  onChange,
  onSend,
  disabled,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  disabled: boolean;
  placeholder: string;
}) {
  const id = useId();
  return (
    <div className="grid min-w-0 flex-1 gap-1.5">
      <label htmlFor={id} className="text-[13px] font-medium text-[var(--color-fg-2)]">
        Your reply
      </label>
      <textarea
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
        aria-describedby={`${id}-help`}
        enterKeyHint="send"
        className="min-h-11 w-full resize-none rounded-lg border border-[var(--color-border-2)] bg-[var(--color-bg)] px-3 py-2 text-[15px] text-[var(--color-fg)] placeholder:text-[var(--color-muted)] focus:border-[var(--color-accent)] disabled:opacity-50"
      />
      <p id={`${id}-help`} className="text-[13px] text-[var(--color-muted)]">
        Enter sends. Shift+Enter starts a new line. Short answers are enough.
      </p>
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
      <Button variant="retry" size="small" onClick={onAskAgain}>
        Ask again
      </Button>
    </div>
  );
}

/** The question a turn put, as the chat route numbered it, or none before the first turn. */
export function progressOf(messages: readonly UIMessage[]): TopicProgressState {
  const asked = messages.findLast((m) => m.role === 'assistant');
  const metadata = asked ? dayOneTurnMetadataOf(asked.metadata) : undefined;
  return metadata ? { kind: 'asking', topicIndex: metadata.topicIndex } : { kind: 'waiting' };
}

/** A decision the room asks the manager to confirm before it acts. */
type Confirming = 'finish' | 'switch' | null;

/**
 * The Day-1 one-to-one held in text: the question it is on, the transcript, the composer, and,
 * once it is over, the drafting of the charter beside the transcript.
 *
 * The room reads its session as well as holding the conversation: a session already drafting
 * (a reload after Finish, or a draft sent back with a note) is shown drafting from the transcript
 * it stored, and never opened as a new conversation over the draft.
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
  const name = useContext(EmployeeContext)?.agent.name ?? 'Your employee';
  const startSession = useMutation(api.voice.start);
  const session = useQuery(api.voice.latest, { agentId });
  const serverPhase = oneToOnePhase(session);
  const [draft, setDraft] = useState('');
  // A latch, not UI state - nothing renders off it, so a ref keeps the
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
  const [startFailure, setStartFailure] = useState<string | null>(null);
  const [startAttempt, setStartAttempt] = useState(0);
  const [post, setPost] = useState<SynthesisPost>({ kind: 'idle' });
  const [confirming, setConfirming] = useState<Confirming>(null);
  // The manager chose to hold the one-to-one again after a draft failed for good.
  const [heldAgain, setHeldAgain] = useState(false);
  const { messages, sendMessage, regenerate, setMessages, status } = useChat({
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

  const [finishedByManager, setFinishedByManager] = useState(false);
  const closedByAgent = messages.some((m) => m.parts.some((p) => p.type === 'tool-dayOneComplete'));
  const done = closedByAgent || finishedByManager;
  const transcript = withoutPrimingTurn(messages);
  // Drafting on the server without a conversation in this room: the room came back to it.
  const serverOver = serverPhase.kind !== 'talking' && !heldAgain;
  const over = done || serverOver;
  const startable = session !== undefined && !serverOver;

  // Kick the agent's opening turn once the session row exists. Strict Mode
  // invokes this twice and the discarded invocation cancels its own send, so one
  // mount asks one opening question. It still asks for a session twice, and any
  // remount asks again - `voice.start` answers all of them with the same row,
  // which is why nothing here has to be latched to keep the count at one. A
  // session already drafting is not opened again (finding 1 of the wave 6 C
  // handover): the room waits for the session to load before it decides.
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
        // A turn that fails is reported through useChat's onError, which says it in the room.
        if (!cancelled) void sendMessage({ text: INIT_PROMPT });
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

  const noted = useMemo(() => notedAnswers(messages), [messages]);
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

  // Fire charter synthesis once the agent emits the dayOneComplete tool or the
  // manager presses Finish; both end the 1:1 the same way. Naming the session
  // ends it: the row reaches `done` carrying its transcript.
  useEffect(() => {
    if (!done || synthFired.current) return;
    synthFired.current = true;
    postTranscript(charterTranscript(messages));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- posts once, when the 1:1 ends; the transcript is read as it stands then
  }, [done]);

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
    // A turn that fails is reported through useChat's onError, which says it in the room.
    void sendMessage({ text: trimmed });
    setDraft('');
  }

  function retryTurn() {
    setStreamError(null);
    // askAgain reports its own failure through setStreamError and never rejects.
    void askAgain({ messages, regenerate, sendMessage });
  }

  function finish() {
    setConfirming(null);
    setStreamError(null);
    setFinishedByManager(true);
  }

  /** Draft again from what was said: this room's conversation, else the session's own copy. */
  function draftAgain(): void {
    const text = transcript.length > 0 ? charterTranscript(messages) : session?.pendingTranscript;
    if (text) postTranscript(text);
  }

  /** Start over after a draft failed for good: a new conversation on the same session. */
  function holdAgain(): void {
    setMessages([]);
    setFinishedByManager(false);
    synthFired.current = false;
    setPost({ kind: 'idle' });
    setStreamError(null);
    setHeldAgain(true);
    setStartAttempt((attempt) => attempt + 1);
  }

  const answering = status === 'submitted' || status === 'streaming';
  const stored =
    transcript.length === 0 && session?.pendingTranscript
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
          Day-1 one-to-one with {name} · chat
        </h2>
        {over ? (
          <span className="text-[13px] text-[var(--color-muted)]">complete</span>
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
      </div>
      <div className="border-t border-[var(--color-border)] px-4 py-3 sm:px-5">
        {over ? (
          <DraftingNotice
            name={name}
            phase={serverPhase}
            post={post}
            onDraftAgain={draftAgain}
            onHoldAgain={holdAgain}
          />
        ) : (
          <form
            className="flex flex-wrap items-end gap-2"
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
              placeholder={opened ? '' : `Waiting for ${name} to ask the first question`}
            />
            <div className="flex gap-2">
              <Button type="submit" variant="primary" disabled={composerDisabled || !draft.trim()}>
                Send
              </Button>
              <FinishControl
                disabled={!canFinish({ status, done, messages })}
                onFinish={() => setConfirming('finish')}
              />
            </div>
          </form>
        )}
      </div>
      {confirming === 'finish' ? (
        <Dialog title="Finish the one-to-one now?" onClose={() => setConfirming(null)}>
          <p className="text-[15px] text-[var(--color-fg-2)]">
            {name} drafts your charter from what you have said so far.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="primary" onClick={finish}>
              Finish and draft
            </Button>
            <Button onClick={() => setConfirming(null)}>Keep talking</Button>
          </div>
        </Dialog>
      ) : null}
      {confirming === 'switch' && onSwitchMode ? (
        <Dialog title="Switch to voice?" onClose={() => setConfirming(null)}>
          <p className="text-[15px] text-[var(--color-fg-2)]">
            The chat so far is not carried over: the voice one-to-one starts from the first
            question.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
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

/**
 * Split one turn into plain and emphasised runs.
 *
 * The bubble renders the model's text verbatim, and some models write the
 * topic label as `**Topic 4:**`. Terra's recorded run wrote none, so the
 * markers only became visible once another model was configured - and a
 * manager reads this transcript closely. Rendering the emphasis is model-agnostic and
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
              {emphasisSegments((part as { type: 'text'; text: string }).text).map((seg, s) =>
                seg.strong ? (
                  <strong key={s} className="font-semibold">
                    {seg.text}
                  </strong>
                ) : (
                  <span key={s}>{seg.text}</span>
                ),
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
      {turn.text}
    </div>
  );
}
