'use client';

import { QUALITY_FIT_SKIP_PREFIX } from '@/work/types';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { ChatRoom } from './ChatRoom';
import { VoiceRoom } from './VoiceRoom';
import { MockEnvironment } from './MockEnvironment';
import { holdsLiveAuthoringClaim } from '../../../src/lib/skill-authoring';
import {
  type ActionVerdict,
  normaliseActionVerdict,
  reviewPayload,
  skillApprovalRefusal,
} from '../../../src/surfaces/policy';
import {
  AUTONOMY_WARNING,
  autonomousActionsOn,
  autonomyLabel,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
} from '../../../src/work/autonomy';
import { toSurfaceRecord } from '../../../src/surfaces/records';
import { summariseAction, type ReplyTarget } from '../../../src/surfaces/summary';
import type { ActionAuthority, SurfaceRecord } from '../../../src/surfaces/types';
import { verdictFor } from '../../../src/surfaces/verdict';
import { replyTargetFor } from '../../../src/work/reply-target';
import {
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
  type ReconciliationEntry,
} from '../../../src/work/reconciliation';
import type { MockAction } from '../../../src/work/types';
import { clockTimeWithSeconds, relativeTime, useNow } from './time';
import type { AgentMetrics } from '../../../convex/metrics';

interface Props {
  agentId: Id<'agents'>;
}

/**
 * The last authoring attempt this browser made and the verdict it came back
 * with. Kept as the skill it names rather than as a finished sentence, so
 * whether the verdict is still true can be asked of the skill row.
 */
interface AuthoringAttempt {
  skillId: Id<'skills'>;
  name: string;
  reason: string;
}

export function AgentDashboard({ agentId }: Props) {
  const agent = useQuery(api.agents.get, { agentId });
  const charter = useQuery(api.charters.latest, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const proposedSkills = useQuery(api.skills.proposed, { agentId });
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  const unverifiedSkills = useQuery(api.skills.awaitingVerification, { agentId });
  const failedSkills = useQuery(api.skills.verificationFailed, { agentId });
  const events = useQuery(api.events.recent, { agentId, limit: 30 });
  const metrics = useQuery(api.metrics.forAgent, { agentId });
  const voiceSession = useQuery(api.voice.latest, { agentId });
  // Real mode only: the mock has no surfaces table rows, and the hosted app
  // never asks for connection verdicts.
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const surfaceRows = useQuery(
    api.surfaces.listForAgent,
    surfaceConfig?.mode === 'real' ? { agentId } : 'skip',
  );
  const surfaces = useMemo(
    (): SurfaceRecord[] => (surfaceRows ?? []).map((row) => toSurfaceRecord(row)),
    [surfaceRows],
  );

  const [mode, setMode] = useState<'pick' | 'chat' | 'voice'>('pick');
  const [lastAttempt, setLastAttempt] = useState<AuthoringAttempt | null>(null);
  // Ticks, so an authoring claim stops being described as live the moment it
  // stops being honoured rather than on the next thing the boss happens to do.
  const now = useNow();

  // This notice used to be a string set once and never cleared, so the first
  // failure outlived everything that came after it: a retry that registered the
  // skill, a second failure that said something else, the boss's own rejection.
  // It is asked of the skill row instead. `skills.get` rather than the panel
  // queries above, because the two states that settle it appear in none of
  // them: `approved`, where a run failed before it could write anything, and
  // `rejected`.
  const attemptedSkill = useQuery(
    api.skills.get,
    lastAttempt ? { skillId: lastAttempt.skillId } : 'skip',
  );
  // A run holding the skill now, a registration and a rejection are all facts
  // newer than the verdict, and each of them makes it a lie. A claim whose run
  // died is none of them: it is left on the row by a run that never came back,
  // so it is exactly the case the verdict is describing and must not hide it.
  const authoringFailure =
    lastAttempt &&
    attemptedSkill &&
    !holdsLiveAuthoringClaim(attemptedSkill, now) &&
    attemptedSkill.state !== 'registered' &&
    attemptedSkill.state !== 'rejected'
      ? `${lastAttempt.name}: ${lastAttempt.reason}`
      : null;

  // Sync local mode with server state. Two cases:
  //   1. Reload mid-session — route back into the room they were in
  //      (uses the voiceSession row to figure out which).
  //   2. Request Changes on the charter — agent.state flips back to
  //      `deployed` AND a prior voiceSession exists. Reset to picker.
  // The `voiceSession` guard is critical: without it, the moment a fresh
  // user picks a mode (state is still `deployed`, mode flips off `pick`)
  // this effect would race the user's click and snap them back to picker.
  //
  // This resync stays an effect on purpose. Deriving `mode` cannot express
  // case 2 — the boss's own pick has to be discarded when the server moves
  // underneath it — and resetting via a subtree `key` would remount
  // `ChatRoom`, whose mount effect opens a voice session, so every state
  // transition would start a duplicate 1:1.
  useEffect(() => {
    if (!agent) return;
    if (agent.state === 'deployed' && mode !== 'pick' && voiceSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode('pick');
      return;
    }
    if (
      agent.state === 'day-one-in-progress' &&
      mode === 'pick' &&
      voiceSession
    ) {
      setMode(voiceSession.mode === 'chat' ? 'chat' : 'voice');
    }
  }, [agent, voiceSession, mode]);

  if (!agent) {
    return (
      <main className="min-h-screen flex items-center justify-center text-[var(--color-muted)]">
        loading agent…
      </main>
    );
  }

  // A drafted charter ends the 1:1, whatever the agent row still says. The
  // room stayed open under the charter it had just produced — badge reading
  // "streaming", footer reading "drafting your charter…" — because both were
  // keyed to a state the chat route never moved on.
  const showOnboarding =
    !charter && (agent.state === 'deployed' || agent.state === 'day-one-in-progress');

  return (
    <main className="min-h-screen px-6 py-8 max-w-7xl mx-auto">
      <Header agent={agent} charter={charter ?? null} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 space-y-4">
          {showOnboarding ? (
            mode === 'pick' ? (
              <ModePicker onPick={(m) => setMode(m)} />
            ) : mode === 'voice' ? (
              <VoiceRoom
                agentId={agentId}
                bossLabel={agent.bossEmail}
                onSwitchMode={() => setMode('chat')}
              />
            ) : (
              <ChatRoom
                agentId={agentId}
                bossLabel={agent.bossEmail}
                onSwitchMode={() => setMode('voice')}
              />
            )
          ) : null}

          {charter ? <CharterCard charter={charter} /> : null}

          <ProposedSkillsPanel
            agentId={agentId}
            skills={proposedSkills ?? []}
            surfaces={surfaces}
            onAuthoringAttempt={setLastAttempt}
          />

          <WorkQueue
            workItems={workItems ?? []}
            surfaces={surfaces}
            registeredSkillCount={(registeredSkills ?? []).length}
            charterApproved={!!charter?.approved}
            autonomousActions={agent ? autonomousActionsOn(agent) : false}
          />
        </div>

        <div className="space-y-4">
          <WorkspacePanel workspace={workspace ?? {}} />
          <RegisteredSkillsPanel
            skills={registeredSkills ?? []}
            unregistered={[...(unverifiedSkills ?? []), ...(failedSkills ?? [])]}
            authoringFailure={authoringFailure}
            onAuthoringAttempt={setLastAttempt}
          />
          {surfaceConfig?.mode === 'real' ? <PermissionsCard agentId={agentId} /> : null}
          <MetricsCard metrics={metrics} />
          <EventTicker events={events ?? []} />
        </div>
      </div>

      {/* Full width, and not half of two thirds of the page. Five work
          surfaces, a channel list and a conversation do not fit in 400px, and
          this panel is the whole of what the agent's work is done against. */}
      <MockEnvironment agentId={agentId} />
    </main>
  );
}

/** What each state of the switch does, for its title. */
const AUTONOMY_TITLES: Record<'off' | 'on', string> = {
  off: 'Supervised: reads and the DM to you apply on their own; every other action waits for your approval of the exact payload.',
  on: 'Autonomous: the agent acts on connected systems without asking, within the connections and skills you have approved.',
};

/** Whether a key press should take the safe path out of the confirmation. */
export function cancelsAutonomyConfirm(key: string, busy: boolean): boolean {
  return key === 'Escape' && !busy;
}

/**
 * The confirmation shown before autonomous actions are turned on.
 *
 * Args:
 *   onConfirm: Turn the switch on.
 *   onCancel: Leave it off.
 *   busy: Whether the change is in flight.
 *
 * Returns:
 *   The warning in the operator's words with its two buttons.
 */
export function AutonomyConfirm({
  onConfirm,
  onCancel,
  busy = false,
}: {
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
}) {
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Turn on autonomous actions"
      onKeyDown={(event) => {
        if (!cancelsAutonomyConfirm(event.key, busy)) return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
      className="absolute right-0 top-full mt-2 w-80 p-3 rounded-lg border border-[var(--color-warn)]/40 bg-[var(--color-card)] shadow-lg text-left text-xs text-[var(--color-fg)] z-10"
    >
      <p className="font-medium text-[var(--color-warn)] mb-1">Turn on autonomous actions?</p>
      <p className="mb-3 leading-relaxed">{AUTONOMY_WARNING}</p>
      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={onConfirm}
          className="px-3 py-1 rounded-md bg-[var(--color-warn)] text-[var(--color-bg)] font-medium disabled:opacity-60"
        >
          Turn on
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className="px-3 py-1 rounded-md border border-[var(--color-border)] disabled:opacity-60"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * The header chip as the manager's autonomous-actions switch, real mode only.
 *
 * Turning it on opens the confirmation; turning it off needs none. The chip
 * names the state plainly ("Supervised" / "Autonomous") beside the switch.
 *
 * Args:
 *   on: Whether autonomous actions are on.
 *   tone: The chip's colour classes.
 *   onChange: Persist the manager's choice.
 *
 * Returns:
 *   The labelled switch styled as the chip.
 */
export function AutonomyControl({
  on,
  tone,
  onChange,
}: {
  on: boolean;
  tone: string;
  onChange: (on: boolean) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function persist(next: boolean): void {
    setBusy(true);
    setError(null);
    onChange(next)
      .then(() => setConfirming(false))
      .catch((err: unknown) => setError((err as Error).message))
      .finally(() => setBusy(false));
  }

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2 px-3 py-1 rounded-full text-xs font-medium ${tone}`}
        title={AUTONOMY_TITLES[on ? 'on' : 'off']}
      >
        <span>Active · {autonomyLabel(on)}</span>
        <span className="text-[10px] font-normal opacity-80">Autonomous actions</span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Autonomous actions"
          disabled={busy}
          onClick={() => {
            if (on) persist(false);
            else setConfirming(true);
          }}
          className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors disabled:cursor-wait ${
            on ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-muted)]/40'
          }`}
        >
          <span
            className={`inline-block h-3 w-3 rounded-full bg-[var(--color-bg)] transition-transform ${
              on ? 'translate-x-3.5' : 'translate-x-0.5'
            }`}
          />
        </button>
        {error ? <span className="text-[10px] text-[var(--color-danger)]">{error}</span> : null}
      </div>
      {confirming && !on ? (
        <AutonomyConfirm busy={busy} onConfirm={() => persist(true)} onCancel={() => setConfirming(false)} />
      ) : null}
    </div>
  );
}

function Header({
  agent,
  charter,
}: {
  agent: Doc<'agents'>;
  /** What the page is showing, which outranks the row when the two disagree. */
  charter: Doc<'charters'> | null;
}) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const stateLabel: Record<Doc<'agents'>['state'], { text: string; tone: string }> = {
    deployed: { text: 'Deployed · awaiting Day-1 1:1', tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]' },
    'day-one-in-progress': {
      text: 'Day-1 1:1 in progress',
      tone: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
    },
    'charter-pending': {
      text: 'Charter drafted · awaiting boss approval',
      tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
    },
    active: { text: 'Active · cold-start posture', tone: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]' },
  };
  // A charter on the page is the more recent fact: a pill reading "Day-1 1:1
  // in progress" above a drafted charter is wrong however the row got there.
  const displayState: Doc<'agents'>['state'] = charter
    ? charter.approved
      ? 'active'
      : 'charter-pending'
    : agent.state;
  const s = stateLabel[displayState];
  return (
    <header className="mb-6">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)] mb-1">
            Day0
          </p>
          <h1 className="text-2xl font-semibold tracking-tight">
            Agent reporting to <span className="font-mono text-[var(--color-accent)]">{agent.bossEmail}</span>
          </h1>
        </div>
        <div className="flex items-center gap-2">
          <span className="px-2 py-1 rounded-full border border-[var(--color-border)] text-[10px]">
            {surfaceConfig?.label || 'loading'}
          </span>
          {/* In real mode the chip is the manager's autonomous-actions
              switch; the hosted mock has no gate for the switch to change, so
              it keeps the static label. */}
          {displayState === 'active' && surfaceConfig?.mode === 'real' ? (
            <AutonomyControl
              on={autonomousActionsOn(agent)}
              tone={s.tone}
              onChange={(on) => setAutonomousActions({ agentId: agent._id, on })}
            />
          ) : (
            <span className={`px-3 py-1 rounded-full text-xs font-medium ${s.tone}`}>{s.text}</span>
          )}
        </div>
      </div>
    </header>
  );
}

