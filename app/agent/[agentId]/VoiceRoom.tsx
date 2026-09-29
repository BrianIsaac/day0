'use client';

import { useContext, useEffect, useRef, useState } from 'react';
import { useConversation, ConversationProvider } from '@elevenlabs/react';
import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { oneToOnePhase } from '@/agent/one-to-one-phase';
import { answeredCount, transcriptTurns, type TranscriptTurn } from '@/agent/transcript-turns';
import { postCharterSynthesis } from './charter-synthesis';
import { refusalText } from '../../components/use-change';
import { Button } from '../../components/Button';
import { EmployeeContext } from './employee-context';
import { ROOM_HEIGHT } from './room-frame';
import { DraftingNotice, type SynthesisPost } from './one-to-one/DraftingNotice';
import { TopicProgress } from './one-to-one/TopicProgress';
import { START_DEADLINE_MS, withDeadline } from './one-to-one/deadline';

interface StartResponse {
  /** False when the deployment has no ElevenLabs credentials. */
  configured: boolean;
  agentId: string | null;
  signedUrl: string | null;
  public: boolean;
  warning?: string;
  reason?: string;
}

interface InboundMessage {
  source: 'ai' | 'user';
  message: string;
}

/**
 * ElevenLabs Conversational AI widget. Per the @elevenlabs/react v1.x
 * SDK migration:
 *   - useConversation requires a ConversationProvider ancestor.
 *   - startSession() is sync and returns void; errors come via onError.
 *   - onConnect receives `{ conversationId }`.
 *   - onError receives `(message: string, context?: any)` - first arg
 *     is the plain string, not an object with `.message`.
 *   - micMuted is a controlled prop; isSpeaking / isListening expose
 *     the agent's turn state.
 */
export function VoiceRoom(props: {
  agentId: Id<'agents'>;
  bossLabel: string;
  onSwitchMode?: () => void;
}) {
  return (
    <ConversationProvider>
      <VoiceRoomInner {...props} />
    </ConversationProvider>
  );
}

