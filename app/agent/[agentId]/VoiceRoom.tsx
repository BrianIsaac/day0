'use client';

import { useEffect, useState } from 'react';
import { useConversation, ConversationProvider } from '@elevenlabs/react';
import { useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';

interface StartResponse {
  agentId: string;
  signedUrl: string | null;
  public: boolean;
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
 *   - Custom data flows via dynamicVariables (Record).
 *   - micMuted is a controlled prop on useConversation; isSpeaking /
 *     isListening expose the agent's turn state.
 */
export function VoiceRoom(props: { agentId: Id<'agents'>; bossLabel: string }) {
  return (
    <ConversationProvider>
      <VoiceRoomInner {...props} />
    </ConversationProvider>
  );
}

function VoiceRoomInner({ agentId, bossLabel }: { agentId: Id<'agents'>; bossLabel: string }) {
  const startSession = useMutation(api.voice.start);
  const [voiceSessionId, setVoiceSessionId] = useState<Id<'voiceSessions'> | null>(null);
  const [start, setStart] = useState<StartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<InboundMessage[]>([]);
  const [muted, setMuted] = useState(false);

  const conversation = useConversation({
    micMuted: muted,
    onConnect: () => setError(null),
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
    onError: (err: { message?: string }) => setError(err.message ?? 'voice error'),
  });

  useEffect(() => {
    if (!start) {
      fetch('/api/voice/elevenlabs/start')
        .then((r) => r.json())
        .then((data: StartResponse | { error: string }) => {
          if ('error' in data) setError(data.error);
          else setStart(data);
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
        <span className="text-[10px] text-[var(--color-muted)]">ElevenLabs Conversational AI</span>
      </div>

      {error ? (
        <p className="text-xs text-[var(--color-danger)] mb-3">
          {error}. Switch to chat mode if voice setup is unavailable.
        </p>
      ) : null}

      <div className="flex items-center gap-3 mb-3">
        <button
          onClick={onStart}
          disabled={isConnected || !start}
          className="px-4 py-2 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50 text-sm"
        >
          {isConnected ? 'Connected' : 'Start voice 1:1'}
        </button>
        <MicToggle
          muted={muted}
          disabled={!isConnected}
          onToggle={() => setMuted((m) => !m)}
        />
        <button
          onClick={onStop}
          disabled={!isConnected}
          className="px-4 py-2 rounded-lg border border-[var(--color-border)] disabled:opacity-50 text-sm"
        >
          End call
        </button>
        <StatusPill status={status} isSpeaking={isSpeaking} isListening={isListening} muted={muted} />
      </div>

      <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 max-h-64 overflow-y-auto text-xs space-y-1">
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

function MicToggle({
  muted,
  disabled,
  onToggle,
}: {
  muted: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={muted ? 'mic muted — click to unmute' : 'mic live — click to mute'}
      className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-medium transition disabled:opacity-50 ${
        muted
          ? 'bg-[var(--color-danger)]/20 text-[var(--color-danger)] border border-[var(--color-danger)]/40'
          : 'bg-[var(--color-ok)]/20 text-[var(--color-ok)] border border-[var(--color-ok)]/40'
      }`}
    >
      {muted ? '🔇' : '🎙'}
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