function Card({
  title,
  children,
  tone,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'ok';
}) {
  const border = {
    default: 'border-[var(--color-border)]',
    accent: 'border-[var(--color-accent)]/40',
    warn: 'border-[var(--color-warn)]/40',
    ok: 'border-[var(--color-ok)]/40',
  }[tone ?? 'default'];
  return (
    <section
      className={`bg-[var(--color-card)] border ${border} rounded-xl p-4`}
    >
      <h2 className="text-sm font-semibold tracking-tight text-[var(--color-fg)] mb-3">{title}</h2>
      {children}
    </section>
  );
}

function ModePicker({ onPick }: { onPick: (mode: 'voice' | 'chat') => void }) {
  // null while the probe is in flight — voice stays clickable so the
  // picker doesn't flicker on a configured deployment.
  const [voiceConfigured, setVoiceConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/voice/elevenlabs/start?probe=1')
      .then((r) => r.json())
      .then((d: { configured?: boolean }) => {
        if (!cancelled) setVoiceConfigured(d.configured !== false);
      })
      .catch(() => {
        if (!cancelled) setVoiceConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const voiceOff = voiceConfigured === false;
  return (
    <Card title="Day-1 1:1 — voice or chat?" tone="accent">
      <p className="text-sm text-[var(--color-muted)] mb-4">
        I&apos;d like a few minutes to understand the role you brought me on for. Voice is faster
        (~5 min); chat is fine if you&apos;d rather type.
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => onPick('voice')}
          disabled={voiceOff}
          title={voiceOff ? 'ElevenLabs credentials not set on this deployment' : undefined}
          className={`flex-1 px-4 py-3 rounded-lg font-medium ${
            voiceOff
              ? 'border border-[var(--color-border)] text-[var(--color-muted)] cursor-not-allowed'
              : 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
          }`}
        >
          Voice (ElevenLabs)
        </button>
        <button
          onClick={() => onPick('chat')}
          className={`flex-1 px-4 py-3 rounded-lg font-medium ${
            voiceOff
              ? 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
              : 'border border-[var(--color-border)] hover:border-[var(--color-accent)]'
          }`}
        >
          Chat
        </button>
      </div>
      {voiceOff ? (
        <p className="text-xs text-[var(--color-muted)] mt-3">
          Voice is off on this deployment — no ElevenLabs credentials. Chat runs the identical
          seven-topic 1:1.
        </p>
      ) : null}
    </Card>
  );
}

function CharterCard({ charter }: { charter: Doc<'charters'> }) {
  const approve = useMutation(api.charters.approve);
  const requestChanges = useMutation(api.charters.requestChanges);
  const postApproval = useAction(api.onboarding.postCharterApproval);
  const [posting, setPosting] = useState(false);
  const body = charter.body as {
    whyThisHire: string;
    proposedFunction: string;
    shortTermGoals: { day30: string; day60: string; day90: string };
    proposedBoundaries: { willDo: string[]; willNotDo: string[]; escalationTriggers: string[] };
    namedCollaborators: Array<{ name: string; topic: string }>;
    namedSystems?: Array<{ name: string; class: string; whereMentioned: string }>;
    priorityReading: string[];
    openQuestions: string[];
  };

  async function onApprove() {
    setPosting(true);
    await approve({ charterId: charter._id });
    // Kick off good-habits research right after approval — the AGENTS.md
    // section then lights up the workspace panel live.
    postApproval({ agentId: charter.agentId, charterId: charter._id }).catch(() => {});
  }

  return (
    <Card title={`Charter v${charter.version}${charter.approved ? ' · approved' : ' · awaiting approval'}`} tone={charter.approved ? 'ok' : 'warn'}>
      <div className="space-y-3 text-sm">
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">Why this hire</span>
          <p className="text-[var(--color-fg)]">{body.whyThisHire}</p>
        </div>
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">Proposed function</span>
          <p className="text-[var(--color-fg)]">{body.proposedFunction}</p>
        </div>
        <div className="grid grid-cols-3 gap-3 text-xs">
          <Goal label="30-day" text={body.shortTermGoals.day30} />
          <Goal label="60-day" text={body.shortTermGoals.day60} />
          <Goal label="90-day" text={body.shortTermGoals.day90} />
        </div>
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
            Boundaries · collaborators · open questions
          </summary>
          <div className="mt-2 space-y-2 pl-3 border-l border-[var(--color-border)]">
            <BoundaryList label="Will do" items={body.proposedBoundaries.willDo} />
            <BoundaryList label="Will NOT do" items={body.proposedBoundaries.willNotDo} />
            <BoundaryList label="Escalation triggers" items={body.proposedBoundaries.escalationTriggers} />
            <BoundaryList
              label="Systems named in the 1:1"
              items={(body.namedSystems ?? []).map(
                (system) => `${system.name} (${system.class}) - ${system.whereMentioned}`,
              )}
            />
            <BoundaryList
              label="Collaborators"
              items={body.namedCollaborators.map((c) => `${c.name} — ${c.topic}`)}
            />
            <BoundaryList label="Priority reading" items={body.priorityReading} />
            <BoundaryList label="Open questions" items={body.openQuestions} />
          </div>
        </details>
        {!charter.approved ? (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onApprove}
              disabled={posting}
              className="px-4 py-2 rounded-lg bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-sm font-medium disabled:opacity-50"
            >
              Approve
            </button>
            <button
              onClick={() => requestChanges({ charterId: charter._id })}
              className="px-4 py-2 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-warn)] text-sm"
            >
              Request changes
            </button>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

function Goal({ label, text }: { label: string; text: string }) {
  return (
    <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-2">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <div className="text-[var(--color-fg)] leading-snug">{text}</div>
    </div>
  );
}

function BoundaryList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">{label}</div>
      <ul className="space-y-0.5">
        {items.map((it, i) => (
          <li key={i} className="text-[var(--color-fg)]">
            – {it}
          </li>
        ))}
      </ul>
    </div>
  );
}

function ProposedSkillsPanel({
  agentId,
  skills,
  surfaces,
  onAuthoringAttempt,
}: {
  agentId: Id<'agents'>;
  skills: Doc<'skills'>[];
  /** The agent's surfaces in real mode; a skill targeting one that is not
   *  connected cannot be approved yet, and the button says why. */
  surfaces: SurfaceRecord[];
  /** Approving moves the row out of this panel, so its verdict has to be
   *  reported somewhere that survives the unmount. `null` opens an attempt and
   *  retires whatever the last one said. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
}) {
  const approve = useMutation(api.skills.approve);
  const reject = useMutation(api.skills.reject);
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const now = useNow();
  if (skills.length === 0) return null;
  return (
    <Card title="Proposed skills · awaiting your call" tone="warn">
      <div className="space-y-3">
        {skills.map((s) => {
          const refusal = skillApprovalRefusal(
            s.targetSurface,
            surfaces.find((surface) => surface.slug === s.targetSurface),
            now,
          );
          return (
          <div
            key={s._id}
            className="border border-[var(--color-border)] rounded-lg p-3 text-sm"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-[var(--color-fg)]">{s.name}</span>
              <span className="text-[10px] text-[var(--color-muted)]">requires: {(s.requiredScopes ?? []).join(', ')}</span>
            </div>
            <p className="text-[var(--color-muted)] text-xs mb-2">{s.rationale ?? s.description}</p>
            {refusal ? (
              <p className="text-[10px] text-[var(--color-warn)] mb-2">
                Cannot approve yet: {refusal}{' '}
                <a href="#surfaces" className="underline">
                  Surfaces tab
                </a>
              </p>
            ) : null}
            <div className="flex gap-2">
              <button
                disabled={Boolean(refusal)}
                title={refusal}
                onClick={async () => {
                  await approve({ skillId: s._id });
                  void agentId;
                  onAuthoringAttempt(null);
                  try {
                    const result = await author({ skillId: s._id });
                    if (!result.ok) {
                      onAuthoringAttempt({
                        skillId: s._id,
                        name: s.name,
                        reason: result.reason ?? 'authoring did not finish',
                      });
                    }
                  } catch (err) {
                    onAuthoringAttempt({
                      skillId: s._id,
                      name: s.name,
                      reason: (err as Error).message,
                    });
                  }
                }}
                className="px-3 py-1.5 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--color-ok)]/20"
              >
                Approve · author and verify
              </button>
              <button
                onClick={() => reject({ skillId: s._id })}
                className="px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
              >
                Reject
              </button>
            </div>
          </div>
          );
        })}
      </div>
    </Card>
  );
}

function RegisteredSkillsPanel({
  skills,
  unregistered,
  authoringFailure,
  onAuthoringAttempt,
}: {
  skills: Doc<'skills'>[];
  /**
   * Authored but never registered: `authoring` (a run is holding it now, or no
   * sandbox ran), `failed` (the sandbox said no), and `verified` (registration
   * was interrupted before the lifecycle was collapsed into one mutation).
   * A skill a run holds is listed here throughout, so a run that dies mid-flight
   * leaves something the boss can see and, once its claim lapses, retry.
   */
  unregistered: Doc<'skills'>[];
  /**
   * The most recent authoring attempt's verdict, already checked against the
   * skill it names. Null once that skill has moved past it, which is what keeps
   * it from sitting above a row that says something else.
   */
  authoringFailure: string | null;
  /** Retries report here too, so the notice is never older than the last try. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
}) {
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const requestRevision = useMutation(api.skills.requestRevision);
  const [retrying, setRetrying] = useState<Id<'skills'> | null>(null);
  const now = useNow();

  async function onRetry(skillId: Id<'skills'>, name: string) {
    setRetrying(skillId);
    onAuthoringAttempt(null);
    try {
      const result = await author({ skillId });
      if (!result.ok) {
        onAuthoringAttempt({ skillId, name, reason: result.reason ?? 'retry did not succeed' });
      }
    } catch (err) {
      onAuthoringAttempt({ skillId, name, reason: (err as Error).message });
    } finally {
      setRetrying(null);
    }
  }

  async function onRevise(skillId: Id<'skills'>, name: string) {
    setRetrying(skillId);
    onAuthoringAttempt(null);
    try {
      await requestRevision({ skillId });
      const result = await author({ skillId });
      if (!result.ok) {
        onAuthoringAttempt({
          skillId,
          name,
          reason: result.reason ?? 'revision did not succeed',
        });
      }
    } catch (err) {
      onAuthoringAttempt({ skillId, name, reason: (err as Error).message });
    } finally {
      setRetrying(null);
    }
  }

  return (
    <Card title={`Skills · ${skills.length} registered`}>
      {authoringFailure ? (
        <p className="mb-3 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-xs text-[var(--color-danger)]">
          Authoring did not finish — {authoringFailure}
        </p>
      ) : null}
      {skills.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">none yet</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {skills.map((s) => (
            <li key={s._id} className="flex items-start gap-2">
              <span
                className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${
                  s.sourceType === 'builtin'
                    ? 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]'
                    : 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]'
                }`}
              >
                {s.sourceType === 'builtin' ? 'builtin' : 'authored'}
              </span>
              <div className="flex-1">
                <div className="font-medium text-[var(--color-fg)]">{s.name}</div>
                <div className="text-[var(--color-muted)] text-xs">{s.description}</div>
              </div>
              {s.sourceType === 'agent-authored' ? (
                <button
                  onClick={() => onRevise(s._id, s.name)}
                  disabled={retrying === s._id}
                  title="Re-author and verify this skill before its first execution"
                  className="px-2.5 py-1 rounded-md border border-[var(--color-border)] hover:border-[var(--color-warn)] text-xs disabled:opacity-50 shrink-0"
                >
                  {retrying === s._id ? 'Revising…' : 'Revise'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {unregistered.length > 0 ? (
        <div className="mt-3 pt-3 border-t border-[var(--color-border)]">
          {/* One honest label for every way a skill can stop short: a skipped
              sandbox, a sandbox that said no, and a registration that was
              interrupted. */}
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-warn)] mb-1.5">
            not registered · not callable
          </p>
          <ul className="space-y-3 text-sm">
            {unregistered.map((s) => (
              <li key={s._id}>
                <div className="flex items-start justify-between gap-2">
                  <div className="flex-1">
                    <div className="font-medium text-[var(--color-fg)]">{s.name}</div>
                    <div className="text-[var(--color-muted)] text-xs">
                      {/* Three different things, and the row used to say the
                          first for two of them: a run working on it now, whose
                          log is the previous attempt's; a run that died holding
                          it, which the lease has since released; and no run at
                          all, where the log is this skill's own verdict. */}
                      {holdsLiveAuthoringClaim(s, now)
                        ? 'authoring now · a run holds this skill'
                        : s.authoringRunId
                          ? 'a run stopped without reporting · Retry takes the skill over'
                          : (s.verificationLog ?? s.description)}
                    </div>
                  </div>
                  <button
                    onClick={() => onRetry(s._id, s.name)}
                    disabled={retrying === s._id}
                    className="px-2.5 py-1 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 shrink-0"
                  >
                    {retrying === s._id ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              </li>
            ))}
          </ul>
          {/* Two backends can run the check, so naming one of them is advice
              half the readers cannot act on. The rule that picks between them
              is what tells a reader which line is theirs. */}
          <p className="text-[10px] text-[var(--color-muted)] mt-2">
            Retry re-authors the skill and re-runs the sandbox check. If the sandbox was skipped,
            start one first: run pnpm sandbox:up for the bundled local sandbox, or set
            DAYTONA_API_KEY on the deployment to use Daytona instead. Only one authoring run holds a
            skill at a time, so a retry while one is still running is refused until that run
            finishes or its claim lapses.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

function WorkspacePanel({ workspace }: { workspace: Record<string, string> }) {
  const fileOrder = [
    'AGENTS.md',
    'IDENTITY.md',
    'TOOLS.md',
    'SOUL.md',
    'USER.md',
    'BOOTSTRAP.md',
    'MEMORY.md',
    'HEARTBEAT.md',
  ];
  return (
    <Card title="Workspace · 8-file convention">
      <div className="space-y-1 text-xs">
        {fileOrder.map((name) => {
          const content = workspace[name] ?? '';
          const empty = !content.trim();
          return (
            <details key={name}>
              <summary
                className={`cursor-pointer px-2 py-1 rounded hover:bg-[var(--color-bg)] flex items-center justify-between ${
                  empty ? 'text-[var(--color-muted)]' : 'text-[var(--color-fg)]'
                }`}
              >
                <span className="font-mono">{name}</span>
                <span className="text-[10px]">{empty ? '∅' : `${content.length}b`}</span>
              </summary>
              <pre className="mt-1 ml-2 text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]">
                {empty ? '(empty)' : content}
              </pre>
            </details>
          );
        })}
      </div>
    </Card>
  );
}

function WorkQueue({
  workItems,
  surfaces,
  registeredSkillCount,
  charterApproved,
  autonomousActions,
}: {
  workItems: Doc<'workItems'>[];
  surfaces: SurfaceRecord[];
  registeredSkillCount: number;
  charterApproved: boolean;
  /** Whether the agent's autonomous-actions switch is on, for the cards' wording. */
  autonomousActions: boolean;
}) {
  const evaluate = useAction(api.workActions.evaluateWorkItem);
  const draftPlan = useAction(api.workActions.draftPlan);
  const executePlan = useAction(api.workActions.executeApprovedPlan);
  const approvePlan = useMutation(api.work.approvePlan);
  const cancelPlan = useMutation(api.work.cancelPlan);
  const retryFailed = useMutation(api.work.retryFailed);
  const reconcileFailed = useMutation(api.work.reconcileFailed);
  const approveActions = useMutation(api.work.approveActions);
  const rejectActions = useMutation(api.work.rejectActions);

  const items = useMemo(
    () =>
      [...workItems].sort((a, b) => {
        // What needs the manager first: literal actions awaiting approval,
        // then plans, then skills.
        const order = ['actions-pending', 'plan-pending', 'needs-skill', 'discovered', 'claimed', 'plan-approved', 'executing', 'completed', 'skipped', 'cancelled', 'failed', 'deferred'];
        return order.indexOf(a.state) - order.indexOf(b.state);
      }),
    [workItems],
  );

  // One in-flight call per (step, item). Strict Mode runs every effect twice
  // on mount, and a subscription update re-runs them before the first call has
  // moved the row, so without this the same item is handed to the same action
  // several times over. The backend refuses the duplicates — `claimForExecution`
  // is the authority — but a refusal is not a reason to keep asking.
  const inFlight = useRef(new Set<string>());
  const once = useCallback(
    (step: string, id: string, call: () => Promise<unknown>) => {
      const key = `${step}:${id}`;
      if (inFlight.current.has(key)) return;
      inFlight.current.add(key);
      call()
        .catch(() => {})
        .finally(() => inFlight.current.delete(key));
    },
    [],
  );

  // Auto-progression: once charter is approved, evaluate every discovered
  // item; once a verdict comes back, draft a plan if claim, etc.
  useEffect(() => {
    if (!charterApproved) return;
    for (const it of workItems) {
      if (it.state === 'discovered') {
        once('evaluate', it._id, () => evaluate({ workItemId: it._id }));
        break;
      }
    }
  }, [charterApproved, workItems, evaluate, once]);

  useEffect(() => {
    for (const it of workItems) {
      if (it.state === 'claimed' && !it.plan) {
        once('draft', it._id, () => draftPlan({ workItemId: it._id }));
      }
      if (it.state === 'plan-approved') {
        once('execute', it._id, () => executePlan({ workItemId: it._id }));
      }
    }
  }, [workItems, draftPlan, executePlan, once]);

  return (
    <Card
      title={
        `Work queue · ${items.length} ${items.length === 1 ? 'item' : 'items'} · ` +
        `${registeredSkillCount} ${registeredSkillCount === 1 ? 'skill' : 'skills'} available`
      }
    >
      {items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {charterApproved
            ? 'no work seeded yet'
            : 'work queue lights up after charter approval'}
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <WorkItemCard
              key={item._id}
              item={item}
              surfaces={surfaces}
              autonomousActions={autonomousActions}
              onApprovePlan={() => approvePlan({ workItemId: item._id })}
              onCancelPlan={() => cancelPlan({ workItemId: item._id })}
              onRetryFailed={(feedback) =>
                retryFailed({ workItemId: item._id, ...(feedback?.trim() ? { feedback } : {}) })
              }
              onReconcileFailed={(confirmed) =>
                reconcileFailed({ workItemId: item._id, confirmed })
              }
              onApproveActions={(approvedIndexes) =>
                item.pendingRunId
                  ? approveActions({
                      workItemId: item._id,
                      pendingRunId: item.pendingRunId,
                      approvedIndexes,
                    })
                  : Promise.reject(new Error('The pending run is missing. Refresh the work queue.'))
              }
              onRejectActions={(reason) =>
                item.pendingRunId
                  ? rejectActions({ workItemId: item._id, pendingRunId: item.pendingRunId, reason })
                  : Promise.reject(new Error('The pending run is missing. Refresh the work queue.'))
              }
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function stateColor(state: string): string {
  if (state === 'completed') return 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]';
  if (state === 'plan-pending' || state === 'needs-skill' || state === 'actions-pending') {
    return 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]';
  }
  if (state === 'failed' || state === 'cancelled') return 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';
  if (state === 'skipped' || state === 'deferred') return 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]';
  return 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]';
}

/** One row of the applied ledger as the card reads it. */
interface LedgerRow {
  tool: string;
  ok: boolean;
  held?: boolean;
  awaitingApproval?: boolean;
  /** What authorised the row: the manager's approval, the toggle, or a standing grant. */
  authority?: ActionAuthority;
  effect?: string;
  reason?: string;
  providerId?: string;
  outcomeUnknown?: boolean;
  idempotencyKey?: string;
}

interface PlanStepOutcomeRow {
  step: number;
  status: 'satisfied' | 'blocked';
  evidence: string;
}

/** A run's persisted output as the card reads it, in either of its two phases. */
interface RunOutput {
  draft: string;
  notes: string;
  actions?: MockAction[];
  applied?: LedgerRow[];
  initial?: { applied?: LedgerRow[] };
  planStepOutcomes?: PlanStepOutcomeRow[];
}

type PhasedLedgerRow = LedgerRow & { phase?: 'prerequisite' | 'closing' };

/**
 * Every applied row of a run, prerequisite phase first, each labelled with the
 * phase that applied it when the run had two. A single-phase run carries no
 * label, so the ordinary card is unchanged.
 */
export function phasedLedger(output: RunOutput | undefined): PhasedLedgerRow[] {
  const initial = output?.initial?.applied;
  const closing = output?.applied ?? [];
  if (!initial) return closing.map((row): PhasedLedgerRow => ({ ...row }));
  return [
    ...initial.map((row): PhasedLedgerRow => ({ ...row, phase: 'prerequisite' })),
    ...closing.map((row): PhasedLedgerRow => ({ ...row, phase: 'closing' })),
  ];
}

function PhaseLabel({ phase }: { phase?: 'prerequisite' | 'closing' }) {
  if (!phase) return null;
  return (
    <span className="ml-1 text-[10px] uppercase tracking-wider text-[var(--color-muted)]">
      {phase}
    </span>
  );
}

/**
 * The draft, with an honest account of when it was written: before anything
 * was applied for a single-phase run, after the prerequisite ledger for a run
 * whose closing phase authored it from real results.
 */
export function DraftDetails({ output }: { output: RunOutput }) {
  const closingPhase = output.initial !== undefined || output.planStepOutcomes !== undefined;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-[var(--color-accent)]">
        Draft the agent wrote ({output.draft.length} chars)
      </summary>
      <pre className="mt-2 p-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] whitespace-pre-wrap text-[var(--color-fg)]">
        {output.draft}
      </pre>
      {output.notes ? (
        <p className="mt-1 text-[var(--color-muted)] italic">notes: {output.notes}</p>
      ) : null}
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        {closingPhase
          ? 'The closing draft, written after the prerequisite actions were applied and from their ledger. Only the changes listed above reached the work environment.'
          : "The agent's own words, written before anything was applied. Only the changes listed above reached the work environment."}
      </p>
    </details>
  );
}

/** The approved plan's result-aware accounting, including promised work that could not run. */
export function PlanExecutionLedger({ outcomes }: { outcomes: PlanStepOutcomeRow[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
      <p className="font-medium text-[var(--color-fg)] mb-1">Plan execution ledger</p>
      <ol className="space-y-0.5 text-[var(--color-muted)]">
        {outcomes.map((outcome) => (
          <li key={outcome.step}>
            Step {outcome.step} · {outcome.status} - {outcome.evidence}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The headline of the landed-changes list, naming how many applied under the toggle.
 *
 * Args:
 *   landed: The ledger rows that reached the work environment.
 *
 * Returns:
 *   `3 changes reached the work environment · 3 applied autonomously`, or without the tail.
 */
export function landedHeadline(landed: ReadonlyArray<{ authority?: ActionAuthority }>): string {
  const autonomous = landed.filter((row) => row.authority === 'autonomous').length;
  const head = `${landed.length} ${landed.length === 1 ? 'change' : 'changes'} reached the work environment`;
  return autonomous > 0 ? `${head} · ${autonomous} applied autonomously` : head;
}

/**
 * Why a cancelled work item stopped, for the card.
 *
 * Rows cancelled since the reason was recorded carry it in `skipReason`; an
 * older row is read from what it was doing when it was cancelled.
 *
 * Args:
 *   item: The cancelled work item's reason, verdict and plan.
 *
 * Returns:
 *   One sentence in place of the pre-cancel verdict.
 */
export function cancelledReason(item: {
  skipReason?: string;
  verdict?: { decision?: string; suggestedSkillName?: string };
  plan?: unknown;
}): string {
  if (item.skipReason) return item.skipReason;
  if (item.verdict?.decision === 'needs-skill') {
    const name = item.verdict.suggestedSkillName;
    return name ? `skill proposal "${name}" rejected by the manager` : 'skill proposal rejected by the manager';
  }
  if (item.plan) return 'plan cancelled by the manager';
  return 'cancelled by the manager';
}

/** Show a manager's full rejection while keeping later failure reasons current. */
/** A ledger list row shows the short form of a long read result; the exact payload holds it whole. */
export function clipLedgerRow(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= LEDGER_ROW_LENGTH) return text;
  return `${text.slice(0, LEDGER_ROW_LENGTH - 1)}…`;
}

const LEDGER_ROW_LENGTH = 180;

export function failedItemReason(item: {
  skipReason?: string;
  managerFeedback?: { reason: string };
}): string | undefined {
  if (item.skipReason?.startsWith('rejected by the manager') && item.managerFeedback?.reason) {
    return `rejected by the manager: ${item.managerFeedback.reason}`;
  }
  return item.skipReason;
}

/** Name the winning control for a completed manager decision. */
export function decisionAttribution(
  decision:
    | {
        decidedAt?: number;
        outcome?: 'approved' | 'rejected';
        decidedVia?: 'dashboard' | 'channel';
        surfaceName: string;
      }
    | undefined,
): string | undefined {
  if (!decision?.decidedAt || !decision.outcome || !decision.decidedVia) return undefined;
  const source =
    decision.decidedVia === 'channel' ? decision.surfaceName : 'the day0 dashboard';
  return `${decision.outcome} from ${source}`;
}

/**
 * The verdict per action index, as the gate persisted it.
 *
 * A row held before verdicts existed has none; it reads as `held`, which is
 * what the manager's approval meant then, and the server's apply-time checks
 * still stand behind it.
 *
 * Args:
 *   verdicts: The verdicts persisted when the run was held.
 *   count: How many actions the run holds.
 *
 * Returns:
 *   A verdict per action index.
 */
export function pendingVerdicts(
  verdicts: Doc<'workItems'>['actionVerdicts'] | undefined,
  count: number,
): ActionVerdict[] {
  return Array.from({ length: count }, (_, index): ActionVerdict =>
    normaliseActionVerdict(verdicts?.[index] ?? {}),
  );
}

/**
 * The one-line headline of the gate box.
 *
 * Args:
 *   verdicts: The run's verdicts.
 *
 * Returns:
 *   `2 applied automatically · 1 awaiting your approval`, or the no-auto form.
 */
export function pendingHeadline(verdicts: readonly ActionVerdict[]): string {
  const auto = verdicts.filter((verdict) => verdict.disposition === 'auto').length;
  const held = verdicts.filter((verdict) => verdict.disposition === 'held').length;
  const refused = verdicts.filter((verdict) => verdict.disposition === 'refused').length;
  const awaiting = `${held} ${held === 1 ? 'action' : 'actions'} awaiting your approval`;
  const refusedNote = refused > 0 ? ` · ${refused} refused by the gate` : '';
  if (auto > 0) {
    return `${auto} applied automatically · ${awaiting}${refusedNote}`;
  }
  return `${awaiting}${refusedNote} · nothing has reached a surface`;
}

/**
 * The exact-action gate: every row the ladder did not apply on its own,
 * verbatim, with a checkbox each. Rows classified `auto` were applied before
 * the manager saw the card and are listed with the changes that reached the
 * work environment; nothing else reaches a surface until it is approved here.
 */
export function PendingActions({
  actions,
  verdicts,
  surfaces,
  replyTarget,
  autonomousActions = false,
  onApprove,
  onReject,
}: {
  actions: MockAction[];
  verdicts: ActionVerdict[];
  surfaces: SurfaceRecord[];
  replyTarget?: ReplyTarget;
  /** Whether the agent's switch is on now; the card says why the rows are waiting either way. */
  autonomousActions?: boolean;
  onApprove: (approvedIndexes: number[]) => Promise<unknown>;
  onReject: (reason: string) => Promise<unknown>;
}) {
  // The gate decided each row when it held the run: `auto` rows are already
  // applied and are not shown here; `refused` rows (a missing grant, an
  // unconnected surface, a forged trailer) cannot be ticked and the server
  // refuses them at approval; `held` rows are the manager's to approve. The
  // "Approve all" button is disabled while a refused row exists so it never
  // promises what the gate will not deliver.
  const refusedIndexes = useMemo(
    () => new Set(verdicts.flatMap((verdict, index) => (verdict.disposition === 'refused' ? [index] : []))),
    [verdicts],
  );
  const heldIndexes = useMemo(
    () => verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : [])),
    [verdicts],
  );
  const shown = useMemo(
    () => actions.map((action, index) => ({ action, index })).filter(({ index }) => verdicts[index]?.disposition !== 'auto'),
    [actions, verdicts],
  );
  const [selected, setSelected] = useState<Set<number>>(() => new Set(heldIndexes));
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(call: () => Promise<unknown>): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await call();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function toggle(index: number, on: boolean): void {
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(index);
      else next.delete(index);
      return next;
    });
  }

  const anyRefused = refusedIndexes.size > 0;
  return (
    <div className="mt-3 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="text-[var(--color-warn)] font-medium mb-1">{pendingHeadline(verdicts)}</p>
      {heldIndexes.length > 0 ? (
        <p className="text-[var(--color-muted)] mb-1">
          {autonomousActions ? HELD_BEFORE_AUTONOMY_NOTE : HELD_WHILE_SUPERVISED_NOTE}
        </p>
      ) : null}
      {actions.length === 0 ? (
        <p className="text-[var(--color-muted)]">
          The skill emitted no actions. Approving lands nothing; reject to send it back.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map(({ action, index }) => {
            const verdict = verdicts[index];
            const refused = verdict?.disposition === 'refused';
            const on = selected.has(index);
            return (
              <li key={index} className="flex items-start gap-2">
                <input
                  type="checkbox"
                  className="mt-0.5"
                  checked={on}
                  disabled={busy || refused}
                  onChange={(event) => toggle(index, event.target.checked)}
                  aria-label={`approve action ${index + 1}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--color-fg)] break-words">
                    {summariseAction(action, surfaces, { replyTarget })}
                    {refused ? (
                      <span className="text-[var(--color-warn)]"> · refused · {verdict.reason}</span>
                    ) : verdict?.disposition === 'held' ? (
                      <span className="text-[var(--color-muted)]"> · {verdict.reason}</span>
                    ) : null}
                  </p>
                  <details className="mt-0.5">
                    <summary className="text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={action} />
                  </details>
                  <div className="flex items-center gap-2 mt-0.5">
                    {!refused && !on ? (
                      <span className="text-[10px] text-[var(--color-muted)]">held · will not be sent</span>
                    ) : null}
                    {refused ? null : on ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, false)}
                        className="text-[10px] text-[var(--color-danger)] underline"
                      >
                        reject this action
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, true)}
                        className="text-[10px] text-[var(--color-accent)] underline"
                      >
                        include
                      </button>
                    )}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy || actions.length === 0}
          onClick={() => submit(() => onApprove([...selected].sort((a, b) => a - b)))}
          className="px-3 py-1 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={busy || anyRefused || heldIndexes.length === 0}
          title={
            anyRefused
              ? 'A row in this run is refused by the gate and cannot be approved; approve the rest by selection.'
              : undefined
          }
          onClick={() => submit(() => onApprove(heldIndexes))}
          className="px-3 py-1 rounded-md border border-[var(--color-ok)]/40 text-[var(--color-ok)] text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Approve all
        </button>
        <input
          type="text"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          placeholder="reason for rejecting"
          className="flex-1 min-w-[10rem] px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => submit(() => onReject(reason))}
          className="px-3 py-1 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
        >
          Reject run
        </button>
      </div>
      {error ? <p className="mt-1 text-[10px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

function WorkItemCard({
  item,
  surfaces,
  autonomousActions,
  onApprovePlan,
  onCancelPlan,
  onRetryFailed,
  onReconcileFailed,
  onApproveActions,
  onRejectActions,
}: {
  item: Doc<'workItems'>;
  surfaces: SurfaceRecord[];
  autonomousActions: boolean;
  onApprovePlan: () => void;
  onCancelPlan: () => void;
  onRetryFailed: (feedback?: string) => void;
  onReconcileFailed: (confirmed: boolean) => Promise<unknown>;
  onApproveActions: (approvedIndexes: number[]) => Promise<unknown>;
  onRejectActions: (reason: string) => Promise<unknown>;
}) {
  const now = useNow();
  const verdict = item.verdict as
    | { decision: string; reason?: string; suggestedSkillName?: string; missingSurface?: string }
    | undefined;
  const plan = item.plan as
    | {
        summary: string;
        steps: string[];
        riskNotes: string;
        reversibility: string;
        estimatedMinutes: number;
        expectedOutputType: string;
      }
    | undefined;
  const output = item.output as RunOutput | undefined;
  const appliedActions = phasedLedger(output);
  // A row the auto phase deferred is in the gate box above, not in the ledger's held list.
  const heldActions = appliedActions.filter((a) => a.held && !a.awaitingApproval);
  const failedActions = appliedActions.filter((a) => !a.ok && !a.held);
  const landedActions = appliedActions.filter((a) => a.ok && !a.held);
  const reconciliationEntries = item.providerReconciliation?.entries ??
    providerReconciliationEntries(output);
  const needsProviderReconciliation = retryRequiresProviderReconciliation(
    output,
    item.skipReason,
  );
  const retryBlocked = needsProviderReconciliation && !item.providerReconciliation;
  // The quality-fit filter's skip is the agent's judgement, not the manager's;
  // Retry hands the item back with that filter waived.
  const qualityFitSkipped =
    item.state === 'skipped' &&
    typeof (verdict as { reason?: unknown } | undefined)?.reason === 'string' &&
    ((verdict as { reason: string }).reason).startsWith(QUALITY_FIT_SKIP_PREFIX);
  const [retryNote, setRetryNote] = useState('');
  const awaitingSurface =
    verdict?.decision === 'defer' && verdict.reason === 'awaiting-connection'
      ? surfaces.find((surface) => surface.slug === verdict.missingSurface)
      : undefined;
  const decidedFrom = decisionAttribution(item.decision);
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${stateColor(item.state)}`}
            >
              {item.state}
            </span>
            <span className="text-[10px] text-[var(--color-muted)]">
              {item.sourceSystem}/{item.sourceCategory}
            </span>
            {item.priority ? (
              <span className="text-[10px] text-[var(--color-warn)]">{item.priority}</span>
            ) : null}
          </div>
          <h3 className="text-sm font-medium text-[var(--color-fg)]">{item.title}</h3>
          <p className="text-xs text-[var(--color-muted)] mt-1 line-clamp-2">{item.contentSummary}</p>
        </div>
      </div>

      {decidedFrom ? (
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">{decidedFrom}</p>
      ) : null}

      {item.state === 'cancelled' ? (
        <div className="mt-2 text-xs">
          <span className="text-[var(--color-muted)]">cancelled:</span>{' '}
          <span className="text-[var(--color-fg)]">
            {cancelledReason({ skipReason: item.skipReason, verdict, plan })}
          </span>
        </div>
      ) : verdict ? (
        <div className="mt-2 text-xs">
          <span className="text-[var(--color-muted)]">verdict:</span>{' '}
          {verdict.decision === 'defer' && verdict.reason === 'awaiting-connection' ? (
            <span className="text-[var(--color-fg)]">
              defer - awaiting-connection: {verdict.missingSurface ?? '(unnamed system)'}
              {awaitingSurface ? ` (${verdictFor(awaitingSurface, now)})` : ' (not listed)'}{' '}
              <a href="#surfaces" className="text-[var(--color-accent)] underline">
                Surfaces tab
              </a>
            </span>
          ) : (
            <span className="text-[var(--color-fg)]">
              {verdict.decision}
              {verdict.reason ? ` — ${verdict.reason}` : ''}
            </span>
          )}
        </div>
      ) : null}

      {plan ? (
        <div className="mt-3 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
          <div className="font-medium text-[var(--color-fg)] mb-1">Plan ({plan.estimatedMinutes}m, {plan.reversibility})</div>
          <div className="text-[var(--color-muted)] mb-2">{plan.summary}</div>
          <ol className="list-decimal pl-5 space-y-0.5 text-[var(--color-fg)]">
            {plan.steps.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          {item.state === 'plan-pending' ? (
            <div className="flex gap-2 mt-2">
              <button
                onClick={onApprovePlan}
                className="px-3 py-1 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs"
              >
                Approve plan
              </button>
              <button
                onClick={onCancelPlan}
                className="px-3 py-1 rounded-md border border-[var(--color-border)] text-xs"
              >
                Cancel
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {item.state === 'executing' && item.applyPhase === 'auto' ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          applying {item.approvedIndexes?.length ?? 0}{' '}
          {(item.approvedIndexes?.length ?? 0) === 1 ? 'action' : 'actions'}{' '}
          {autonomousActions ? 'autonomously' : 'automatically'}…
        </p>
      ) : null}

      {item.state === 'actions-pending' && output?.initial !== undefined ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">
          Closing actions, authored from the prerequisite ledger below.
        </p>
      ) : null}

      {item.state === 'actions-pending' && output && item.approvedIndexes === undefined ? (
        <PendingActions
          key={`${item._id}:${item.pendingRunId ?? ''}`}
          actions={output.actions ?? []}
          verdicts={pendingVerdicts(item.actionVerdicts, output.actions?.length ?? 0)}
          surfaces={surfaces}
          replyTarget={replyTargetFor(item)}
          autonomousActions={autonomousActions}
          onApprove={onApproveActions}
          onReject={onRejectActions}
        />
      ) : item.state === 'actions-pending' && item.approvedIndexes !== undefined ? (
        <p className="mt-2 text-xs text-[var(--color-muted)]">applying the approved actions…</p>
      ) : null}

      {/* The record of the run, ahead of the prose that describes it. The draft
          is written before a single action is applied, so it is the agent's
          account of the work; this list is what the work environment actually
          received. A reader who only ever sees the draft cannot tell the two
          apart, which is the whole of the failure this panel answers. */}
      {landedActions.length > 0 ? (
        <div className="mt-3 p-2 rounded-md bg-[var(--color-ok)]/10 border border-[var(--color-ok)]/30 text-xs">
          <p className="text-[var(--color-ok)] font-medium mb-1">{landedHeadline(landedActions)}</p>
          <ul className="space-y-0.5 text-[var(--color-fg)]">
            {landedActions.map((a, i) => (
              <li key={i}>
                <span className="font-mono text-[10px] text-[var(--color-muted)]">{a.tool}</span>{' '}
                {clipLedgerRow(a.effect) ?? '(applied)'}
                {a.providerId ? (
                  <span className="ml-1 font-mono text-[10px] text-[var(--color-muted)]">
                    id {a.providerId}
                  </span>
                ) : null}
                <PhaseLabel phase={a.phase} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {/* Held is its own list, not a success and not a failure: the gate or the
          manager kept it back, and the ledger says so. */}
      {heldActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-muted)]/10 border border-[var(--color-border)] text-xs">
          <p className="text-[var(--color-muted)] font-medium mb-1">
            {heldActions.length} {heldActions.length === 1 ? 'action' : 'actions'} held · never sent
          </p>
          <ul className="space-y-0.5 text-[var(--color-muted)]">
            {heldActions.map((a, i) => (
              <li key={i}>
                <span className="font-mono text-[10px]">{a.tool}</span> - {a.reason ?? 'held'}
                <PhaseLabel phase={a.phase} />
                {a.effect ? (
                  <code className="block font-mono text-[10px] whitespace-pre-wrap break-words">{a.effect}</code>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <PlanExecutionLedger outcomes={output?.planStepOutcomes ?? []} />

      {output ? <DraftDetails output={output} /> : null}

      {/* Not inside the details element above: an action that never reached the
          work environment is the headline of this card, not a footnote to the
          draft it produced. */}
      {failedActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-xs">
          <p className="text-[var(--color-danger)] font-medium mb-1">
            {failedActions.length} {failedActions.length === 1 ? 'action' : 'actions'} did not reach
            the work environment
          </p>
          <ul className="space-y-0.5 text-[var(--color-danger)]">
            {failedActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason ?? 'unknown reason'}
                <PhaseLabel phase={a.phase} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.state === 'failed' || qualityFitSkipped ? (
        <div className="mt-2">
          {/* The per-action box above already names every action that failed, so
              the row-level reason only earns its space for the other failures:
              no registered skill, a model error, a mid-run throw, a rejection. */}
          {failedActions.length === 0 && failedItemReason(item) ? (
            <p className="text-[10px] text-[var(--color-muted)] italic mb-1.5">
              {failedItemReason(item)}
            </p>
          ) : null}
          {needsProviderReconciliation || item.providerReconciliation ? (
            <ProviderReconciliationControl
              entries={reconciliationEntries}
              reconciliation={item.providerReconciliation}
              onConfirm={onReconcileFailed}
            />
          ) : null}
          {item.state === 'failed' ? (
            <input
              type="text"
              value={retryNote}
              onChange={(event) => setRetryNote(event.target.value)}
              placeholder="note for the retry (optional): answer what the agent asked, or say what to change"
              aria-label="note for the retry"
              className="w-full mb-1.5 px-2 py-1 rounded-md border border-[var(--color-border)] bg-transparent text-xs"
            />
          ) : null}
          <button
            onClick={() => onRetryFailed(retryNote)}
            disabled={retryBlocked}
            className="px-3 py-1 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Retry
          </button>
          {retryBlocked ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry remains disabled until provider reconciliation is recorded.
            </p>
          ) : null}
          {qualityFitSkipped ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry re-evaluates this item without the quality-fit filter; its plan still needs
              your approval.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ProviderReconciliationControl({
  entries,
  reconciliation,
  onConfirm,
}: {
  entries: readonly ReconciliationEntry[];
  reconciliation?: { actor: string; confirmedAt: number };
  onConfirm: (confirmed: boolean) => Promise<unknown>;
}) {
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    if (!confirmed || busy || reconciliation) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(confirmed);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not record reconciliation.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mb-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="font-medium text-[var(--color-warn)]">
        {reconciliation ? 'Provider state reconciled' : 'Provider reconciliation required'}
      </p>
      {entries.length > 0 ? (
        <ul className="mt-1 space-y-1 text-[var(--color-fg)]">
          {entries.map((entry) => (
            <li key={`${entry.phase}:${entry.actionIndex}:${entry.idempotencyKey ?? ''}`}>
              <span className="font-mono text-[10px]">
                {entry.phase} action {entry.actionIndex} · {entry.tool} ·{' '}
                {entry.outcome === 'outcome-unknown' ? 'outcome unknown' : 'landed'}
              </span>
              {entry.effect ? <span className="block">{clipLedgerRow(entry.effect)}</span> : null}
              {entry.reason ? <span className="block">{entry.reason}</span> : null}
              {entry.providerId ? (
                <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                  provider id {entry.providerId}
                </span>
              ) : null}
              {entry.idempotencyKey ? (
                <span className="block font-mono text-[10px] text-[var(--color-muted)]">
                  idempotency key {entry.idempotencyKey}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-[var(--color-danger)]">
          The applied ledger does not identify the affected entries. Retry remains disabled.
        </p>
      )}
      {reconciliation ? (
        <p className="mt-1 text-[var(--color-muted)]">
          Verified by <span className="font-mono">{reconciliation.actor}</span> at{' '}
          <time dateTime={new Date(reconciliation.confirmedAt).toISOString()}>
            {new Date(reconciliation.confirmedAt).toISOString()}
          </time>
          . Retry is enabled.
        </p>
      ) : (
        <>
          <label className="mt-2 flex items-start gap-2 text-[var(--color-fg)]">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || entries.length === 0}
              onChange={(event) => setConfirmed(event.target.checked)}
            />
            I verified these entries against the provider state.
          </label>
          <button
            type="button"
            disabled={!confirmed || busy || entries.length === 0}
            onClick={() => void submit()}
            className="mt-2 px-3 py-1 rounded-md border border-[var(--color-warn)]/40 text-[var(--color-warn)] text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm reconciliation
          </button>
          {error ? <p className="mt-1 text-[var(--color-danger)]">{error}</p> : null}
        </>
      )}
    </div>
  );
}

type PermissionSource = 'deploy' | 'manager' | 'skill' | 'surface';

export interface PermissionScopeView {
  scope: string;
  active: boolean;
  source: PermissionSource;
  grantedAt: number;
  revokedAt: number | null;
}

const PERMISSION_SOURCE_LABEL: Record<PermissionSource, string> = {
  deploy: 'deploy',
  manager: 'manager',
  skill: 'skill',
  surface: 'surface',
};

export function PermissionRows({
  scopes,
  confirmingScope,
  busyScope,
  onAskRevoke,
  onCancelRevoke,
  onRevoke,
  onRegrant,
}: {
  scopes: PermissionScopeView[];
  confirmingScope: string | null;
  busyScope: string | null;
  onAskRevoke: (scope: string) => void;
  onCancelRevoke: () => void;
  onRevoke: (scope: string) => void;
  onRegrant: (scope: string) => void;
}) {
  return (
    <ul className="space-y-2 text-xs">
      {scopes.map((row) => {
        const confirming = confirmingScope === row.scope;
        const busy = busyScope === row.scope;
        return (
          <li key={row.scope} className="rounded-md border border-[var(--color-border)] p-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[var(--color-fg)] truncate">{row.scope}</p>
                <p className="text-[10px] text-[var(--color-muted)]">
                  {row.active ? 'granted' : 'revoked'} - from{' '}
                  {PERMISSION_SOURCE_LABEL[row.source]}
                </p>
              </div>
              {row.active ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onAskRevoke(row.scope)}
                  className="shrink-0 px-2 py-1 rounded border border-[var(--color-danger)]/40 text-[10px] text-[var(--color-danger)] disabled:opacity-50"
                >
                  Revoke
                </button>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onRegrant(row.scope)}
                  className="shrink-0 px-2 py-1 rounded border border-[var(--color-accent)]/40 text-[10px] text-[var(--color-accent)] disabled:opacity-50"
                >
                  Re-grant
                </button>
              )}
            </div>
            {confirming ? (
              <div className="mt-2 pt-2 border-t border-[var(--color-border)]">
                <p className="text-[10px] text-[var(--color-fg)] mb-2">
                  Revoke {row.scope}? Day0 will stop queued and in-flight work that still needs this
                  standing scope at its final authority check. Actions already approved by you keep
                  their exact approval; a provider call past its final authority check may still finish.
                </p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRevoke(row.scope)}
                    className="px-2 py-1 rounded bg-[var(--color-danger)]/20 text-[10px] text-[var(--color-danger)] disabled:opacity-50"
                  >
                    Confirm revoke
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={onCancelRevoke}
                    className="px-2 py-1 rounded border border-[var(--color-border)] text-[10px] disabled:opacity-50"
                  >
                    Keep grant
                  </button>
                </div>
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PermissionsCard({ agentId }: { agentId: Id<'agents'> }) {
  const scopes = useQuery(api.agents.permissionScopes, { agentId });
  const revokeScope = useMutation(api.agents.revokeScope);
  const grantScopes = useMutation(api.agents.grantScopes);
  const [confirmingScope, setConfirmingScope] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function change(scope: string, kind: 'revoke' | 'grant'): Promise<void> {
    setBusyScope(scope);
    setError(null);
    try {
      if (kind === 'revoke') {
        await revokeScope({
          agentId,
          scope,
          reason: 'Revoked by the manager from the agent dashboard.',
        });
        setConfirmingScope(null);
      } else {
        await grantScopes({ agentId, scopes: [scope] });
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyScope(null);
    }
  }

  return (
    <Card title="Permissions">
      <p className="text-[10px] text-[var(--color-muted)] mb-3 leading-relaxed">
        Reads and manager messages stop when their grant is revoked. A literal write you approve
        remains authorised by that exact approval.
      </p>
      {scopes === undefined ? (
        <p className="text-xs text-[var(--color-muted)]">loading permissions…</p>
      ) : scopes.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">no permission history yet</p>
      ) : (
        <PermissionRows
          scopes={scopes}
          confirmingScope={confirmingScope}
          busyScope={busyScope}
          onAskRevoke={setConfirmingScope}
          onCancelRevoke={() => setConfirmingScope(null)}
          onRevoke={(scope) => void change(scope, 'revoke')}
          onRegrant={(scope) => void change(scope, 'grant')}
        />
      )}
      {error ? <p className="mt-2 text-[10px] text-[var(--color-danger)]">{error}</p> : null}
    </Card>
  );
}

export function formatMetricDuration(milliseconds: number | null): string {
  if (milliseconds === null) return 'not yet';
  const totalSeconds = Math.round(milliseconds / 1_000);
  if (totalSeconds < 60) return `${totalSeconds} s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds === 0 ? `${minutes} min` : `${minutes} min ${seconds} s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0 ? `${hours} h` : `${hours} h ${remainingMinutes} min`;
}

function metricValue(value: string | undefined): string {
  return value ?? 'loading…';
}

export function MetricsCard({ metrics }: { metrics: AgentMetrics | undefined }) {
  const humanDecisions = metrics
    ? metrics.decisions.requested === 0
      ? 'not yet'
      : `${metrics.decisions.approved} / ${metrics.decisions.rejected}`
    : undefined;
  const blocked = metrics
    ? metrics.actions.blockedAfterRevocation === null
      ? 'not yet'
      : String(metrics.actions.blockedAfterRevocation)
    : undefined;
  const completeness = metrics
    ? metrics.auditTrail.fraction === null
      ? 'not yet'
      : `${Math.round(metrics.auditTrail.fraction * 100)}% (${metrics.auditTrail.complete}/${metrics.auditTrail.total})`
    : undefined;
  const rows = [
    {
      label: 'time to first approved charter',
      value: metrics ? formatMetricDuration(metrics.charter.timeToFirstApprovedMs) : undefined,
    },
    { label: 'human decisions (approved / rejected)', value: humanDecisions },
    {
      label: 'median decision latency',
      value: metrics ? formatMetricDuration(metrics.decisions.medianLatencyMs) : undefined,
    },
    { label: 'actions blocked after revocation', value: blocked },
    { label: 'audit-trail completeness', value: completeness },
  ];
  return (
    <Card title="Supervision metrics" tone="accent">
      <dl className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3 text-xs">
            <dt className="text-[var(--color-muted)] leading-tight">{row.label}</dt>
            <dd className="font-mono text-[var(--color-fg)] text-right shrink-0">
              {metricValue(row.value)}
            </dd>
          </div>
        ))}
      </dl>
      {metrics ? (
        <p className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-muted)] leading-relaxed">
          {metrics.decisions.requested} decisions requested - {metrics.decisions.partiallyApproved}{' '}
          partial - {metrics.actions.autoApplied} actions automatic - {metrics.actions.held} held -{' '}
          {metrics.actions.refused} refused
        </p>
      ) : null}
    </Card>
  );
}

export function eventLabel(event: Pick<Doc<'events'>, 'type' | 'payload'>): string {
  if (event.type !== 'surface.charter-match-ambiguous') return event.type;
  const candidateSlugs = (event.payload as { candidateSlugs?: unknown }).candidateSlugs;
  if (!Array.isArray(candidateSlugs) || !candidateSlugs.every((slug) => typeof slug === 'string')) {
    return event.type;
  }
  return `${event.type}: ${candidateSlugs.join(', ')}`;
}

function EventTicker({ events }: { events: Doc<'events'>[] }) {
  const now = useNow();
  return (
    <Card title="Live event feed">
      <ul className="space-y-1 text-[10px] font-mono max-h-72 overflow-y-auto">
        {events.map((e) => (
          <li key={e._id} className="flex gap-2 text-[var(--color-muted)]">
            {/* Was a UTC clock beside the Slack panel's local one — the same
                event stamped eight hours apart on one page. */}
            <span className="shrink-0 tabular-nums" title={clockTimeWithSeconds(e.createdAt)}>
              {relativeTime(e.createdAt, now)}
            </span>
            <span className="text-[var(--color-accent)]">{eventLabel(e)}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/**
 * The literal payload of one held action, readable.
 *
 * Args:
 *   props: The action as the skill emitted it.
 *
 * Returns:
 *   The verb and the arguments it reads, as JSON.
 */
export function ActionPayload({ action }: { action: MockAction }): React.ReactNode {
  return (
    <code className="block font-mono text-[10px] text-[var(--color-fg)] whitespace-pre-wrap break-words">
      {JSON.stringify(reviewPayload(action), null, 2)}
    </code>
  );
}
