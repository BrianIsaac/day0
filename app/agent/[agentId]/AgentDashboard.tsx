'use client';

import {
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from '@/work/types';
import Link from 'next/link';
import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import { ChatRoom } from './ChatRoom';
import { VoiceRoom } from './VoiceRoom';
import { MockEnvironment } from './MockEnvironment';
import {
  AppliedCorrectionsLine,
  KeptCorrectionsPanel,
  keptCorrectionsTitle,
  type KeptCorrection,
} from './corrections-panel';
import { holdsLiveAuthoringClaim } from '../../../src/lib/skill-authoring';
import { declaredSkillInputs, impliedSkillInputs, systemDeclaredInputs } from '../../../src/work/skill-inputs';
import {
  type ActionVerdict,
  describeAction,
  HELD_WITHHELD_TRANSITION,
  isGateRefusal,
  isSurfaceTool,
  normaliseActionVerdict,
  reviewPayload,
  skillApprovalRefusal,
} from '../../../src/surfaces/policy';
import {
  AUTONOMY_WARNING,
  autonomousActionsOn,
  autonomyLabel,
  autonomyTurnedOnAfterDraft,
  autonomyTurnedOnAfterDraftNote,
  type AutonomyChange,
  HELD_BEFORE_AUTONOMY_NOTE,
  HELD_WITHHELD_TRANSITION_NOTE,
  HELD_WHILE_SUPERVISED_NOTE,
  SUPERVISED_LABEL,
} from '../../../src/work/autonomy';
import { toSurfaceRecord } from '../../../src/surfaces/records';
import { summariseAction, type ReplyTarget } from '../../../src/surfaces/summary';
import type { ActionAuthority, SurfaceRecord } from '../../../src/surfaces/types';
import { verdictFor } from '../../../src/surfaces/verdict';
import {
  strikePreview,
  type CharterConstraint,
  type StrikePreview,
} from '../../../src/agent/charter-constraints';
import {
  LIST_CLAUSE_FIELDS,
  nextCharterVersion,
  type CharterChange,
  type ListClauseField,
} from '../../../src/agent/charter-amendment';
import { SYSTEM_CLASSES, type SystemClass } from '../../../src/agent/system-classes';
import { managerOpenQuestions, synthesisNotes } from '../../../src/agent/manager-questions';
import { replyTargetFor } from '../../../src/work/reply-target';
import {
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
  type ReconciliationEntry,
} from '../../../src/work/reconciliation';
import type { ArgumentRepairAttempt, MockAction, PlanObligations } from '../../../src/work/types';
import { isWithheldForAnswer, planObligations, transitionWithheld } from '../../../src/work/obligations';
import { clockTime, clockTimeWithSeconds, relativeTime, useNow } from './time';
import { undeliveredDecisionReason } from '../../../src/work/manager-channel';
import { managerFeedbackLabel, type ManagerFeedback } from '../../../src/work/manager-feedback';
import { GATE_REFUSAL_STOP, isGateRefusalStop, isStopped, stopDetail } from '../../../src/work/stop';
import {
  managerNotificationMode,
  NOTIFICATION_MODE_LABELS,
  type ManagerNotificationMode,
} from '../../../src/work/manager-notes';
import type { AgentMetrics } from '../../../convex/metrics';
import { formatAuditTrail, formatMetricDuration } from '../../metric-format';

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
  const openQuestions = useQuery(api.managerQuestions.openForAgent, { agentId });
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
  // Real mode only, as the corrections are: the mock keeps none.
  const correctionRows = useQuery(
    api.corrections.listForAgent,
    surfaceConfig?.mode === 'real' ? { agentId } : 'skip',
  );
  const corrections: KeptCorrection[] = correctionRows ?? [];
  // Real mode only: the mock has no switch, so nothing there ever flips it.
  const autonomyChanges = useQuery(
    api.events.autonomyChanges,
    surfaceConfig?.mode === 'real' ? { agentId } : 'skip',
  );
  const retireCorrection = useMutation(api.corrections.retire);
  const itemTitles = useMemo(
    (): Map<string, string> => new Map((workItems ?? []).map((item) => [item._id, item.title])),
    [workItems],
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
      <DashboardHeader agent={agent} charter={charter ?? null} />

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
            agentId={agentId}
            workItems={workItems ?? []}
            openQuestions={openQuestions ?? []}
            surfaces={surfaces}
            registeredSkillCount={(registeredSkills ?? []).length}
            charterApproved={!!charter?.approved}
            autonomousActions={agent ? autonomousActionsOn(agent) : false}
            surfaceMode={surfaceConfig?.mode}
            corrections={corrections}
            autonomyChanges={autonomyChanges ?? []}
          />
        </div>

        <div className="space-y-4">
          <WorkspacePanel workspace={workspace ?? {}} />
          <RegisteredSkillsPanel
            skills={registeredSkills ?? []}
            unregistered={[...(unverifiedSkills ?? []), ...(failedSkills ?? [])]}
            authoringFailure={authoringFailure}
            onAuthoringAttempt={setLastAttempt}
            surfaceMode={surfaceConfig?.mode}
          />
          {surfaceConfig?.mode === 'real' ? (
            <Card title={keptCorrectionsTitle(corrections)}>
              <KeptCorrectionsPanel
                corrections={corrections}
                titles={itemTitles}
                onRetire={(correctionId) => retireCorrection({ correctionId })}
              />
            </Card>
          ) : null}
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

/**
 * How the manager hears about run outcomes over the chat surface: as each
 * run finishes, or in one hourly digest. Decision requests are sent at once
 * in either mode, so the choice only quietens what is for information.
 */
export function NotificationModeControl({
  mode,
  onChange,
}: {
  mode: ManagerNotificationMode;
  onChange: (mode: ManagerNotificationMode) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <label
      className="flex items-center gap-1.5 px-3 py-1 rounded-full border border-[var(--color-border)] text-[10px] text-[var(--color-muted)]"
      title="Decision requests are always sent at once. This sets how you hear that work landed or a run stopped."
    >
      <span>Manager DMs</span>
      <select
        aria-label="Manager DMs"
        value={mode}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value as ManagerNotificationMode;
          setBusy(true);
          setError(null);
          onChange(next)
            .catch((err: unknown) => setError((err as Error).message))
            .finally(() => setBusy(false));
        }}
        className="bg-transparent text-xs text-[var(--color-fg)] disabled:cursor-wait"
      >
        {(Object.keys(NOTIFICATION_MODE_LABELS) as ManagerNotificationMode[]).map((option) => (
          <option key={option} value={option}>
            {NOTIFICATION_MODE_LABELS[option]}
          </option>
        ))}
      </select>
      {error ? <span className="text-[var(--color-danger)]">{error}</span> : null}
    </label>
  );
}

export function DashboardHeader({
  agent,
  charter,
}: {
  agent: Doc<'agents'>;
  /** What the page is showing, which outranks the row when the two disagree. */
  charter: Doc<'charters'> | null;
}) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const setManagerNotifications = useMutation(api.agents.setManagerNotifications);
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
    active: { text: `Active · ${SUPERVISED_LABEL}`, tone: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]' },
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
            <NotificationModeControl
              mode={managerNotificationMode(agent)}
              onChange={(mode) => setManagerNotifications({ agentId: agent._id, mode })}
            />
          ) : null}
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

/** The charter body as the card reads it; `constraints` is absent on charters drafted before the list existed. */
export interface CharterCardBody {
  whyThisHire: string;
  proposedFunction: string;
  shortTermGoals: { day30: string; day60: string; day90: string };
  proposedBoundaries: { willDo: string[]; willNotDo: string[]; escalationTriggers: string[] };
  namedCollaborators: Array<{ name: string; topic: string }>;
  namedSystems?: Array<{ name: string; class: string; whereMentioned: string }>;
  priorityReading: string[];
  openQuestions: string[];
  constraints?: CharterConstraint[];
  answeredQuestions?: Array<{ question: string; answer: string; answeredAt: string }>;
  synthesisNotes?: string[];
}

const CONSTRAINT_KIND_LABEL: Record<CharterConstraint['kind'], string> = {
  'candidate-property': 'what work qualifies',
  'system-boundary': 'where I may act',
  'reporting-line': 'who I report to',
};

/** The clauses a strike removes, quoted for the card. */
function quotedClauses(clauses: readonly string[]): string {
  return clauses.map((clause: string): string => `\u201c${clause}\u201d`).join('; ');
}

/**
 * The confirm-or-strike list: every rule the draft will enforce, in the
 * manager's own words, beside the clause phrases that encode it.
 *
 * Before approval each row can be struck or restored; the clauses on the card
 * stay as drafted until Approve, which is when struck wording leaves them.
 * After approval the list is the record of what was confirmed and what was
 * struck. With `previewStrike` each row says what its strike would remove,
 * and a strike the effective charter refuses is disabled with the reason, so
 * nothing the card offers can fail at approval.
 */
