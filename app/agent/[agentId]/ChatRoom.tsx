'use client';

import { useContext, useEffect, useId, useMemo, useRef, useState, type Ref } from 'react';
import type { ChatStatus, UIMessage } from 'ai';
import type { Id } from '@convex/_generated/dataModel';
import { managerReplies } from '@/agent/day-one-turn';
import { dayOneTurnMetadataOf } from '@/agent/day-one-progress';
import { answeredCount, transcriptTurns, type TranscriptTurn } from '@/agent/transcript-turns';
import { REPLY_MAX_CHARS, repliesIn, type SentReply } from '@/agent/one-to-one-conversation';
import { Button, buttonClass } from '../../components/Button';
import { Dialog } from '../../components/Dialog';
import { EmployeeContext } from './employee-context';
import { ROOM_HEIGHT } from './room-frame';
import { DraftingNotice, draftingOutcome, draftingWords } from './one-to-one/DraftingNotice';
import { StatusRegion } from '../../components/StatusRegion';
import { notedAnswers, notedFromTranscript, type NotedAnswer } from './one-to-one/NotedSoFar';
import { TopicProgress, type TopicProgressState } from './one-to-one/TopicProgress';
import { TurnText } from './one-to-one/TurnText';
import { useOneToOneSession } from './one-to-one/use-one-to-one-session';

// The session wiring's own helpers, where the room's tests and the rehearsal driver read them.
export {
  REPLY_DRAFT_KEEP_MS,
  askAgain,
  chatTurnTransport,
  composerLocked,
  errorLine,
  turnFailure,
  turnRequestFor,
} from './one-to-one/use-one-to-one-session';

/** The turns that rise in as they arrive: the manager's last reply and the answer to it. */
const ARRIVING_TURNS = 2;

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
  const scrollRef = useRef<HTMLDivElement>(null);
  const noticeRef = useRef<HTMLDivElement>(null);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  // Set when the manager holds the one-to-one again: the composer takes focus once it is back.
  const refocusReply = useRef(false);
  const [confirming, setConfirming] = useState<Confirming>(null);
  const room = useOneToOneSession({
    agentId,
    bossLabel,
    name,
    employeeState: employee?.agent.state,
    onHeldAgain: (): void => {
      refocusReply.current = true;
    },
  });
  const { session, kept, messages, transcript, status, over, opened, unsent } = room;

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

  const words = over ? draftingWords(name, room.serverPhase, room.post) : null;
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
    transcript.length === 0 && !kept?.length && pendingTranscript
      ? transcriptTurns(pendingTranscript)
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
        {room.startFailure ? (
          <TurnFailureNotice failure={room.startFailure} onAskAgain={room.startAgain} />
        ) : null}
        {room.streamError && !over ? (
          <TurnFailureNotice failure={room.streamError} onAskAgain={room.askAgain} />
        ) : null}
        {room.finishFailure && !over ? (
          <p role="alert" className="text-sm text-[var(--color-warn)]">
            {room.finishFailure}
          </p>
        ) : null}
        {room.movedToCall ? (
          <p role="status" className="text-sm text-[var(--color-muted)]">
            The one-to-one moved to a call in another window. Reload to carry on.
          </p>
        ) : null}
        {room.redrawNote && !over ? (
          <p role="status" className="text-sm text-[var(--color-muted)]">
            {room.redrawNote}
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
            phase={room.serverPhase}
            post={room.post}
            onDraftAgain={room.draftAgain}
            onHoldAgain={room.holdAgain}
            focusRef={noticeRef}
          />
        ) : (
          <form
            className="grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              room.send();
            }}
          >
            <ReplyInput
              value={room.draft}
              onChange={room.setDraft}
              onSend={room.send}
              disabled={room.composerDisabled}
              placeholder={opened ? REPLY_PLACEHOLDER : `waiting for ${name}…`}
              inputRef={replyRef}
              helpId={`${agentId}-reply-help`}
            />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <Button
                type="submit"
                variant="primary"
                disabled={room.composerDisabled || !room.draft.trim()}
              >
                Send
              </Button>
              <FinishControl
                disabled={room.movedToCall || !canFinish({ status, done: over, messages })}
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
        <FinishDialog
          name={name}
          unsent={unsent}
          anyKept={repliesIn(kept ?? []) > 0}
          onSendFirst={(): void => {
            setConfirming(null);
            room.askAgain();
          }}
          onFinish={(withoutUnsent: readonly SentReply[]): void => {
            setConfirming(null);
            room.finish(withoutUnsent);
          }}
          onKeepTalking={(): void => setConfirming(null)}
        />
      ) : null}
      {confirming === 'switch' && onSwitchMode ? (
        <SwitchDialog
          onSwitch={(): void => {
            setConfirming(null);
            onSwitchMode();
          }}
          onStay={(): void => setConfirming(null)}
        />
      ) : null}
    </section>
  );
}

