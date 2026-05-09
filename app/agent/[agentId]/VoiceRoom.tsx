'use client';

import { useEffect, useRef, useState } from 'react';
import { useConversation, ConversationProvider } from '@elevenlabs/react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

interface StartResponse {
  agentId: string;
  signedUrl: string | null;
  public: boolean;
  warning?: string;
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
 *   - onError receives `(message: string, context?: any)` — first arg
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
  const startSession = useMutation(api.voice.start);
  const attachConversationId = useMutation(api.voice.attachConversationId);
  const [voiceSessionId, setVoiceSessionId] = useState<Id<'voiceSessions'> | null>(null);
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
      if (voiceSessionId && conversationId) {
        attachConversationId({
          sessionId: voiceSessionId,
          elevenLabsConversationId: conversationId,
        }).catch(() => {
          // Non-fatal — webhook can fall back to latest-active lookup.
        });
      }
    },
    onDisconnect: () => {
      setTranscript((current) => {
        const text = current
          .map((t) => `${t.source === 'ai' ? 'AGENT' : 'USER'}: ${t.message}`)
          .join('\n\n');
        if (text) {
          void fetch('/api/onboarding/synthesise', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              agentId,
              bossLabel,
              transcript: text,
              voiceSessionId,
            }),
          });
        }
        return current;
      });
    },
    onMessage: (m: InboundMessage) => {
      setTranscript((prev) => [...prev, m]);
    },
    onError: (message: string) => setError(message || 'voice error'),
  });

  // Auto-scroll transcript to newest utterance.
  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [transcript]);

  useEffect(() => {
    if (!start) {
      fetch('/api/voice/elevenlabs/start')
        .then((r) => r.json())
        .then((data: StartResponse | { error: string }) => {
          if ('error' in data) {
            setError(data.error);
          } else {
            setStart(data);
            if (data.warning) {
              setError(
                `${data.warning}. Falling back to public agent mode — voice will work if the agent is configured for public access.`,
              );
            }
          }
        })
        .catch((err: Error) => setError(err.message));
    }
  }, [start]);

  async function onStart() {
    if (!start) return;
    if (!voiceSessionId) {
      const id = await startSession({ agentId, mode: 'elevenlabs' });
      setVoiceSessionId(id);
    }
    conversation.startSession({
      ...(start.signedUrl ? { signedUrl: start.signedUrl } : { agentId: start.agentId }),
      dynamicVariables: {
        boss_label: bossLabel,
        internal_agent_id: agentId,
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

  return (
    <section className="bg-[var(--color-card)] border border-[var(--color-accent)]/40 rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold">Day-1 1:1 · voice mode</h2>
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-[var(--color-muted)]">
            ElevenLabs Conversational AI
          </span>
          {onSwitchMode && !isConnected ? (
            <button
              onClick={onSwitchMode}
              className="text-[10px] text-[var(--color-muted)] hover:text-[var(--color-accent)] underline underline-offset-2"
            >
              switch to chat
            </button>
          ) : null}
        </div>
      </div>

      {error ? (
        <p className="text-xs text-[var(--color-danger)] mb-3 break-words">
          {error}. Switch to chat mode if voice setup is unavailable.
        </p>
      ) : null}

      <div className="flex items-center gap-3 mb-3 flex-wrap">
        {!isConnected ? (
          <button
            onClick={onStart}
            disabled={!start}
            className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50 text-sm"
          >
            Start voice 1:1
          </button>
        ) : (
          <>
            <SpeakToggle muted={muted} onToggle={() => setMuted((m) => !m)} />
            <button
              onClick={onStop}
              className="px-4 py-2 rounded-lg border border-[var(--color-border)] text-sm"
            >
              End call
            </button>
          </>
        )}
        <StatusPill status={status} isSpeaking={isSpeaking} isListening={isListening} muted={muted} />
      </div>

      <div
        ref={transcriptRef}
        className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 max-h-64 overflow-y-auto text-xs space-y-1"
      >
        {transcript.length === 0 ? (
          <p className="text-[var(--color-muted)]">live transcript will appear here…</p>
        ) : (
          transcript.map((t, i) => (
            <div key={i}>
              <span className={t.source === 'ai' ? 'text-[var(--color-accent)]' : 'text-[var(--color-fg)]'}>
                {t.source === 'ai' ? 'agent' : 'you'}:
              </span>{' '}
              <span className="text-[var(--color-fg)]">{t.message}</span>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SpeakToggle({
  muted,
  onToggle,
}: {
  muted: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      title={muted ? 'tap to start speaking' : 'tap to stop speaking'}
      className={`px-5 py-2.5 rounded-lg font-medium text-sm transition flex items-center gap-2 ${
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
      tone = 'text-[var(--color-danger)]';
    } else if (isSpeaking) {
      label = 'agent speaking…';
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
    <span className={`text-xs ${tone} flex items-center gap-2`}>
      <span
        className={`w-2 h-2 rounded-full ${
          status === 'connected'
            ? muted
              ? 'bg-[var(--color-danger)]'
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