export function ConstraintList({
  constraints,
  approved,
  onStrike,
  onRestore,
  previewStrike,
}: {
  constraints: CharterConstraint[];
  approved: boolean;
  /** Strike a confirmed rule; before approval a draft flag, after it an amendment. */
  onStrike?: (index: number) => void;
  /** Restore a struck rule; only a draft can, because a strike after approval has already left the clauses. */
  onRestore?: (index: number) => void;
  /** What striking a rule would do, computed as approval computes it. */
  previewStrike?: (index: number) => StrikePreview;
}) {
  if (constraints.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {approved ? 'Rules this charter enforces' : 'These words will limit the work. Confirm or strike each one.'}
      </div>
      <ul className="space-y-1.5">
        {constraints.map((constraint, index) => {
          const preview =
            !constraint.struck && onStrike && previewStrike ? previewStrike(index) : undefined;
          return (
          <li
            key={index}
            className={`flex items-start gap-2 p-2 rounded-md border ${
              constraint.struck
                ? 'border-[var(--color-border)] text-[var(--color-muted)]'
                : 'border-[var(--color-warn)]/40'
            }`}
          >
            <div className="flex-1 min-w-0">
              <p className={constraint.struck ? 'line-through' : 'text-[var(--color-fg)]'}>
                &ldquo;{constraint.quote}&rdquo;
              </p>
              <p className="text-[10px] text-[var(--color-muted)] mt-0.5">
                {CONSTRAINT_KIND_LABEL[constraint.kind]}
                {constraint.wording.length > 0 ? (
                  <>
                    {' · in the charter as '}
                    {constraint.wording.map((phrase, i) => (
                      <span key={i}>
                        {i > 0 ? ', ' : ''}
                        <span className="font-mono text-[var(--color-fg)]">{phrase}</span>
                      </span>
                    ))}
                  </>
                ) : (
                  ' · no clause carries it'
                )}
                {constraint.origin === 'derived' ? ' · found by checking the clauses' : ''}
                {constraint.origin === 'manager' ? ' · added by you' : ''}
                {constraint.struck ? ' · struck' : ''}
              </p>
              {preview?.refusal ? (
                <p className="text-[10px] text-[var(--color-warn)] mt-0.5">
                  cannot be struck: {preview.refusal}
                </p>
              ) : preview && preview.removedClauses.length > 0 ? (
                <p className="text-[10px] text-[var(--color-muted)] mt-0.5">
                  {preview.removedClauses.length === 1 ? 'strikes the clause: ' : 'strikes the clauses: '}
                  {quotedClauses(preview.removedClauses)}
                </p>
              ) : null}
              {preview && !preview.refusal
                ? preview.rewrittenClauses.map((pair, i) => (
                    <p key={i} className="text-[10px] text-[var(--color-muted)] mt-0.5">
                      {'rewrites the clause: '}
                      {quotedClauses([pair.from])}
                      {' to '}
                      {quotedClauses([pair.to])}
                    </p>
                  ))
                : null}
            </div>
            {!constraint.struck && onStrike ? (
              <button
                onClick={() => onStrike(index)}
                disabled={preview?.refusal !== undefined}
                title={preview?.refusal}
                className="shrink-0 px-2 py-1 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-warn)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--color-border)]"
              >
                Strike
              </button>
            ) : constraint.struck && onRestore ? (
              <button
                onClick={() => onRestore(index)}
                className="shrink-0 px-2 py-1 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-ok)]"
              >
                Restore
              </button>
            ) : null}
          </li>
          );
        })}
      </ul>
    </div>
  );
}