/** What the Finish dialog is told: whom it drafts, what never reached them, and the three ways on. */
interface FinishDialogProps {
  readonly name: string;
  /** The replies the room shows that never reached the session. */
  readonly unsent: readonly SentReply[];
  /** Whether the session kept a reply, so finishing without the unsent ones drafts from some. */
  readonly anyKept: boolean;
  readonly onSendFirst: () => void;
  readonly onFinish: (withoutUnsent: readonly SentReply[]) => void;
  readonly onKeepTalking: () => void;
}

/**
 * Confirm finishing the one-to-one. A reply the room shows that never reached the session is named,
 * with Send it first, Finish without it (only when the session kept a reply to draft from) and Keep
 * talking; otherwise Finish and draft.
 */
function FinishDialog({
  name,
  unsent,
  anyKept,
  onSendFirst,
  onFinish,
  onKeepTalking,
}: FinishDialogProps) {
  if (unsent.length === 0) {
    return (
      <Dialog
        title="Finish the one-to-one now?"
        description={`${name} drafts your charter from what you have said so far.`}
        onClose={onKeepTalking}
      >
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => onFinish([])}>
            Finish and draft
          </Button>
          <Button onClick={onKeepTalking}>Keep talking</Button>
        </div>
      </Dialog>
    );
  }
  return (
    <Dialog
      title={
        unsent.length > 1
          ? `Your last replies have not reached ${name}`
          : `Your last reply has not reached ${name}`
      }
      description={`${name} drafts your charter from what reached it. ${
        anyKept
          ? 'Send it first, then finish, or finish without it.'
          : 'Send it first, then finish.'
      }`}
      onClose={onKeepTalking}
    >
      <blockquote className="mb-4 border-l-2 border-[var(--color-accent-line)] pl-3 text-sm whitespace-pre-wrap text-[var(--color-fg-2)]">
        {unsent.map((reply) => reply.text).join('\n\n')}
      </blockquote>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSendFirst}>
          Send it first
        </Button>
        {anyKept ? (
          <Button variant="danger" onClick={() => onFinish(unsent)}>
            Finish without it
          </Button>
        ) : null}
        <Button onClick={onKeepTalking}>Keep talking</Button>
      </div>
    </Dialog>
  );
}

/** What the switch confirmation is given: the two ways on. */
interface SwitchDialogProps {
  readonly onSwitch: () => void;
  readonly onStay: () => void;
}

/** Confirm leaving the chat for a call, which starts from the first question. */
function SwitchDialog({ onSwitch, onStay }: SwitchDialogProps) {
  return (
    <Dialog
      title="Switch to voice?"
      description="The chat so far is not carried over: the voice one-to-one starts from the first question."
      onClose={onStay}
    >
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onSwitch}>
          Switch to voice
        </Button>
        <Button onClick={onStay}>Stay in chat</Button>
      </div>
    </Dialog>
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
          // The model's own input, unvalidated while it streams and kept as sent when the call
          // fails its schema: a closing line that is not text (a model echoing the tool's schema
          // back) is drawn as the close, never handed to React as a child.
          const line = (part as { input?: { closingLine?: unknown } }).input?.closingLine;
          return (
            <span key={i} className="mt-1 block text-[var(--color-ok)] italic">
              {typeof line === 'string' && line.trim() !== '' ? line : '(closing)'}
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