function VoiceRoomInner({
  agentId,
  bossLabel,
  onSwitchMode,
}: {
  agentId: Id<'agents'>;
  bossLabel: string;
  onSwitchMode?: () => void;
}) {
  const name = useContext(EmployeeContext)?.agent.name ?? 'Your employee';
  const startSession = useMutation(api.voice.start);
  const attachConversationId = useMutation(api.voice.attachConversationId);
  const stored = useQuery(api.voice.latest, { agentId });
  const serverPhase = oneToOnePhase(stored);
  const [post, setPost] = useState<SynthesisPost>({ kind: 'idle' });
  // The manager chose to hold the one-to-one again after a draft failed for good.
  const [heldAgain, setHeldAgain] = useState(false);
  const [session, setSession] = useState<{
    id: Id<'voiceSessions'>;
    webhookToken: string;
  } | null>(null);
  // The SDK captures its callbacks once, so `onConnect` and `onDisconnect` see
  // whatever `session` held on the render that created them - null, for a call
  // started in the same tick. A ref is what the callbacks can read the live
  // value from, and the session id is the key both finalisation paths agree on:
  // without it here, the browser's post cannot be recognised as the same work
  // the webhook reports.
  const sessionRef = useRef<{ id: Id<'voiceSessions'>; webhookToken: string } | null>(null);
  const finalisePosted = useRef(false);
  const [start, setStart] = useState<StartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<InboundMessage[]>([]);
  const transcriptRef = useRef<HTMLDivElement>(null);
  // Push-to-talk: start muted so the agent isn't constantly listening.
  // The boss taps "Tap to speak" to send audio, taps again to stop.
  const [muted, setMuted] = useState(true);

  const conversation = useConversation({
    micMuted: muted,
    onConnect: ({ conversationId }: { conversationId: string }) => {
      setError(null);
      const current = sessionRef.current;
      if (current && conversationId) {
        attachConversationId({
          sessionId: current.id,
          elevenLabsConversationId: conversationId,
        }).catch(() => {
          // Non-fatal - the post-call webhook records the conversation id
          // itself when this never lands.
        });
      }
    },
    // One post per call, and deliberately one: the page is usually being torn
    // down as this resolves, so a browser-side retry is a promise this component
    // cannot keep. The latch stops a second post; what covers a post that fails
    // is the deployment re-driving the session itself, which is scheduled the
    // moment the failed attempt hands its claim back.
    onDisconnect: () => {
      if (finalisePosted.current) return;
      setTranscript((current) => {
        const text = transcriptText(current);
        if (text) {
          finalisePosted.current = true;
          postTranscript(text);
        }
        return current;
      });
    },
    onMessage: (m: InboundMessage) => {
      setTranscript((prev) => [...prev, m]);
    },
    onError: (message: string) => setError(message || 'voice error'),
  });

  // An instant jump to the newest line: a smooth scroll replayed on every line (round two 4.4).
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight });
  }, [transcript]);

  useEffect(() => {
    if (!start) {
      fetch('/api/voice/elevenlabs/start', { signal: AbortSignal.timeout(START_DEADLINE_MS) })
        .then((r) => r.json())
        .then((data: StartResponse | { error: string }) => {
          if ('error' in data) {
            setError(data.error);
          } else {
            setStart(data);
            if (data.warning) {
              setError(
                `${data.warning}. Falling back to public agent mode - voice will work if the agent is configured for public access.`,
              );
            }
          }
        })
        .catch((err: unknown) =>
          setError(
            err instanceof DOMException && err.name === 'TimeoutError'
              ? `Voice did not answer within ${START_DEADLINE_MS / 1000} seconds`
              : refusalText(err, 'Voice could not be reached').replace(/\.$/, ''),
          ),
        );
    }
  }, [start]);

  /** Post a transcript for drafting and keep what became of it. */
  function postTranscript(text: string): void {
    setPost({ kind: 'posting' });
    // postCharterSynthesis never rejects: every outcome, failures included, is kept and said.
    void postCharterSynthesis({
      agentId,
      bossLabel,
      transcript: text,
      voiceSessionId: sessionRef.current?.id ?? stored?._id ?? null,
    }).then((outcome) => setPost({ kind: 'settled', outcome }));
  }

  /** Open the session row, then the call; a refusal of either is said in the room. */
  function onStart(): void {
    setError(null);
    // The chain ends in its own catch, which says the refusal in the room's alert.
    void startCall().catch((err: unknown) =>
      setError(refusalText(err, 'The voice 1:1 could not start').replace(/\.$/, '')),
    );
  }

  async function startCall(): Promise<void> {
    if (!start || !start.configured || !start.agentId) return;
    let current = session;
    if (!current) {
      const started = await withDeadline(
        startSession({ agentId, mode: 'elevenlabs' }),
        START_DEADLINE_MS,
        `${name} did not answer within ${START_DEADLINE_MS / 1000} seconds`,
      );
      current = { id: started.sessionId, webhookToken: started.webhookToken };
      sessionRef.current = current;
      finalisePosted.current = false;
      setSession(current);
    }
    // `internal_session_token` round-trips through ElevenLabs and comes back on
    // the post-call webhook, which is how that route proves the transcript
    // belongs to this session. Read from `current`, not state: the connection
    // can be up before React has committed the setState above.
    await conversation.startSession({
      ...(start.signedUrl ? { signedUrl: start.signedUrl } : { agentId: start.agentId }),
      dynamicVariables: {
        boss_label: bossLabel,
        internal_agent_id: agentId,
        internal_session_token: current.webhookToken,
      },
    });
  }

  function onStop() {
    conversation.endSession();
  }

  const status = conversation.status;
  const isConnected = status === 'connected';
  const isSpeaking = conversation.isSpeaking;
  const isListening = conversation.isListening;

  // No ElevenLabs credentials on this deployment - say so plainly and
  // hand the boss to chat mode, which asks the same seven topics in text.
  if (start && !start.configured) {
    return (
      <section className="rounded-xl border border-[var(--color-warn-line)] bg-[var(--color-card)] p-4 sm:p-5">
        <h2 className="mb-2 text-[15px] font-semibold">Day-1 one-to-one · voice unavailable</h2>
        <p className="mb-4 text-sm text-[var(--color-fg-2)]">
          {start.reason ??
            'Voice mode needs ElevenLabs credentials. Chat mode runs the same Day-1 1:1 without them.'}
        </p>
        {onSwitchMode ? (
          <Button variant="primary" onClick={onSwitchMode}>
            Continue in chat
          </Button>
        ) : null}
      </section>
    );
  }

  /** Draft again from what was said: this call's transcript, else the session's own copy. */
  function draftAgain(): void {
    const text = transcript.length > 0 ? transcriptText(transcript) : stored?.pendingTranscript;
    if (text) postTranscript(text);
  }

  /** Start over after a draft failed for good: a new call on the same session. */
  function holdAgain(): void {
    finalisePosted.current = false;
    setTranscript([]);
    setPost({ kind: 'idle' });
    setError(null);
    setHeldAgain(true);
  }

  // The call ended and was posted, or the room came back to a one-to-one already drafting.
  const over = post.kind !== 'idle' || (serverPhase.kind !== 'talking' && !heldAgain);
  const storedTurns =
    transcript.length === 0 && stored?.pendingTranscript
      ? transcriptTurns(stored.pendingTranscript)
      : [];
  const lines: readonly InboundMessage[] =
    storedTurns.length > 0
      ? storedTurns.map((turn) => ({
          source: turn.speaker === 'employee' ? 'ai' : 'user',
          message: turn.text,
        }))
      : transcript;

  return (
    <section
      aria-labelledby={`${agentId}-voice-title`}
      className={`flex flex-col rounded-xl border border-[var(--color-accent-line)] bg-[var(--color-card)] ${ROOM_HEIGHT}`}
    >
      <header className="flex flex-wrap items-center justify-between gap-x-3 border-b border-[var(--color-border)] px-4 py-2 sm:px-5">
        <h2 id={`${agentId}-voice-title`} className="py-2.5 text-[15px] font-semibold">
          Day-1 1:1 · voice mode
        </h2>
        {over ? (
          <span className="text-[13px] text-[var(--color-muted)]">complete</span>
        ) : onSwitchMode && !isConnected ? (
          <Button variant="text" size="small" onClick={onSwitchMode}>
            Switch to chat
          </Button>
        ) : (
          <span className="text-[13px] text-[var(--color-muted)]">ElevenLabs</span>
        )}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 py-3 sm:px-5">
        {over ? (
          <TopicProgress progress={{ kind: 'answered', count: answeredCount(turnsOf(lines)) }} />
        ) : (
          <>
            <div role="alert">
              {error ? (
                <p className="break-words text-sm text-[var(--color-warn)]">
                  {error}. Switch to chat mode if voice setup is unavailable.
                </p>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              {!isConnected ? (
                <Button variant="primary" onClick={onStart} disabled={!start}>
                  Start voice 1:1
                </Button>
              ) : (
                <>
                  <SpeakToggle muted={muted} onToggle={() => setMuted((m) => !m)} />
                  <Button onClick={onStop}>End call</Button>
                </>
              )}
              <StatusPill
                status={status}
                isSpeaking={isSpeaking}
                isListening={isListening}
                muted={muted}
              />
            </div>
          </>
        )}

        <div
          ref={transcriptRef}
          tabIndex={0}
          role="log"
          aria-label="The 1:1 so far"
          className="min-h-0 flex-1 space-y-1.5 overflow-y-auto rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 text-sm"
        >
          {lines.length === 0 ? (
            <p className="text-[var(--color-muted)]">
              The live transcript appears here once the call starts.
            </p>
          ) : (
            lines.map((t, i) => (
              <div key={i}>
                <span
                  className={
                    t.source === 'ai' ? 'text-[var(--color-accent)]' : 'text-[var(--color-fg-2)]'
                  }
                >
                  {t.source === 'ai' ? 'employee' : 'you'}:
                </span>{' '}
                <span className="text-[var(--color-fg)]">{t.message}</span>
              </div>
            ))
          )}
        </div>
        {over ? (
          <DraftingNotice
            name={name}
            phase={serverPhase}
            post={post}
            onDraftAgain={draftAgain}
            onHoldAgain={holdAgain}
          />
        ) : null}
      </div>
    </section>
  );
}

/** A call's lines as the synthesis reads them: one labelled turn per paragraph. */
function transcriptText(lines: readonly InboundMessage[]): string {
  return lines.map((t) => `${t.source === 'ai' ? 'AGENT' : 'USER'}: ${t.message}`).join('\n\n');
}

/** A call's lines as turns, for counting the answers in them. */
function turnsOf(lines: readonly InboundMessage[]): TranscriptTurn[] {
  return lines.map((t) => ({
    speaker: t.source === 'ai' ? 'employee' : 'manager',
    text: t.message,
  }));
}

function SpeakToggle({ muted, onToggle }: { muted: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      title={muted ? 'tap to start speaking' : 'tap to stop speaking'}
      className={`min-h-11 px-5 py-2.5 rounded-lg font-medium text-sm transition flex items-center gap-2 ${
        muted
          ? 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
          : 'bg-[var(--color-ok)]/20 text-[var(--color-ok)] border border-[var(--color-ok)]/40'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          muted ? 'bg-[var(--color-bg)]/80' : 'bg-[var(--color-ok)] animate-pulse'
        }`}
      />
      {muted ? 'Tap to speak' : 'Tap to stop'}
    </button>
  );
}

function StatusPill({
  status,
  isSpeaking,
  isListening,
  muted,
}: {
  status: string;
  isSpeaking: boolean;
  isListening: boolean;
  muted: boolean;
}) {
  let label = `status: ${status}`;
  let tone = 'text-[var(--color-muted)]';
  if (status === 'connected') {
    if (muted) {
      label = 'mic muted';
      tone = 'text-[var(--color-fg-2)]';
    } else if (isSpeaking) {
      label = 'employee speaking…';
      tone = 'text-[var(--color-accent)]';
    } else if (isListening) {
      label = 'listening';
      tone = 'text-[var(--color-ok)]';
    } else {
      label = 'live';
      tone = 'text-[var(--color-ok)]';
    }
  }
  return (
    <span className={`text-[13px] ${tone} flex items-center gap-2`}>
      <span
        className={`w-2 h-2 rounded-full ${
          status === 'connected'
            ? muted
              ? 'bg-[var(--color-fg-2)]'
              : isSpeaking
                ? 'bg-[var(--color-accent)] animate-pulse'
                : 'bg-[var(--color-ok)] animate-pulse'
            : 'bg-[var(--color-muted)]'
        }`}
      />
      {label}
    </span>
  );
}