export function CharterCard({ charter }: { charter: Doc<'charters'> }) {
  const approve = useMutation(api.charters.approve);
  const requestChanges = useMutation(api.charters.requestChanges);
  const setConstraintStruck = useMutation(api.charters.setConstraintStruck);
  const amend = useMutation(api.charters.amend);
  const postApproval = useAction(api.onboarding.postCharterApproval);
  const [posting, setPosting] = useState(false);
  const [amendError, setAmendError] = useState<string | null>(null);
  const [strikeError, setStrikeError] = useState<string | null>(null);
  const body = charter.body as CharterCardBody;
  const constraints = body.constraints ?? [];
  const struckCount = constraints.filter((constraint) => constraint.struck).length;

  async function toggleStrike(index: number, struck: boolean): Promise<void> {
    setStrikeError(null);
    const result = await setConstraintStruck({ charterId: charter._id, index, struck });
    if (!result.ok) setStrikeError(result.reason);
  }

  async function sendAmendment(change: CharterChange): Promise<boolean> {
    setAmendError(null);
    try {
      await amend({ agentId: charter.agentId, changes: [change] });
      return true;
    } catch (error) {
      setAmendError((error as Error).message ?? 'The amendment was refused.');
      return false;
    }
  }

  async function onApprove() {
    setPosting(true);
    setStrikeError(null);
    const result = await approve({ charterId: charter._id });
    if (!result.ok) {
      setStrikeError(result.reason);
      setPosting(false);
      return;
    }
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
            <BoundaryList label="Open questions" items={managerOpenQuestions(body)} />
          </div>
        </details>
        <ConstraintList
          constraints={constraints}
          approved={charter.approved}
          onStrike={(index) =>
            charter.approved
              ? void sendAmendment({ kind: 'strike-constraint', index })
              : void toggleStrike(index, true)
          }
          onRestore={charter.approved ? undefined : (index) => void toggleStrike(index, false)}
          previewStrike={(index) => strikePreview(body, index)}
        />
        {strikeError ? <p className="text-xs text-[var(--color-danger)]">{strikeError}</p> : null}
        <SynthesisNotes notes={synthesisNotes(body)} />
        {charter.approved ? (
          <AmendCharterPanel
            charter={charter}
            body={body}
            error={amendError}
            onAmend={sendAmendment}
          />
        ) : null}
        {!charter.approved ? (
          <div className="flex gap-2 pt-1">
            <button
              onClick={onApprove}
              disabled={posting}
              className="px-4 py-2 rounded-lg bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-sm font-medium disabled:opacity-50"
            >
              {struckCount > 0
                ? `Approve, ${struckCount} ${struckCount === 1 ? 'rule' : 'rules'} struck`
                : 'Approve'}
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

const CLAUSE_LIST_LABEL: Record<ListClauseField, string> = {
  willDo: 'Will do',
  willNotDo: 'Will NOT do',
  escalationTriggers: 'Escalation triggers',
};

const AMEND_INPUT =
  'flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 py-1 text-xs text-[var(--color-fg)]';
const AMEND_BUTTON =
  'shrink-0 px-2 py-1 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50';

/**
 * One line of text the manager can rewrite or remove; Save sends the
 * amendment. Callers key it by the text, so a new version remounts it with
 * the new text rather than syncing state from props.
 */
function EditableLine({
  text,
  onSave,
  onRemove,
}: {
  text: string;
  onSave: (text: string) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const changed = draft.trim() !== text.trim();
  return (
    <div className="flex items-center gap-1">
      <input className={AMEND_INPUT} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <button className={AMEND_BUTTON} disabled={!changed || !draft.trim()} onClick={() => onSave(draft)}>
        Save
      </button>
      {onRemove ? (
        <button className={AMEND_BUTTON} onClick={onRemove}>
          Remove
        </button>
      ) : null}
    </div>
  );
}

/** A single input with a button, cleared when the submission is accepted. */
function AddLine({
  placeholder,
  label,
  onAdd,
}: {
  placeholder: string;
  label: string;
  onAdd: (text: string) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  return (
    <div className="flex items-center gap-1">
      <input
        className={AMEND_INPUT}
        placeholder={placeholder}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        className={AMEND_BUTTON}
        disabled={!draft.trim()}
        onClick={async () => {
          if (await onAdd(draft)) setDraft('');
        }}
      >
        {label}
      </button>
    </div>
  );
}

/**
 * Amend an approved charter from the card: each Save, Answer, Add or Remove
 * is one typed change and one new version. The list of versions below the
 * editors is the charter's history; nothing here edits a row in place.
 */
export function AmendCharterPanel({
  charter,
  body,
  error,
  onAmend,
}: {
  charter: Doc<'charters'>;
  body: CharterCardBody;
  error: string | null;
  onAmend: (change: CharterChange) => Promise<boolean>;
}) {
  const versions = useQuery(api.charters.listForAgent, { agentId: charter.agentId });
  const now = useNow();
  const [rule, setRule] = useState<{ quote: string; kind: CharterConstraint['kind']; clause: ListClauseField }>({
    quote: '',
    kind: 'candidate-property',
    clause: 'willDo',
  });
  const [system, setSystem] = useState<{ name: string; class: SystemClass; whereMentioned: string }>({
    name: '',
    class: 'other',
    whereMentioned: '',
  });
  const answered = body.answeredQuestions ?? [];
  const openQuestions = managerOpenQuestions(body);
  return (
    <details className="text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        Amend this charter · next version v{nextCharterVersion(charter.version)}
      </summary>
      <div className="mt-2 space-y-3 pl-3 border-l border-[var(--color-border)]">
        {error ? <p className="text-[var(--color-warn)]">{error}</p> : null}
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Proposed function</div>
          <EditableLine
            key={body.proposedFunction}
            text={body.proposedFunction}
            onSave={(text) => void onAmend({ kind: 'edit-function', text })}
          />
        </div>
        {LIST_CLAUSE_FIELDS.map((field) => (
          <div key={field}>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              {CLAUSE_LIST_LABEL[field]}
            </div>
            <div className="space-y-1">
              {body.proposedBoundaries[field].map((item, index) => (
                <EditableLine
                  key={`${index}:${item}`}
                  text={item}
                  onSave={(text) => void onAmend({ kind: 'edit-clause', field, index, text })}
                  onRemove={() => void onAmend({ kind: 'edit-clause', field, index, text: '' })}
                />
              ))}
              <AddLine
                placeholder={`Add to ${CLAUSE_LIST_LABEL[field].toLowerCase()}`}
                label="Add"
                onAdd={(text) =>
                  onAmend({ kind: 'edit-clause', field, index: body.proposedBoundaries[field].length, text })
                }
              />
            </div>
          </div>
        ))}
        {openQuestions.length > 0 || answered.length > 0 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Open questions</div>
            <div className="space-y-1.5">
              {openQuestions.map((question) => (
                <div key={question}>
                  <p className="text-[var(--color-fg)] mb-0.5">{question}</p>
                  <AddLine
                    placeholder="Your answer"
                    label="Answer"
                    onAdd={(answer) => onAmend({ kind: 'answer-question', question, answer })}
                  />
                </div>
              ))}
              {answered.map((entry) => (
                <p key={entry.question} className="text-[var(--color-muted)]">
                  {entry.question} <span className="text-[var(--color-fg)]">— {entry.answer}</span>
                </p>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Add a rule</div>
          <div className="flex flex-wrap items-center gap-1">
            <input
              className={AMEND_INPUT}
              placeholder="In your own words"
              value={rule.quote}
              onChange={(e) => setRule({ ...rule, quote: e.target.value })}
            />
            <select
              className={AMEND_INPUT}
              value={rule.kind}
              onChange={(e) => setRule({ ...rule, kind: e.target.value as CharterConstraint['kind'] })}
            >
              <option value="candidate-property">what work qualifies</option>
              <option value="system-boundary">where I may act</option>
              <option value="reporting-line">who I report to</option>
            </select>
            <select
              className={AMEND_INPUT}
              value={rule.clause}
              onChange={(e) => setRule({ ...rule, clause: e.target.value as ListClauseField })}
            >
              {LIST_CLAUSE_FIELDS.map((field) => (
                <option key={field} value={field}>
                  under {CLAUSE_LIST_LABEL[field].toLowerCase()}
                </option>
              ))}
            </select>
            <button
              className={AMEND_BUTTON}
              disabled={!rule.quote.trim()}
              onClick={async () => {
                if (
                  await onAmend({
                    kind: 'add-constraint',
                    constraint: { kind: rule.kind, quote: rule.quote, clause: rule.clause },
                  })
                ) {
                  setRule({ ...rule, quote: '' });
                }
              }}
            >
              Add rule
            </button>
          </div>
        </div>
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Systems named</div>
          <div className="space-y-1">
            {(body.namedSystems ?? []).map((named) => (
              <div key={named.name} className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-[var(--color-fg)]">
                  {named.name} ({named.class})
                </span>
                <button
                  className={AMEND_BUTTON}
                  onClick={() => void onAmend({ kind: 'remove-system', name: named.name })}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1">
              <input
                className={AMEND_INPUT}
                placeholder="System name"
                value={system.name}
                onChange={(e) => setSystem({ ...system, name: e.target.value })}
              />
              <select
                className={AMEND_INPUT}
                value={system.class}
                onChange={(e) => setSystem({ ...system, class: e.target.value as SystemClass })}
              >
                {SYSTEM_CLASSES.map((systemClass) => (
                  <option key={systemClass} value={systemClass}>
                    {systemClass}
                  </option>
                ))}
              </select>
              <input
                className={AMEND_INPUT}
                placeholder="Where it is used, in your words"
                value={system.whereMentioned}
                onChange={(e) => setSystem({ ...system, whereMentioned: e.target.value })}
              />
              <button
                className={AMEND_BUTTON}
                disabled={!system.name.trim() || !system.whereMentioned.trim()}
                onClick={async () => {
                  if (await onAmend({ kind: 'add-system', system })) {
                    setSystem({ name: '', class: 'other', whereMentioned: '' });
                  }
                }}
              >
                Add system
              </button>
            </div>
          </div>
        </div>
        {versions && versions.length > 1 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Versions</div>
            <ul className="space-y-0.5 text-[var(--color-muted)]">
              {versions.map((row) => (
                <li key={row._id}>
                  v{row.version}
                  {row._id === charter._id ? ' · current' : ''}
                  {row.supersedes ? ' · amendment' : ' · from the 1:1'}
                  {' · '}
                  <span title={clockTimeWithSeconds(row.createdAt)}>{relativeTime(row.createdAt, now)}</span>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </details>
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

/**
 * What the synthesis said about its own drafting, under the rules. Read-only:
 * a note is not a question for the manager and offers no answer box.
 */
function SynthesisNotes({ notes }: { notes: string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="text-xs">
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">Notes from drafting</div>
      <ul className="space-y-0.5">
        {notes.map((note) => (
          <li key={note} className="text-[var(--color-muted)]">
            – {note}
          </li>
        ))}
      </ul>
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

/**
 * Whether Retry on this row verifies the draft it already has rather than
 * authoring a new one.
 *
 * A skill parked because the sandbox was busy or unavailable keeps the body
 * and smoke test that were authored and passed the static gate, so its retry
 * runs the check on them with no second model call. The condition is the one
 * `convex/skillActions.ts` acts on, so the button says what the backend will
 * do; every other row - a refusal, a smoke test the sandbox turned down, a run
 * that stopped before its draft was saved - has no draft to verify.
 *
 * Args:
 *   skill: The unregistered skill row the panel is listing.
 *
 * Returns:
 *   True when Retry verifies the saved draft without authoring again.
 */
export function retryVerifiesSavedDraft(
  skill: Pick<Doc<'skills'>, 'state' | 'body' | 'pendingSmokeTest'>,
): boolean {
  return skill.state === 'authoring' && Boolean(skill.body) && Boolean(skill.pendingSmokeTest);
}

export function RegisteredSkillsPanel({
  skills,
  unregistered,
  authoringFailure,
  onAuthoringAttempt,
  surfaceMode,
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
  /** Real mode lists the inputs the executor binds for a skill that predates them. */
  surfaceMode?: 'mock' | 'real';
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
              <div className="flex-1 min-w-0">
                <div className="font-medium text-[var(--color-fg)] break-words">{s.name}</div>
                <div className="text-[var(--color-muted)] text-xs break-words">{s.description}</div>
                {s.sourceType === 'agent-authored' ? <SkillInputs body={s.body} surfaceMode={surfaceMode} /> : null}
              </div>
              {s.sourceType === 'agent-authored' ? (
                <button
                  onClick={() => onRevise(s._id, s.name)}
                  disabled={retrying === s._id}
                  title="Discard this body and author the skill again, then verify it - open only before its first execution"
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
                  {/* A traceback's caret line has no break opportunity: without
                      min-w-0 the column keeps its full width and pushes Retry
                      past the card's edge. */}
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-[var(--color-fg)] break-words">{s.name}</div>
                    {/* Three different things, and the row used to say the
                        first for two of them: a run working on it now, whose
                        log is the previous attempt's; a run that died holding
                        it, which the lease has since released; and no run at
                        all, where the log is this skill's own verdict. */}
                    <SkillStatusLine
                      text={
                        holdsLiveAuthoringClaim(s, now)
                          ? 'authoring now · a run holds this skill'
                          : s.authoringRunId
                            ? 'a run stopped without reporting · Retry takes the skill over'
                            : (s.verificationLog ?? s.description)
                      }
                    />
                    <SkillInputs body={s.body || s.refusedBody || ''} />
                    <RefusedDraftDetails skill={s} />
                  </div>
                  <button
                    onClick={() => onRetry(s._id, s.name)}
                    disabled={retrying === s._id}
                    title={
                      retryVerifiesSavedDraft(s)
                        ? 'Run the body and smoke test this skill already has through the sandbox check - no new authoring call'
                        : 'Author this skill again, with the reason it stopped, then verify it'
                    }
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
              is what tells a reader which line is theirs. And a retry costs an
              authoring call for some of these rows and none for others, which
              is the difference between waiting on a sandbox and waiting on the
              model, so the text says which is which rather than claiming one
              for all of them. */}
          <p className="text-[10px] text-[var(--color-muted)] mt-2">
            Retry picks a skill up where it stopped. One parked because the check never ran - the
            sandbox was busy, absent, or threw - keeps its body and smoke test and is checked again
            as it stands, with no second authoring call; one the gate or the check itself turned
            down is authored again, with the reason fed back. Either way it has to pass the check
            before it is callable. If the sandbox was skipped, start one first: run pnpm sandbox:up
            for the bundled local sandbox, or set DAYTONA_API_KEY on the deployment to use Daytona
            instead. Only one authoring run holds a skill at a time, so a retry while one is still
            running is refused until that run finishes or its claim lapses.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * What an unregistered skill's row says under its name.
 *
 * A one-line reason stays prose. A sandbox's log keeps its line breaks, in a
 * box bounded in height that scrolls: a traceback collapsed into one run of
 * text cannot be read, and one left unbounded makes the card as tall as the
 * traceback. `break-words` still wraps a caret line, so Retry stays inside.
 */
function SkillStatusLine({ text }: { text: string }) {
  if (!text.includes('\n')) {
    return <div className="text-[var(--color-muted)] text-xs break-words">{text}</div>;
  }
  return (
    <div
      className="mt-0.5 text-[var(--color-muted)] text-[11px] leading-snug font-mono whitespace-pre-wrap break-words max-h-40 overflow-y-auto rounded border border-[var(--color-border)] bg-[var(--color-bg)] p-2"
      data-skill-log="multiline"
    >
      {text}
    </div>
  );
}

/**
 * The inputs an authored skill declares, with the ones the system declared
 * for its author marked.
 *
 * The manager approves a skill before its body exists, so this row is the
 * first place the inputs can be shown. An input the author used without
 * declaring is declared for it in real mode; the body marks that line, and
 * this says so beside the name rather than letting it pass as the author's.
 * In real mode the executor also binds the reply surface for a skill that was
 * registered before that input was taught; it is listed last, marked as
 * bound by Day0, so the line shows every input a run is given. Only a
 * registered skill is given the mode: an attempt that never registered runs
 * nothing, and Retry authors it again under the taught lines.
 */
function SkillInputs({ body, surfaceMode }: { body: string; surfaceMode?: 'mock' | 'real' }) {
  const authored = declaredSkillInputs(body) ?? [];
  if (authored.length === 0) return null;
  const bound = new Set(surfaceMode === 'real' ? impliedSkillInputs(body) : []);
  const declared = [...authored, ...bound];
  const added = new Set(systemDeclaredInputs(body));
  const plural = added.size > 1;
  return (
    <div className="mt-1 text-[10px] text-[var(--color-muted)] break-words">
      <span className="uppercase tracking-wider">inputs</span>{' '}
      {declared.map((name, index) => (
        <span key={name}>
          {index > 0 ? ', ' : ''}
          <code className="font-mono whitespace-nowrap">&lt;{name}&gt;</code>
          {added.has(name) ? ' (added by Day0)' : ''}
          {bound.has(name) ? ' (bound by Day0)' : ''}
        </span>
      ))}
      {added.size > 0 ? (
        <span>
          {' '}
          · The author used the input{plural ? 's' : ''} marked &quot;added by Day0&quot; without declaring{' '}
          {plural ? 'them' : 'it'}, so Day0 declared {plural ? 'them' : 'it'}: the executor reads{' '}
          {plural ? 'them' : 'it'} from the candidate or its runbook at run time.
        </span>
      ) : null}
      {bound.size > 0 ? (
        <span>
          {' '}
          · This skill was registered before Day0 taught the input marked &quot;bound by Day0&quot;: the executor binds
          it from the Reply target, so the reply goes to the chat surface the ask came from.
        </span>
      ) : null}
    </div>
  );
}

/**
 * The draft a refusal turned away before any sandbox ran, behind a disclosure
 * under the failed skill. Read-only: the row keeps it so the manager can see
 * what was refused against the reason above it, and Retry hands it back to the
 * author to correct. Nothing here was registered or checked.
 */
export function RefusedDraftDetails({
  skill,
}: {
  skill: Pick<Doc<'skills'>, 'refusedBody' | 'refusedSmokeTest'>;
}) {
  const body = skill.refusedBody?.trim() ?? '';
  const smokeTest = skill.refusedSmokeTest?.trim() ?? '';
  if (!body && !smokeTest) return null;
  const files = [
    { name: 'SKILL.md', content: body },
    { name: 'smoke.py', content: smokeTest },
  ].filter((file) => file.content);
  return (
    <details className="mt-1 text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        Refused draft · {files.map((file) => file.name).join(' and ')} · not registered
      </summary>
      <div className="mt-1 space-y-1">
        {files.map((file) => (
          <div key={file.name}>
            <div className="font-mono text-[10px] text-[var(--color-muted)]">{file.name}</div>
            <pre className="text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]">
              {file.content}
            </pre>
          </div>
        ))}
      </div>
    </details>
  );
}

/**
 * What the queue says after "Check for new work".
 *
 * Args:
 *   result: The check's answer: surfaces scheduled for a poll, and the wait
 *     before the next check when one ran under a minute ago.
 *
 * Returns:
 *   One line for the manager.
 */
export function checkForWorkMessage(result: { scheduled: number; retryInMs?: number }): string {
  if (result.scheduled > 0) {
    const surfaces = result.scheduled === 1 ? 'surface' : 'surfaces';
    return `Checking ${result.scheduled} connected ${surfaces} now; anything new appears here within a minute.`;
  }
  if (result.retryInMs !== undefined) {
    return `Checked under a minute ago; try again in ${Math.ceil(result.retryInMs / 1000)} s.`;
  }
  return 'No connected work surface to check.';
}

/** Poll the employee's connected work surfaces now rather than at the next five-minute sweep. */
function CheckForNewWork({ agentId }: { agentId: Id<'agents'> }) {
  const check = useMutation(api.workLoop.checkForNewWork);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="mb-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[10px] text-[var(--color-muted)]">
          Connected surfaces are polled every five minutes.
        </p>
        <button
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            check({ agentId })
              .then((result) => setMessage(checkForWorkMessage(result)))
              .catch((err: unknown) => setError((err as Error).message))
              .finally(() => setBusy(false));
          }}
          className="shrink-0 px-2 py-1 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? 'Checking…' : 'Check for new work'}
        </button>
      </div>
      {message ? <p className="mt-1 text-[10px] text-[var(--color-muted)]">{message}</p> : null}
      {error ? <p className="mt-1 text-[10px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
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

export function WorkQueue({
  agentId,
  workItems,
  openQuestions,
  surfaces,
  registeredSkillCount,
  charterApproved,
  autonomousActions,
  surfaceMode,
  corrections = [],
  autonomyChanges = [],
}: {
  agentId: Id<'agents'>;
  workItems: Doc<'workItems'>[];
  /** The charter's open questions still waiting on the manager, asked at a plan. */
  openQuestions: Doc<'managerQuestions'>[];
  surfaces: SurfaceRecord[];
  registeredSkillCount: number;
  charterApproved: boolean;
  /** Whether the agent's autonomous-actions switch is on, for the cards' wording. */
  autonomousActions: boolean;
  /** The deployment's surface mode, undefined while it loads. Only mock mode drives the loop from here. */
  surfaceMode: 'mock' | 'real' | undefined;
  /** The employee's kept corrections, for the plan cards that applied one. */
  corrections?: KeptCorrection[];
  /** The employee's flips of the autonomous-actions switch, oldest first. */
  autonomyChanges?: readonly AutonomyChange[];
}) {
  const evaluate = useAction(api.workActions.evaluateWorkItem);
  const draftPlan = useAction(api.workActions.draftPlan);
  const executePlan = useAction(api.workActions.executeApprovedPlan);
  const approvePlan = useMutation(api.work.approvePlan);
  const cancelPlan = useMutation(api.work.cancelPlan);
  const retryFailed = useMutation(api.work.retryFailed);
  const reconcileFailed = useMutation(api.work.reconcileFailed);
  const approveActions = useMutation(api.work.approveActions);
  const approveActionsBatch = useMutation(api.work.approveActionsBatch);
  const rejectActions = useMutation(api.work.rejectActions);
  const resendDecision = useMutation(api.work.resendDecisionRequest);

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

  // Auto-progression, mock mode only: once charter is approved, evaluate every
  // discovered item; once a verdict comes back, draft a plan if claim, etc.
  // The hosted demo and the frozen harness rely on it. In real mode the server
  // schedules every step (`convex/workLoop.ts`), so the work moves with no
  // page open, and this page only renders and sends the manager's decisions.
  const drivesLoop = surfaceMode === 'mock';
  useEffect(() => {
    if (!drivesLoop || !charterApproved) return;
    const next = nextItemToEvaluate(workItems);
    if (next) once('evaluate', next._id, () => evaluate({ workItemId: next._id }));
  }, [drivesLoop, charterApproved, workItems, evaluate, once]);

  useEffect(() => {
    if (!drivesLoop) return;
    for (const it of workItems) {
      if (it.state === 'claimed' && !it.plan) {
        once('draft', it._id, () => draftPlan({ workItemId: it._id }));
      }
      if (it.state === 'plan-approved') {
        once('execute', it._id, () => executePlan({ workItemId: it._id }));
      }
    }
  }, [drivesLoop, workItems, draftPlan, executePlan, once]);

  return (
    <Card
      title={
        `Work queue · ${items.length} ${items.length === 1 ? 'item' : 'items'} · ` +
        `${registeredSkillCount} ${registeredSkillCount === 1 ? 'skill' : 'skills'} available`
      }
    >
      {surfaceMode === 'real' && charterApproved ? <CheckForNewWork agentId={agentId} /> : null}
      {items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {charterApproved
            ? 'no work seeded yet'
            : 'work queue lights up after charter approval'}
        </p>
      ) : (
        <div className="space-y-3">
          <PendingDecisionsPanel
            members={pendingDecisionMembers(items)}
            surfaces={surfaces}
            onApproveBatch={(members) => approveActionsBatch({ members })}
          />
          {items.map((item) => (
            <WorkItemCard
              key={item._id}
              item={item}
              surfaces={surfaces}
              autonomousActions={autonomousActions}
              questions={openQuestions.filter((question) => question.workItemId === item._id)}
              corrections={corrections}
              autonomyChanges={autonomyChanges}
              onApprovePlan={(decision) => approvePlan(planApprovalRequest(item._id, decision))}
              onCancelPlan={(reason) => cancelPlan(cancelPlanRequest(item._id, reason))}
              onRetryFailed={(feedback) => retryFailed(retryRequest(item._id, feedback))}
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
              onResendDecision={() => resendDecision({ workItemId: item._id })}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function stateColor(state: string): string {
  if (state === 'completed') return 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]';
  if (state === 'stopped') return 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]';
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
  redaction?: 'structural-only';
  /** The first attempt at this row's arguments, when one bounded repair re-authored them. */
  repair?: { reason: string; toolArgsJson: string };
  /** The run's sign-in, replayed in this invocation's new browser before the row was sent. */
  sessionRestore?: SessionRestoreRow;
}

/** A re-established browser session as the card reads it: one row per replayed call. */
interface SessionRestoreRow {
  steps: Array<{
    ok: boolean;
    reason?: string;
    replayOf?: string;
    action?: MockAction;
  }>;
}

interface PlanStepOutcomeRow {
  step: number;
  status: 'satisfied' | 'blocked' | 'not-verifiable';
  evidence: string;
  basis?: 'manager-feedback';
}

/** A run's persisted output as the card reads it, in either of its two phases. */
interface RunOutput {
  draft: string;
  notes: string;
  actions?: MockAction[];
  applied?: LedgerRow[];
  initial?: { applied?: LedgerRow[]; withheldActions?: WithheldActionRow[] };
  planStepOutcomes?: PlanStepOutcomeRow[];
  /** The one repair each held write earned before the hold, by action index. */
  argumentRepairs?: ArgumentRepairAttempt[];
  /** The closing set a gate refused before anything in it reached a surface, with the reason. */
  refusedClosing?: RefusedClosingRow;
  /** Actions an audit withheld after its one repair, never sent, with the reason. */
  withheldActions?: WithheldActionRow[];
}

interface WithheldActionRow {
  action: MockAction;
  reason: string;
}

interface RefusedClosingRow {
  actions: MockAction[];
  planStepOutcomes: PlanStepOutcomeRow[];
  draft: string;
  notes: string;
  reason: string;
  at: number;
  /** Actions the evidence check withheld from the set before the gate refused it. */
  withheldActions?: WithheldActionRow[];
}

/**
 * The note beside a held or applied row whose arguments were re-authored once:
 * why the first attempt was refused and what it was, so the manager judges the
 * payload in front of them knowing it is the second.
 */
export function RepairNote({
  repair,
}: {
  repair: { reason: string; toolArgsJson: string; repaired?: boolean } | undefined;
}) {
  if (!repair) return null;
  const stands = repair.repaired === false;
  return (
    <details className="mt-0.5">
      <summary className="text-[10px] text-[var(--color-warn)] cursor-pointer select-none">
        {stands
          ? 'argument names refused by the probed schema · the one repair produced nothing usable · first attempt stands'
          : 'arguments re-authored once before the hold · this payload is the second attempt'}
      </summary>
      <p className="text-[10px] text-[var(--color-muted)] break-words">{repair.reason}</p>
      <code className="block font-mono text-[10px] whitespace-pre-wrap break-words text-[var(--color-muted)]">
        first attempt: {repair.toolArgsJson}
      </code>
    </details>
  );
}

const REPLAYED_CALL_WORDS: Record<string, string> = {
  browser_navigate: 'navigate',
  browser_fill_form: 'fill',
  browser_click: 'click',
};

/** "row 3", "rows 0 to 2" or "rows 0, 2 and 5", from ledger keys ending in their index. */
function replayedRows(keys: readonly string[]): string | undefined {
  const indexes = keys
    .map((key: string): number => Number(key.split(':')[2]))
    .filter((index: number): boolean => Number.isInteger(index));
  if (indexes.length === 0) return undefined;
  if (indexes.length === 1) return `row ${indexes[0]}`;
  const contiguous = indexes.every(
    (index: number, position: number): boolean => position === 0 || index === indexes[position - 1]! + 1,
  );
  if (contiguous) return `rows ${indexes[0]} to ${indexes.at(-1)}`;
  return `rows ${indexes.slice(0, -1).join(', ')} and ${indexes.at(-1)}`;
}

/**
 * The note beside a row whose invocation had to sign a new browser in again
 * before sending it: which of the run's own landed calls were replayed, and
 * where the replay stopped when it did. The replayed calls are transport
 * calls of their own, each with its key, so the manager can see them.
 */
export function SessionRestoreNote({ restore }: { restore: SessionRestoreRow | undefined }) {
  if (!restore || restore.steps.length === 0) return null;
  const verbs = restore.steps.map((step): string => {
    const tool = String(step.action?.args.tool ?? '');
    return REPLAYED_CALL_WORDS[tool] ?? (tool || 'call');
  });
  const replayOf = restore.steps.flatMap((step): string[] => (step.replayOf ? [step.replayOf] : []));
  const rows = replayedRows(replayOf);
  const opened = restore.steps.some((step) => !step.replayOf);
  const source = rows
    ? opened
      ? ` (the surface's own page, then replays of ${rows})`
      : ` (replays of ${rows})`
    : " (the surface's own page)";
  const failed = restore.steps.find((step) => !step.ok);
  const signsIn = verbs.includes('fill');
  const replayed = signsIn ? 'navigate and sign-in' : 'navigate';
  const lead = failed
    ? signsIn
      ? 'could not sign in again first'
      : 'could not open the page again first'
    : signsIn
      ? 'signed in again first'
      : 'opened the page again first';
  return (
    <details className="mt-0.5">
      <summary
        className={`text-[10px] cursor-pointer select-none ${
          failed ? 'text-[var(--color-warn)]' : 'text-[var(--color-muted)]'
        }`}
      >
        {lead}: {verbs.join(', ')}
        {source}
      </summary>
      <p className="text-[10px] text-[var(--color-muted)] break-words">
        {failed
          ? `A new browser opens for every apply of a run, so Day0 tried the run's own landed ${replayed} again before this row and stopped: this row and the rest on the surface were not sent.`
          : `A new browser opens for every apply of a run. Day0 sent the page restoration calls shown above before this row; this row's action was not replayed.`}
      </p>
      {failed ? (
        <p className="text-[10px] text-[var(--color-warn)] break-words">
          stopped at {REPLAYED_CALL_WORDS[String(failed.action?.args.tool ?? '')] ?? 'a call'}:{' '}
          {failed.reason ?? 'the call did not land'}
        </p>
      ) : null}
    </details>
  );
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
/**
 * The manager's written word on the item, in every state.
 *
 * A rejection reason or a retry note is the direction the next run reads,
 * and the record of why the item went the way it did; it is shown whether
 * the item is failed, running, held or finished, and says when a run
 * completed with it.
 */
export function ManagerFeedbackNote({ feedback }: { feedback: ManagerFeedback }) {
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30 text-xs">
      <p className="text-[var(--color-accent)] font-medium mb-0.5">
        {managerFeedbackLabel(feedback)}
        <span className="ml-1 font-normal text-[10px] text-[var(--color-muted)]" title={clockTimeWithSeconds(feedback.at)}>
          {clockTimeWithSeconds(feedback.at)}
        </span>
      </p>
      <p className="text-[var(--color-fg)] whitespace-pre-wrap break-words">{feedback.reason}</p>
      {feedback.addressedAt !== undefined ? (
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          addressed by the run that completed {clockTimeWithSeconds(feedback.addressedAt)}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The steps a refused closing phase recorded as blocked or not verifiable,
 * in the open beside the gate's reason. The card's headline is the gate's
 * sentence; when the employee stopped for a reason of their own (no answer
 * from the manager yet, a prerequisite that did not land), that reason is
 * theirs to give and the manager's to read without opening the refused set.
 */
export function RefusedBlockedSteps({ refused }: { refused: RefusedClosingRow | undefined }) {
  const blocked = (refused?.planStepOutcomes ?? []).filter((outcome) => outcome.status !== 'satisfied');
  if (blocked.length === 0) return null;
  const unverified = blocked.some((outcome) => outcome.status === 'not-verifiable');
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
      <p className="font-medium text-[var(--color-fg)] mb-1">
        The employee recorded {blocked.length} {blocked.length === 1 ? 'step' : 'steps'} as blocked
        {unverified ? ' or not verifiable' : ''}
      </p>
      <ol className="space-y-0.5 text-[var(--color-muted)] break-words">
        {blocked.map((outcome) => (
          <li key={outcome.step}>{`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}</li>
        ))}
      </ol>
    </div>
  );
}

/**
 * The closing set a gate refused, behind a disclosure under the failed run.
 * Read-only: nothing in it reached a surface, the row keeps it so the
 * manager can read what the agent wrote against the reason it was turned
 * away, and Retry hands it back to the closing phase to correct from the
 * same ledger.
 */
export function RefusedClosingDetails({ refused }: { refused: RefusedClosingRow | undefined }) {
  if (!refused || refused.actions.length === 0) return null;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        Refused closing set · {refused.actions.length}{' '}
        {refused.actions.length === 1 ? 'action' : 'actions'} · never sent
      </summary>
      <p className="mt-1 text-[10px] text-[var(--color-warn)] break-words">{refused.reason}</p>
      <ul className="mt-1 space-y-1">
        {refused.actions.map((action, index) => (
          <li key={index}>
            <span className="font-mono text-[10px] text-[var(--color-muted)]">
              {describeAction(action)}
            </span>
            <ActionPayload action={action} />
          </li>
        ))}
      </ul>
      {refused.planStepOutcomes.length > 0 ? (
        <ol className="mt-1 space-y-0.5 text-[10px] text-[var(--color-muted)]">
          {refused.planStepOutcomes.map((outcome) => (
            <li key={outcome.step}>
              {`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}
            </li>
          ))}
        </ol>
      ) : null}
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        As the closing phase accounted for the plan before the gate refused the set. Retry authors
        the closing set again from the same prerequisite ledger.
      </p>
    </details>
  );
}

/**
 * The actions an audit withheld after its one repair, behind a disclosure
 * under the run. Read-only: none of them reached a surface, the rest of the
 * response went on, and the row keeps each with the reason it was turned
 * away so the manager can read what the agent wrote against why.
 */
export function WithheldActionsDetails({ withheld }: { withheld: WithheldActionRow[] | undefined }) {
  if (!withheld || withheld.length === 0) return null;
  const waiting = withheld.filter((row) => isWithheldForAnswer(row.reason));
  if (waiting.length > 0 && waiting.length < withheld.length) {
    return (
      <>
        <WithheldActionsDetails withheld={waiting} />
        <WithheldActionsDetails withheld={withheld.filter((row) => !isWithheldForAnswer(row.reason))} />
      </>
    );
  }
  const forAnswer = waiting.length > 0;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        {forAnswer ? 'Waiting on your answer' : 'Withheld by the evidence check'} · {withheld.length}{' '}
        {withheld.length === 1 ? 'action' : 'actions'} · never sent
      </summary>
      <ul className="mt-1 space-y-1">
        {withheld.map((row, index) => (
          <li key={index}>
            <span className="font-mono text-[10px] text-[var(--color-muted)]">
              {describeAction(row.action)}
            </span>
            <p className="text-[10px] text-[var(--color-warn)] break-words">{row.reason}</p>
            <ActionPayload action={row.action} />
          </li>
        ))}
      </ul>
      <p className="mt-1 text-[10px] text-[var(--color-muted)]">
        {forAnswer
          ? 'The approved plan left these to your answer, so the question went out without them; Retry with a note answers it and the next run authors them from it.'
          : 'The rest of the response went on without these; a retry authors them again from the ledger.'}
      </p>
    </details>
  );
}

/** The plan's declared obligations as the card reads them; see `PlanObligations` in `src/work/types.ts`. */
interface PlanObligationsRow {
  steps: Array<{ kind: string; reads: string[]; writes: string[]; reason?: string }>;
  transition: string;
  transitionStep: number | null;
  basis: 'judgement' | 'planner';
  failedOpen?: string;
  reason?: string;
  plannerTransition?: string;
}

const TRANSITION_LABELS: Record<string, string> = {
  promised: 'moved by the plan',
  'conditional-on-evidence': 'moved when what the run reads shows the condition holds',
  'conditional-on-manager': 'moved only on your approval, held for you',
  withheld: 'left where it is',
  none: 'not mentioned',
};

/**
 * What a planner and judgement disagreement on the ticket state means for
 * the state change, as the exact-action gate applies it.
 *
 * Args:
 *   steps: The plan's steps, which the declared rows must line up with.
 *   obligations: The declared obligations carrying both readings.
 *
 * Returns:
 *   One sentence: held for the manager, not held, or not read at all.
 */
function disagreementOutcome(steps: string[], obligations: PlanObligationsRow): string {
  const plan = { steps, obligations: obligations as unknown as PlanObligations };
  if (!planObligations(plan)) {
    return 'These obligations no longer line up with the plan\'s steps, so the gates read neither and hold nothing on their account.';
  }
  return transitionWithheld(plan)
    ? 'One of the two readings leaves the state change to you, so a state change the run makes is held for your decision whatever the autonomy switch says; a retry note from you that names the state is that decision.'
    : 'Neither reading leaves the state change to you, so it is not held on that account: the run follows the judgement\'s reading, and a state change it makes goes through the autonomy switch like any other write.';
}

/**
 * What the approved plan declares it owes, beside its steps: the reads the
 * closing gate will verify against the ledger and the plan's word on the
 * ticket state. Read-only, real mode only (a mock plan declares nothing).
 * When the judgement could not be reached the line says so, because the
 * gates then verify nothing about reads or the ticket state for this plan.
 * When the planner and the judgement disagreed on the ticket state, whether
 * the change is held is read from `transitionWithheld`, the gate's own test,
 * so the card never claims a hold the gate does not apply.
 */
export function PlanObligationsLine({
  steps,
  obligations,
  failedOpen,
}: {
  steps: string[];
  obligations: PlanObligationsRow | undefined;
  failedOpen: string | undefined;
}) {
  if (!obligations) {
    if (!failedOpen) return null;
    return (
      <p className="mt-2 text-[10px] text-[var(--color-warn)]">
        Obligations not settled: {failedOpen}. The closing gates verify no read or ticket state change for
        this plan; the closing phase still authors from the ledger.
      </p>
    );
  }
  const reads = obligations.steps.flatMap((step, index) =>
    step.reads.length > 0 ? [`step ${index + 1} reads ${step.reads.join(', ')}`] : [],
  );
  const transition = TRANSITION_LABELS[obligations.transition] ?? obligations.transition;
  const step = obligations.transitionStep !== null ? ` (step ${obligations.transitionStep})` : '';
  return (
    <div className="mt-2 text-[10px] text-[var(--color-muted)]">
      <p>
        <span className="uppercase tracking-wider">Declared obligations</span>
        {obligations.basis === 'judgement' ? ' · judged' : ' · the planner\'s own, unchecked'}
        {' · '}
        ticket state {transition}
        {step}
        {reads.length > 0 ? ` · ${reads.join('; ')}` : ' · no reads declared'}
      </p>
      {obligations.plannerTransition ? (
        <p className="text-[var(--color-warn)]">
          The planner declared the ticket state {TRANSITION_LABELS[obligations.plannerTransition] ?? obligations.plannerTransition};
          the judgement read it as {transition}. {disagreementOutcome(steps, obligations)}
        </p>
      ) : null}
      {obligations.failedOpen ? (
        <p className="text-[var(--color-warn)]">
          The obligations judgement could not be reached ({obligations.failedOpen}); the planner&apos;s declaration stands unchecked.
        </p>
      ) : null}
    </div>
  );
}

export function PlanExecutionLedger({ outcomes }: { outcomes: PlanStepOutcomeRow[] }) {
  if (outcomes.length === 0) return null;
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
      <p className="font-medium text-[var(--color-fg)] mb-1">Plan execution ledger</p>
      <ol className="space-y-0.5 text-[var(--color-muted)]">
        {outcomes.map((outcome) => (
          <li key={outcome.step}>
            {`Step ${outcome.step} · ${outcome.status}${
              outcome.basis === 'manager-feedback' ? ' by manager feedback' : ''
            } - ${outcome.evidence}`}
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

/**
 * The colleague a claim-refused skip names, for the card's link to them.
 *
 * Args:
 *   item: The work item's state and verdict.
 *
 * Returns:
 *   The holding employee, or undefined for any other row.
 */
export function colleagueHolding(
  item: Pick<Doc<'workItems'>, 'state' | 'verdict'>,
): { agentId: string; name: string } | undefined {
  if (item.state !== 'skipped') return undefined;
  const verdict = item.verdict as
    | { reason?: unknown; claimedBy?: { agentId?: unknown; name?: unknown } }
    | undefined;
  const holder = verdict?.claimedBy;
  if (typeof verdict?.reason !== 'string' || !verdict.reason.startsWith(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX)) {
    return undefined;
  }
  if (typeof holder?.agentId !== 'string' || typeof holder.name !== 'string') return undefined;
  return { agentId: holder.agentId, name: holder.name };
}

/** Show a manager's full rejection while keeping later failure reasons current. */
/** A ledger list row shows the short form of a long read result; the exact payload holds it whole. */
export function clipLedgerRow(text: string | undefined): string | undefined {
  if (text === undefined || text.length <= LEDGER_ROW_LENGTH) return text;
  return `${text.slice(0, LEDGER_ROW_LENGTH - 1)}…`;
}

const LEDGER_ROW_LENGTH = 180;

/**
 * The next item the queue evaluates on its own: the first discovered one.
 *
 * A retried item returns to `discovered`, so the manager's Retry reaches the
 * evaluator through this same pick.
 */
export function nextItemToEvaluate(items: readonly Doc<'workItems'>[]): Doc<'workItems'> | undefined {
  return items.find((item) => item.state === 'discovered');
}

/**
 * What the card's Retry sends: the item and, when the manager wrote one, the note.
 *
 * Args:
 *   workItemId: The item being retried.
 *   feedback: The retry note as typed; a blank note is not sent.
 *
 * Returns:
 *   The arguments for `work.retryFailed`.
 */
export function retryRequest(
  workItemId: Id<'workItems'>,
  feedback?: string,
): { workItemId: Id<'workItems'>; feedback?: string } {
  return { workItemId, ...(feedback?.trim() ? { feedback } : {}) };
}

/**
 * What the plan card's Cancel sends: the item and, when the manager wrote one, the reason.
 *
 * Args:
 *   workItemId: The item whose plan is cancelled.
 *   reason: The reason as typed; a blank reason is not sent.
 *
 * Returns:
 *   The arguments for `work.cancelPlan`.
 */
/** A retry note as typed, with the run it was typed for. */
export interface TypedRetryNote {
  text: string;
  token: string;
}

/**
 * What a typed retry note is tied to: the item's state and the manager's
 * last sent note. Sending a note moves both, so the box empties when the
 * Retry is taken rather than carrying the sent note onto the next card.
 *
 * Args:
 *   item: The work item row.
 *
 * Returns:
 *   A token that changes whenever a typed note stops being current.
 */
export function retryNoteToken(item: Pick<Doc<'workItems'>, 'state' | 'managerFeedback'>): string {
  return `${item.state}:${item.managerFeedback?.at ?? ''}`;
}

/**
 * The retry note that is still the manager's to send. A note left in the box
 * after its Retry made the finished card read as being sent back, which put
 * "Provider reconciliation required" under work that owed none (demo
 * rehearsal 2, Aiko's LOG-1).
 *
 * Args:
 *   typed: The note and the token it was typed under.
 *   token: The item's current token.
 *
 * Returns:
 *   The typed text while it is current, else the empty string.
 */
export function liveRetryNote(typed: TypedRetryNote, token: string): string {
  return typed.token === token ? typed.text : '';
}

export function cancelPlanRequest(
  workItemId: Id<'workItems'>,
  reason?: string,
): { workItemId: Id<'workItems'>; reason?: string } {
  return { workItemId, ...(reason?.trim() ? { reason } : {}) };
}

export function failedItemReason(item: {
  skipReason?: string;
  managerFeedback?: { reason: string };
  output?: { refusedClosing?: unknown; openQuestion?: unknown; initial?: { openQuestion?: unknown } | null } | null;
}): string | undefined {
  if (item.skipReason?.startsWith('rejected by the manager') && item.managerFeedback?.reason) {
    return `rejected by the manager: ${item.managerFeedback.reason}`;
  }
  if (item.skipReason && isGateRefusalStop(item.skipReason)) {
    // The gate refused a row before sending it and the rest of the run went
    // ahead, so work may have landed: the reason says what stands.
    return `stopped at a step Day0's gate refused: ${stopDetail(item.skipReason).slice(GATE_REFUSAL_STOP.length)}`;
  }
  if (item.skipReason && isStopped(item.skipReason)) {
    // A stop at the closing gate keeps the landed prerequisites and the
    // refused set on the row; Retry resumes at the closing phase.
    if (item.output?.refusedClosing) {
      return `stopped at the closing gate, the prerequisites landed and Retry resumes there: ${stopDetail(item.skipReason)}`;
    }
    // The run asked its question and withheld the writes that wait on the answer.
    return item.output?.openQuestion || item.output?.initial?.openQuestion
      ? `stopped with a question open for you, and the writes that wait on it were never sent; answer it with Retry with a note: ${stopDetail(item.skipReason)}`
      : `stopped, nothing landed and nothing to decide: ${stopDetail(item.skipReason)}`;
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
  repairs,
  onApprove,
  onReject,
}: {
  actions: MockAction[];
  verdicts: ActionVerdict[];
  surfaces: SurfaceRecord[];
  replyTarget?: ReplyTarget;
  /** Whether the agent's switch is on now; the card says why the rows are waiting either way. */
  autonomousActions?: boolean;
  /** The one repair each held write earned before the hold, by action index. */
  repairs?: ArgumentRepairAttempt[];
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
          {heldIndexes.every((index) => {
            const verdict = verdicts[index];
            return verdict?.disposition === 'held' && verdict.reason === HELD_WITHHELD_TRANSITION;
          })
            ? HELD_WITHHELD_TRANSITION_NOTE
            : autonomousActions
              ? HELD_BEFORE_AUTONOMY_NOTE
              : HELD_WHILE_SUPERVISED_NOTE}
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
                  <RepairNote repair={repairs?.find((attempt) => attempt.index === index)} />
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

/** What the manager decided with the plan: the answers given, and a note to the planner's own. */
export interface PlanApproval {
  answers: Array<{ questionId: Id<'managerQuestions'>; text: string }>;
  note?: string;
}

/**
 * What the approval form sends: the item, the answers given and the note.
 *
 * Args:
 *   workItemId: The plan-pending item.
 *   decision: The answers and note as the form collected them.
 *
 * Returns:
 *   The arguments for `work.approvePlan`; nothing optional is sent empty.
 */
export function planApprovalRequest(
  workItemId: Id<'workItems'>,
  decision: PlanApproval,
): { workItemId: Id<'workItems'>; answers?: PlanApproval['answers']; note?: string } {
  return {
    workItemId,
    ...(decision.answers.length > 0 ? { answers: decision.answers } : {}),
    ...(decision.note ? { note: decision.note } : {}),
  };
}

/**
 * The questions a pending plan raises and the manager's answers to them,
 * approved as one decision.
 *
 * The charter's open questions this plan touched come from their records;
 * the planner's own note (`riskNotes`) is shown and may be answered as free
 * text. Every answer reaches the run as approved evidence; a question left
 * blank is simply not answered and stays open.
 */
export function PlanApprovalForm({
  riskNotes,
  questions,
  onApprove,
  onCancel,
}: {
  riskNotes: string;
  questions: Doc<'managerQuestions'>[];
  onApprove: (decision: PlanApproval) => void;
  /** Cancels the plan with the manager's reason, empty when none was written. */
  onCancel: (reason: string) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const open = questions.filter((question) => !question.answer);
  const planNote = riskNotes.trim();
  function decision(): PlanApproval {
    return {
      answers: open.flatMap((question) => {
        const text = (answers[question._id] ?? '').trim();
        return text ? [{ questionId: question._id, text }] : [];
      }),
      ...(note.trim() ? { note: note.trim() } : {}),
    };
  }
  return (
    <div className="mt-2 space-y-2">
      {open.length > 0 ? (
        <div className="p-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {open.length === 1 ? 'A question for you before this plan runs' : `${open.length} questions for you before this plan runs`}
          </p>
          <ul className="space-y-1.5">
            {open.map((question) => (
              <li key={question._id}>
                <p className="text-[var(--color-fg)]">{question.question}</p>
                <p className="text-[10px] text-[var(--color-muted)]">
                  from the charter · touched by the {question.context.touchedBy}
                  {question.context.words.length > 0 ? `: ${question.context.words.join(', ')}` : ''}
                </p>
                <input
                  type="text"
                  value={answers[question._id] ?? ''}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question._id]: event.target.value }))
                  }
                  placeholder="your answer, written into the charter with the approval (optional)"
                  aria-label={`answer: ${question.question}`}
                  className="mt-0.5 w-full px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {planNote ? (
        <div className="p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-0.5">Planner&apos;s note</p>
          <p className="text-[var(--color-fg)]">{planNote}</p>
          <input
            type="text"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="your answer to the note, for this run (optional)"
            aria-label="answer to the planner's note"
            className="mt-1 w-full px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
          />
        </div>
      ) : null}
      <input
        type="text"
        value={cancelReason}
        onChange={(event) => setCancelReason(event.target.value)}
        placeholder="reason, if you cancel (optional)"
        aria-label="reason for cancelling the plan"
        className="w-full px-2 py-1 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
      />
      <div className="flex gap-2">
        <button
          onClick={() => onApprove(decision())}
          className="px-3 py-1 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs"
        >
          {open.length > 0 || planNote ? 'Approve plan with answers' : 'Approve plan'}
        </button>
        <button
          onClick={() => onCancel(cancelReason.trim())}
          className="px-3 py-1 rounded-md border border-[var(--color-border)] text-xs"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/** One member of the cross-item approval: the held rows of a parked run. */
export interface PendingDecisionMember {
  workItemId: Id<'workItems'>;
  pendingRunId: Id<'events'>;
  title: string;
  actions: MockAction[];
  heldIndexes: number[];
  refused: number;
}

/**
 * The held action sets open across the queue, read from each parked item.
 *
 * Args:
 *   items: The work items.
 *
 * Returns:
 *   One member per item whose run is parked with rows awaiting the manager.
 */
export function pendingDecisionMembers(items: readonly Doc<'workItems'>[]): PendingDecisionMember[] {
  return items.flatMap((item): PendingDecisionMember[] => {
    if (item.state !== 'actions-pending' || !item.pendingRunId || item.approvedIndexes !== undefined) {
      return [];
    }
    const actions = ((item.output ?? {}) as RunOutput).actions ?? [];
    const verdicts = pendingVerdicts(item.actionVerdicts, actions.length);
    const heldIndexes = verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : []));
    if (heldIndexes.length === 0) return [];
    return [
      {
        workItemId: item._id,
        pendingRunId: item.pendingRunId,
        title: item.title,
        actions,
        heldIndexes,
        refused: verdicts.filter((verdict) => verdict.disposition === 'refused').length,
      },
    ];
  });
}

/**
 * Every held action set across the queue, approvable from one place.
 *
 * Each member is shown with the same literal payloads its own card shows,
 * and the one button sends the same exact approval per member that the
 * card's "Approve all" sends: the parked run and its held indexes. A member
 * with a refused row is listed but left to its card, as the card's own rule
 * is. Shown only when more than one item is waiting; one item is its card.
 */
export function PendingDecisionsPanel({
  members,
  surfaces,
  onApproveBatch,
}: {
  members: PendingDecisionMember[];
  surfaces: SurfaceRecord[];
  onApproveBatch: (
    members: Array<{ workItemId: Id<'workItems'>; pendingRunId: Id<'events'>; approvedIndexes: number[] }>,
  ) => Promise<unknown>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (members.length < 2) return null;
  const eligible = members.filter((member) => member.refused === 0);
  const heldCount = eligible.reduce((sum, member) => sum + member.heldIndexes.length, 0);
  return (
    <div className="mb-3 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
      <p className="text-[var(--color-warn)] font-medium mb-1">
        {members.length} items have actions awaiting your approval
      </p>
      <ul className="space-y-1.5">
        {members.map((member) => (
          <li key={member.workItemId}>
            <p className="text-[var(--color-fg)] font-medium">{member.title}</p>
            {member.refused > 0 ? (
              <p className="text-[10px] text-[var(--color-muted)]">
                {member.refused} {member.refused === 1 ? 'row is' : 'rows are'} refused by the gate; decide this
                one on its card.
              </p>
            ) : null}
            <ul className="ml-3 space-y-0.5">
              {member.heldIndexes.map((index) => (
                <li key={index} className="text-[var(--color-fg)] break-words">
                  {summariseAction(member.actions[index], surfaces)}
                  <details className="mt-0.5">
                    <summary className="text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={member.actions[index]} />
                  </details>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2 mt-2">
        <button
          type="button"
          disabled={busy || eligible.length === 0}
          onClick={() => {
            setBusy(true);
            setError(null);
            onApproveBatch(
              eligible.map((member) => ({
                workItemId: member.workItemId,
                pendingRunId: member.pendingRunId,
                approvedIndexes: member.heldIndexes,
              })),
            )
              .catch((err: unknown) => setError((err as Error).message))
              .finally(() => setBusy(false));
          }}
          className="px-3 py-1 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve {heldCount} held {heldCount === 1 ? 'action' : 'actions'} across {eligible.length}{' '}
          {eligible.length === 1 ? 'item' : 'items'}
        </button>
        <span className="text-[10px] text-[var(--color-muted)]">
          Each item is approved exactly as shown; if one has moved on, nothing is approved and the list refreshes.
        </span>
      </div>
      {error ? <p className="mt-1 text-[10px] text-[var(--color-danger)]">{error}</p> : null}
    </div>
  );
}

export function WorkItemCard({
  item,
  surfaces,
  autonomousActions,
  questions = [],
  corrections = [],
  autonomyChanges = [],
  onApprovePlan,
  onCancelPlan,
  onRetryFailed,
  onReconcileFailed,
  onApproveActions,
  onRejectActions,
  onResendDecision,
}: {
  item: Doc<'workItems'>;
  surfaces: SurfaceRecord[];
  autonomousActions: boolean;
  /** The charter's open questions asked at this item's plan and still waiting. */
  questions?: Doc<'managerQuestions'>[];
  /** The employee's kept corrections, for the line saying this plan applied one. */
  corrections?: readonly KeptCorrection[];
  /** The employee's flips of the autonomous-actions switch, for a plan drafted before one. */
  autonomyChanges?: readonly AutonomyChange[];
  onApprovePlan: (decision: PlanApproval) => void;
  onCancelPlan: (reason: string) => void;
  onRetryFailed: (feedback?: string) => void;
  onReconcileFailed: (confirmed: boolean) => Promise<unknown>;
  onApproveActions: (approvedIndexes: number[]) => Promise<unknown>;
  onRejectActions: (reason: string) => Promise<unknown>;
  onResendDecision: () => Promise<unknown>;
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
        obligations?: PlanObligationsRow;
        obligationsFailedOpen?: string;
        appliedCorrections?: string[];
        correctionsRedaction?: 'structural-only';
      }
    | undefined;
  const output = item.output as RunOutput | undefined;
  const appliedActions = phasedLedger(output);
  // A row the auto phase deferred is in the gate box above, not in the ledger's held list.
  const heldActions = appliedActions.filter((a) => a.held && !a.awaitingApproval);
  // A row Day0's own gate refused was never sent: it is listed apart from a
  // row the provider failed, whose outcome someone may have to check.
  const unlandedActions = appliedActions.filter((a) => !a.ok && !a.held);
  const refusedActions = unlandedActions.filter((a) => isSurfaceTool(a.tool) && isGateRefusal(a.reason));
  const failedActions = unlandedActions.filter((a) => !refusedActions.includes(a));
  const landedActions = appliedActions.filter((a) => a.ok && !a.held);
  const landedAutonomously = landedActions.filter((a) => a.authority === 'autonomous').length;
  const autonomyTurnedOnAt = autonomyTurnedOnAfterDraft(item.planPendingAt, landedAutonomously > 0, autonomyChanges);
  const reconciliationEntries = item.providerReconciliation?.entries ??
    providerReconciliationEntries(output);
  const needsProviderReconciliation = retryRequiresProviderReconciliation(
    output,
    item.skipReason,
  );
  const retryBlocked = needsProviderReconciliation && !item.providerReconciliation;
  // The quality-fit filter's skip is the agent's judgement, not the manager's;
  // Retry hands the item back with that filter waived.
  const skipVerdictReason =
    item.state === 'skipped' && typeof (verdict as { reason?: unknown } | undefined)?.reason === 'string'
      ? (verdict as { reason: string }).reason
      : undefined;
  const qualityFitSkipped = skipVerdictReason?.startsWith(QUALITY_FIT_SKIP_PREFIX) === true;
  // The scope judgement is the agent's reading of the charter and the
  // documented systems; Retry is the manager saying the work is theirs to give.
  const outOfScopeSkipped = skipVerdictReason?.startsWith(OUT_OF_SCOPE_SKIP_PREFIX) === true;
  const skipWaivable = qualityFitSkipped || outOfScopeSkipped;
  // Refused at the claim: the colleague who holds the item works it, and the
  // row comes back by itself if they let it go, so there is no Retry here.
  const heldByColleague = colleagueHolding(item);
  const noteToken = retryNoteToken(item);
  const [typedRetryNote, setTypedRetryNote] = useState<TypedRetryNote>({ text: '', token: noteToken });
  const retryNote = liveRetryNote(typedRetryNote, noteToken);
  const sendingBack = item.state === 'completed' && retryNote.trim() !== '';
  // A plan the manager cancelled: Retry drafts a new one, never runs this one.
  const cancelledPlan = item.state === 'cancelled' && plan !== undefined;
  const awaitingSurface =
    verdict?.decision === 'defer' && verdict.reason === 'awaiting-connection'
      ? surfaces.find((surface) => surface.slug === verdict.missingSurface)
      : undefined;
  const decidedFrom = decisionAttribution(item.decision);
  // The phone request is shown only when it is known not to have arrived: a
  // recorded failure, or a silent send past the recovery bound. In flight,
  // delivered and decided requests say nothing here.
  const undelivered =
    item.state === 'plan-pending' || item.state === 'actions-pending'
      ? undeliveredDecisionReason(item.decision, now)
      : undefined;
  // A failed item whose run landed nothing and left nothing to decide is
  // shown as stopped: Retry stands, and the badge says no harm was done.
  const shownState = item.state === 'failed' && isStopped(item.skipReason) ? 'stopped' : item.state;
  return (
    <div className="border border-[var(--color-border)] rounded-lg p-3">
      <div className="flex items-start justify-between mb-2">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span
              className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded ${stateColor(shownState)}`}
            >
              {shownState}
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

      {undelivered && item.decision ? (
        <p className="mt-1 flex items-center gap-2 text-[10px] text-[var(--color-warn)]">
          <span>
            {item.decision.surfaceName} request not delivered
            {undelivered === 'request not delivered' ? '' : ` (${undelivered})`}
          </span>
          <button
            onClick={() => void onResendDecision()}
            className="px-2 py-0.5 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)]"
          >
            Resend
          </button>
        </p>
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
          ) : heldByColleague ? (
            <span className="text-[var(--color-fg)]">
              skip · another employee holds this:{' '}
              <Link
                href={`/agent/${heldByColleague.agentId}`}
                className="text-[var(--color-accent)] underline"
              >
                {heldByColleague.name}
              </Link>
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
          <AppliedCorrectionsLine
            ids={plan.appliedCorrections ?? []}
            corrections={corrections}
            workItemId={item._id}
            redaction={plan.correctionsRedaction}
          />
          <PlanObligationsLine steps={plan.steps} obligations={plan.obligations} failedOpen={plan.obligationsFailedOpen} />
          {autonomyTurnedOnAt !== undefined ? (
            <p className="mt-2 text-[var(--color-ok)]">
              <time dateTime={new Date(autonomyTurnedOnAt).toISOString()} title={clockTimeWithSeconds(autonomyTurnedOnAt)}>
                {autonomyTurnedOnAfterDraftNote(clockTime(autonomyTurnedOnAt), landedAutonomously, landedActions.length)}
              </time>
            </p>
          ) : null}
          {item.state === 'plan-pending' && item.planRejectedAt !== undefined ? (
            <p className="mt-2 text-[var(--color-warn)]">
              This plan was redrafted after you rejected an earlier plan. It waits for your approval even while autonomous actions are on.
            </p>
          ) : null}
          {item.state === 'plan-pending' ? (
            <PlanApprovalForm
              key={item._id}
              riskNotes={plan.riskNotes ?? ''}
              questions={questions}
              onApprove={onApprovePlan}
              onCancel={onCancelPlan}
            />
          ) : null}
          {item.state !== 'plan-pending' && item.managerAnswers && item.managerAnswers.length > 0 ? (
            <div className="mt-2 text-[var(--color-muted)]">
              <p className="text-[10px] uppercase tracking-wider mb-0.5">Answered at approval</p>
              <ul className="space-y-0.5">
                {item.managerAnswers.map((entry) => (
                  <li key={`${entry.question}:${entry.answeredAt}`}>
                    {entry.question} <span className="text-[var(--color-fg)]">- {entry.answer}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      ) : null}

      {item.managerFeedback ? <ManagerFeedbackNote feedback={item.managerFeedback} /> : null}

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
          repairs={output.argumentRepairs}
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
      {appliedActions.some((action) => action.redaction === 'structural-only') ? (
        <p className="mt-3 p-2 rounded-md border border-[var(--color-warn)]/30 text-xs text-[var(--color-warn)]">
          Limited redaction: some provider evidence was checked only against known credential values
          and credential formats. It may still contain secrets or personal data.
        </p>
      ) : null}

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
                <RepairNote repair={a.repair} />
                <SessionRestoreNote restore={a.sessionRestore} />
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
                <RepairNote repair={a.repair} />
                <SessionRestoreNote restore={a.sessionRestore} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <PlanExecutionLedger outcomes={output?.planStepOutcomes ?? []} />

      <RefusedBlockedSteps refused={output?.refusedClosing} />

      <RefusedClosingDetails refused={output?.refusedClosing} />

      <WithheldActionsDetails
        withheld={[
          ...(output?.initial?.withheldActions ?? []),
          ...(output?.withheldActions ?? []),
          ...(output?.refusedClosing?.withheldActions ?? []),
        ]}
      />

      {output ? <DraftDetails output={output} /> : null}

      {refusedActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {refusedActions.length} {refusedActions.length === 1 ? 'action' : 'actions'} refused by
            Day0&apos;s gate · never sent
          </p>
          <ul className="space-y-0.5 text-[var(--color-warn)]">
            {refusedActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason}
                <PhaseLabel phase={a.phase} />
                <RepairNote repair={a.repair} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

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
                <RepairNote repair={a.repair} />
                <SessionRestoreNote restore={a.sessionRestore} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.state === 'failed' || item.state === 'completed' || skipWaivable || cancelledPlan ? (
        <div className="mt-2">
          {/* The per-action box above already names every action that failed, so
              the row-level reason only earns its space for the other failures:
              no registered skill, a model error, a mid-run throw, a rejection. */}
          {item.state === 'failed' &&
          failedActions.length === 0 &&
          failedItemReason(item) &&
          !(item.managerFeedback && item.skipReason?.startsWith('rejected by the manager')) ? (
            <p className="text-[10px] text-[var(--color-muted)] italic mb-1.5">
              {failedItemReason(item)}
            </p>
          ) : null}
          {/* A finished item is sent back only with a note, so its checklist
              waits until the manager has started writing one. */}
          {(needsProviderReconciliation || item.providerReconciliation) &&
          (item.state !== 'completed' || sendingBack) ? (
            <ProviderReconciliationControl
              entries={reconciliationEntries}
              reconciliation={item.providerReconciliation}
              onConfirm={onReconcileFailed}
            />
          ) : null}
          {item.state === 'failed' || item.state === 'completed' || cancelledPlan ? (
            <input
              type="text"
              value={retryNote}
              onChange={(event) => setTypedRetryNote({ text: event.target.value, token: noteToken })}
              placeholder={
                item.state === 'completed'
                  ? 'note for the retry: say what to change or answer what the agent asked'
                  : cancelledPlan
                    ? 'note for the new plan (optional)'
                    : 'note for the retry (optional): answer what the agent asked, or say what to change'
              }
              aria-label="note for the retry"
              className="w-full mb-1.5 px-2 py-1 rounded-md border border-[var(--color-border)] bg-transparent text-xs"
            />
          ) : null}
          <button
            onClick={() => onRetryFailed(retryNote)}
            disabled={retryBlocked || (item.state === 'completed' && !sendingBack)}
            className="px-3 py-1 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Retry
          </button>
          {retryBlocked && (item.state !== 'completed' || sendingBack) ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry remains disabled until provider reconciliation is recorded.
            </p>
          ) : null}
          {item.state === 'completed' ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry with a note sends this finished work back; the note reaches the agent as your
              direction, and its writes are held again unless autonomous actions are on.
            </p>
          ) : null}
          {cancelledPlan ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              {autonomousActions
                ? 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs, even while autonomous actions are on.'
                : 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs.'}
            </p>
          ) : null}
          {qualityFitSkipped ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry re-evaluates this item without the quality-fit filter; its plan still needs
              your approval.
            </p>
          ) : null}
          {outOfScopeSkipped ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry re-evaluates this item as in scope, on your decision; its plan still needs
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

function metricValue(value: string | undefined): string {
  return value ?? 'loading…';
}

export function MetricsCard({ metrics }: { metrics: AgentMetrics | undefined }) {
  const humanDecisions = metrics
    ? metrics.decisions.requested === 0
      ? 'not yet'
      : `${metrics.decisions.approved} / ${metrics.decisions.rejected}`
    : undefined;
  const decidedFrom = metrics
    ? metrics.decisions.requested === 0
      ? 'not yet'
      : `${metrics.decisions.byVia.dashboard.decided} / ${metrics.decisions.byVia.channel.decided}`
    : undefined;
  const blocked = metrics
    ? metrics.actions.blockedAfterRevocation === null
      ? 'not yet'
      : String(metrics.actions.blockedAfterRevocation)
    : undefined;
  const completeness = metrics ? formatAuditTrail(metrics.auditTrail) : undefined;
  const rows = [
    {
      label: 'time to first approved charter',
      value: metrics ? formatMetricDuration(metrics.charter.timeToFirstApprovedMs) : undefined,
    },
    { label: 'human decisions (approved / rejected)', value: humanDecisions },
    { label: 'human decisions (dashboard / phone)', value: decidedFrom },
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
          {metrics.actions.sessionRestores > 0
            ? ` - ${metrics.actions.sessionRestores} browser ${metrics.actions.sessionRestores === 1 ? 'call' : 'calls'} replayed to sign in again`
            : null}
        </p>
      ) : null}
    </Card>
  );
}

export function eventLabel(event: Pick<Doc<'events'>, 'type' | 'payload'>): string {
  if (event.type === 'work.failed' && (event.payload as { stopped?: unknown })?.stopped === true) {
    return 'work.failed · stopped';
  }
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
