'use client';

import {
  CLAIMED_BY_COLLEAGUE_SKIP_PREFIX,
  OUT_OF_SCOPE_SKIP_PREFIX,
  QUALITY_FIT_SKIP_PREFIX,
} from '@/work/types';
import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useState, useEffect, useId, useMemo, useRef, useCallback } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '../../../convex/_generated/api';
import type { Doc, Id } from '../../../convex/_generated/dataModel';
import {
  AppliedCorrectionsLine,
  KeptCorrectionsPanel,
  keptCorrectionsTitle,
  type KeptCorrection,
} from './corrections-panel';
import { holdsLiveAuthoringClaim } from '../../../src/lib/skill-authoring';
import {
  declaredSkillInputs,
  impliedSkillInputs,
  systemDeclaredInputs,
} from '../../../src/work/skill-inputs';
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
import { isManagerLookupFailure } from '../../../src/surfaces/manager-lookup';
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
  OUTCOME_UNKNOWN_REASON,
  providerReconciliationEntries,
  retryRequiresProviderReconciliation,
  type ReconciliationEntry,
} from '../../../src/work/reconciliation';
import type {
  ArgumentRepairAttempt,
  CharterClauseRef,
  MockAction,
  PlanObligations,
} from '../../../src/work/types';
import {
  isOpenQuestionStop,
  isWithheldForAnswer,
  planObligations,
  transitionWithheld,
} from '../../../src/work/obligations';
import {
  AgentZoneContext,
  clockTime,
  clockTimeWithSeconds,
  relativeTime,
  useAgentZone,
  useNow,
} from './time';
import { eventLabel } from './event-labels';
import { ROOM_HEIGHT } from './room-frame';
import {
  compareWaitingRows,
  EVALUATION_ATTEMPTS_SPENT,
  MAX_EVALUATION_ATTEMPTS,
} from '../../../src/work/queue-order';
import { LiveStatus, refusalText, returnFocus, useChange, type ChangeOutcome } from './live-status';
import { agentZone, isTimeZone } from '../../../src/lib/zone';
import { draftedWithoutLine, undeliveredDecisionReason } from '../../../src/work/manager-channel';
import { managerFeedbackLabel, type ManagerFeedback } from '../../../src/work/manager-feedback';
import {
  GATE_REFUSAL_STOP,
  isGateRefusalStop,
  isStopped,
  stopDetail,
} from '../../../src/work/stop';
import {
  managerNotificationMode,
  NOTIFICATION_MODE_LABELS,
  type ManagerNotificationMode,
} from '../../../src/work/manager-notes';
import type { AgentMetrics } from '@/metrics/types';
import { formatAuditTrail, formatMetricDuration } from '../../metric-format';
import { PILOT_FIGURES, readsAndMessages } from '../../CompanySupervision';
import { errorMessage } from '@/lib/errors';
import { plainErrorMessage } from '@/lib/plain-error';

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
  /** Why it did not finish; absent when the attempt registered the skill. */
  reason?: string;
}

/**
 * What a panel shows while its chunk is on the way: the panel's own frame,
 * so the page does not jump by a card when the chunk lands.
 */
function PanelLoading({ label, frame }: { label: string; frame: string }): React.JSX.Element {
  return (
    <p
      className={`${frame} flex items-center justify-center text-xs text-[var(--color-muted)]`}
      role="status"
    >
      Loading {label}
    </p>
  );
}

/** The frames the three panels occupy, as their own markup sizes them. */
const ROOM_FRAME = `${ROOM_HEIGHT} rounded-xl border border-[var(--color-border)]`;
const ENVIRONMENT_FRAME = 'min-h-[30rem] rounded-xl border border-[var(--color-border)]';

/*
 * The three panels below are the page's own chunks, loaded when they mount:
 * the voice room carries the ElevenLabs SDK and the mock environment its
 * five tabs, and neither is needed to draw the first paint of the page. The
 * voice room also touches the browser at import, so it is never rendered on
 * the server.
 */
const ChatRoom = dynamic(() => import('./ChatRoom').then((module) => module.ChatRoom), {
  loading: () => <PanelLoading label="the 1:1" frame={ROOM_FRAME} />,
});
const VoiceRoom = dynamic(() => import('./VoiceRoom').then((module) => module.VoiceRoom), {
  ssr: false,
  loading: () => <PanelLoading label="the 1:1" frame={ROOM_FRAME} />,
});
const MockEnvironment = dynamic(
  () => import('./MockEnvironment').then((module) => module.MockEnvironment),
  { loading: () => <PanelLoading label="the work environment" frame={ENVIRONMENT_FRAME} /> },
);

/** The employee's page: the 1:1, the charter, the queue, the skills, the permissions and the office. */
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
  // What a change said once the control that made it left the page with its
  // card (a charter sent back), and where focus goes after it.
  const [pageOutcome, setPageOutcome] = useState<ChangeOutcome | null>(null);
  const [focusOnboarding, setFocusOnboarding] = useState(false);
  const onboarding = useRef<HTMLDivElement>(null);
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
    lastAttempt?.reason !== undefined &&
    attemptedSkill &&
    !holdsLiveAuthoringClaim(attemptedSkill, now) &&
    attemptedSkill.state !== 'registered' &&
    attemptedSkill.state !== 'rejected'
      ? `${lastAttempt.name}: ${lastAttempt.reason}`
      : null;
  // A registration the manager started is said once the row says it too.
  const authoringRegistered =
    lastAttempt && lastAttempt.reason === undefined && attemptedSkill?.state === 'registered'
      ? lastAttempt.name
      : null;
  const skillsCard = useRef<HTMLElement>(null);

  // Sync local mode with server state. Two cases:
  //   1. Reload mid-session: route back into the room they were in
  //      (uses the voiceSession row to figure out which).
  //   2. Request Changes on the charter: agent.state flips back to
  //      `deployed` AND a prior voiceSession exists. Reset to picker.
  // The `voiceSession` guard is critical: without it, the moment a fresh
  // user picks a mode (state is still `deployed`, mode flips off `pick`)
  // this effect would race the user's click and snap them back to picker.
  //
  // This resync stays an effect on purpose. Deriving `mode` cannot express
  // case 2 (the boss's own pick has to be discarded when the server moves
  // underneath it), and resetting via a subtree `key` would remount
  // `ChatRoom`, whose mount effect opens a voice session, so every state
  // transition would start a duplicate 1:1.
  useEffect(() => {
    if (!agent) return;
    if (agent.state === 'deployed' && mode !== 'pick' && voiceSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMode('pick');
      return;
    }
    if (agent.state === 'day-one-in-progress' && mode === 'pick' && voiceSession) {
      setMode(voiceSession.mode === 'chat' ? 'chat' : 'voice');
    }
  }, [agent, voiceSession, mode]);

  const onboardingShown =
    !!agent && !charter && (agent.state === 'deployed' || agent.state === 'day-one-in-progress');
  useEffect(() => {
    if (!focusOnboarding || !onboardingShown) return;
    onboarding.current?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the focus move happens once, when the 1:1 is back on the page after a charter is sent back
    setFocusOnboarding(false);
  }, [focusOnboarding, onboardingShown]);

  if (!agent) {
    return (
      <main className="min-h-screen flex items-center justify-center text-[var(--color-muted)]">
        loading agent…
      </main>
    );
  }

  // A drafted charter ends the 1:1, whatever the agent row still says. The
  // room stayed open under the charter it had just produced (badge reading
  // "streaming", footer reading "drafting your charter…") because both were
  // keyed to a state the chat route never moved on.
  const showOnboarding = onboardingShown;

  return (
    <AgentZoneContext value={agentZone(agent)}>
      <main className="min-h-screen px-6 py-8 max-w-7xl mx-auto">
        <DashboardHeader
          agent={agent}
          charter={charter ?? null}
          managerLookupFailure={
            (surfaceRows ?? []).find(
              (row) => row.class === 'chat' && isManagerLookupFailure(row.reason),
            )?.reason
          }
        />

        <LiveStatus outcome={pageOutcome} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <div className="lg:col-span-2 space-y-4">
            {showOnboarding ? (
              <div
                ref={onboarding}
                tabIndex={-1}
                role="region"
                aria-label="The 1:1 that drafts the charter"
              >
                {mode === 'pick' ? (
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
                )}
              </div>
            ) : null}

            {charter ? (
              <CharterCard
                charter={charter}
                manager={agent.bossEmail}
                onSentBack={(text) => {
                  setPageOutcome({ tone: 'done', text });
                  setFocusOnboarding(true);
                }}
              />
            ) : null}

            <ProposedSkillsPanel
              skills={proposedSkills ?? []}
              surfaces={surfaces}
              onAuthoringAttempt={setLastAttempt}
              fallback={skillsCard}
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
              loading={workItems === undefined}
            />
          </div>

          <div className="space-y-4">
            <WorkspacePanel workspace={workspace ?? {}} />
            <RegisteredSkillsPanel
              skills={registeredSkills ?? []}
              unregistered={[...(unverifiedSkills ?? []), ...(failedSkills ?? [])]}
              authoringFailure={authoringFailure}
              registered={authoringRegistered}
              onAuthoringAttempt={setLastAttempt}
              surfaceMode={surfaceConfig?.mode}
              focusRef={skillsCard}
              loading={registeredSkills === undefined}
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
            <EventTicker events={events} titles={itemTitles} />
          </div>
        </div>

        {/* Full width, and not half of two thirds of the page. Five work
          surfaces, a channel list and a conversation do not fit in 400px, and
          this panel is the whole of what the agent's work is done against. */}
        <MockEnvironment agentId={agentId} />
      </main>
    </AgentZoneContext>
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
          className="min-h-11 px-3 rounded-md bg-[var(--color-warn)] text-[var(--color-bg)] font-medium disabled:opacity-60"
        >
          Turn on
        </button>
        <button
          type="button"
          autoFocus
          disabled={busy}
          onClick={onCancel}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] disabled:opacity-60"
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
  const [confirming, setConfirming] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const change = useChange(toggle);
  const describedBy = useId();

  function persist(next: boolean): void {
    change.run(() => onChange(next), {
      done: next
        ? 'Autonomous actions are on: the employee acts on connected systems without asking.'
        : 'Autonomous actions are off: every action but reads and the DM to you waits for your approval.',
      refused: 'The switch was not changed.',
      after: () => setConfirming(false),
    });
  }

  return (
    <div className="relative">
      <div
        className={`flex items-center gap-2 pl-3 pr-1 rounded-full text-xs font-medium ${tone}`}
        title={AUTONOMY_TITLES[on ? 'on' : 'off']}
      >
        <span>Active · {autonomyLabel(on)}</span>
        <span className="text-[10px] font-normal opacity-80">Autonomous actions</span>
        <span id={describedBy} className="sr-only">
          {AUTONOMY_TITLES[on ? 'on' : 'off']}
        </span>
        <button
          ref={toggle}
          type="button"
          role="switch"
          aria-checked={on}
          aria-label="Autonomous actions"
          aria-describedby={describedBy}
          disabled={change.busy}
          onClick={() => {
            if (on) persist(false);
            else setConfirming(true);
          }}
          className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full disabled:cursor-wait"
        >
          <span
            aria-hidden="true"
            className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
              on ? 'bg-[var(--color-warn)]' : 'bg-[var(--color-muted)]/40'
            }`}
          >
            <span
              className={`inline-block h-3 w-3 rounded-full bg-[var(--color-bg)] transition-transform ${
                on ? 'translate-x-3.5' : 'translate-x-0.5'
              }`}
            />
          </span>
        </button>
      </div>
      <LiveStatus outcome={change.outcome} />
      {confirming && !on ? (
        <AutonomyConfirm
          busy={change.busy}
          onConfirm={() => persist(true)}
          onCancel={() => {
            setConfirming(false);
            toggle.current?.focus();
          }}
        />
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
  const change = useChange();
  const id = useId();
  return (
    <div>
      <div
        className="flex items-center gap-1.5 pl-3 pr-1 rounded-full border border-[var(--color-border)] text-[10px] text-[var(--color-muted)]"
        title={NOTIFICATION_MODE_HINT}
      >
        <label htmlFor={`${id}-mode`}>Manager DMs</label>
        <select
          id={`${id}-mode`}
          aria-describedby={`${id}-hint`}
          value={mode}
          disabled={change.busy}
          onChange={(event) => {
            const next = event.target.value as ManagerNotificationMode;
            change.run(() => onChange(next), {
              done: `Manager DMs: ${NOTIFICATION_MODE_LABELS[next]}.`,
              refused: 'The manager DM setting was not changed.',
            });
          }}
          className="min-h-11 bg-transparent text-xs text-[var(--color-fg)] disabled:cursor-wait"
        >
          {(Object.keys(NOTIFICATION_MODE_LABELS) as ManagerNotificationMode[]).map((option) => (
            <option key={option} value={option}>
              {NOTIFICATION_MODE_LABELS[option]}
            </option>
          ))}
        </select>
        <span id={`${id}-hint`} className="sr-only">
          {NOTIFICATION_MODE_HINT}
        </span>
      </div>
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

/** What the manager DM setting does, beside the control and for its hover. */
const NOTIFICATION_MODE_HINT =
  'Decision requests go to your manager channel at once whenever one is connected. This sets how you hear that work landed or a run stopped.';

/**
 * Who the agent reports to, and the control that changes it (Q6).
 *
 * The address is the one the chat surface looks up to find the manager's DM,
 * so a manager who left, or whose account Slack no longer finds, is replaced
 * here rather than by a reset. When a chat surface failed on that lookup the
 * line says so, because the card beside it would otherwise blame the credential.
 */
export function ManagerLine({
  bossEmail,
  lookupFailure,
  onChange,
}: {
  bossEmail: string;
  /** The stored reason of a chat surface whose probe could not find the manager. */
  lookupFailure?: string;
  onChange: (bossEmail: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(bossEmail);
  const toggle = useRef<HTMLButtonElement>(null);
  const change = useChange(toggle);
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    const next = draft.trim();
    change.run(() => onChange(next), {
      done: `The employee now reports to ${next}.`,
      refused: 'The manager was not changed.',
      after: () => setEditing(false),
    });
  };
  return (
    <div>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <label className="text-2xl font-semibold tracking-tight" htmlFor="manager-email">
            Agent reporting to
          </label>
          <input
            id="manager-email"
            type="email"
            autoFocus
            value={draft}
            disabled={change.busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setDraft(bossEmail);
                close();
              }
            }}
            className="min-h-11 min-w-0 font-mono text-sm px-2 rounded border border-[var(--color-border)] bg-transparent"
          />
          <button
            type="submit"
            disabled={change.busy || draft.trim() === ''}
            className="min-h-11 text-xs px-3 rounded bg-[var(--color-accent)] text-[var(--color-bg)] disabled:opacity-50"
          >
            {change.busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={change.busy}
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              close();
            }}
            className="min-h-11 text-xs px-3 rounded border border-[var(--color-border)]"
          >
            Cancel
          </button>
        </form>
      ) : (
        <h1 className="text-2xl font-semibold tracking-tight">
          Agent reporting to{' '}
          <span className="font-mono break-all text-[var(--color-accent)]">{bossEmail}</span>{' '}
          <button
            ref={toggle}
            type="button"
            onClick={() => {
              setDraft(bossEmail);
              change.clear();
              setEditing(true);
            }}
            className="min-h-11 align-middle text-xs font-normal px-3 rounded border border-[var(--color-border)] text-[var(--color-muted)]"
          >
            Change manager
          </button>
        </h1>
      )}
      {editing ? (
        <p className="mt-1 text-xs text-[var(--color-muted)]">
          Decisions waiting in the previous manager&apos;s DM are sent again to the new one once the
          chat surface finds them.
        </p>
      ) : null}
      {lookupFailure && !editing ? (
        <p className="mt-1 text-xs text-[var(--color-warn)]">
          The chat surface could not find this manager: {lookupFailure.replace(/\.$/, '')}. The
          credential still works; change the manager to someone the workspace knows.
        </p>
      ) : null}
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

/** The zones the browser knows, UTC first, for the zone field's suggestions. */
function knownZones(): string[] {
  const listed =
    typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return ['UTC', ...listed.filter((zone) => zone !== 'UTC')];
}

/**
 * The employee's day (N12): the zone every time on this page is printed in,
 * and the control that changes it (`agents.setZone`).
 *
 * The line says the zone once so a stamp never needs its own; changing it
 * moves every stamp here and every day boundary the server draws (the daily
 * cap, the expiry notice, the digest's "since yesterday"). The outcome is
 * announced in the line's live region and focus returns to the control.
 */
export function ZoneLine({
  zone,
  onChange,
}: {
  zone: string;
  onChange: (zone: string) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(zone);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ChangeOutcome | null>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const zones = useMemo((): string[] => knownZones(), []);
  const valid = isTimeZone(draft.trim());
  const close = (): void => {
    setEditing(false);
    toggle.current?.focus();
  };
  const save = (): void => {
    const next = draft.trim();
    setBusy(true);
    setOutcome(null);
    // The chain ends in its own catch, which says the refusal in the live region.
    void onChange(next)
      .then(() => {
        setOutcome({
          tone: 'done',
          text: `The employee's day is now ${next}; every time on this page is in it.`,
        });
        close();
      })
      .catch((err: unknown) =>
        setOutcome({ tone: 'refused', text: refusalText(err, 'The zone was not changed.') }),
      )
      .finally(() => setBusy(false));
  };
  return (
    <div className="mt-1 text-xs text-[var(--color-muted)]">
      <p className="flex flex-wrap items-center gap-x-2">
        <span>
          Times on this page are in <span className="text-[var(--color-fg)]">{zone}</span>, the
          employee&apos;s day.
        </span>
        <button
          ref={toggle}
          type="button"
          aria-expanded={editing}
          aria-controls="zone-editor"
          onClick={() => {
            setDraft(zone);
            setOutcome(null);
            setEditing(!editing);
          }}
          className="min-h-11 px-2 rounded border border-[var(--color-border)] text-[var(--color-fg)] hover:border-[var(--color-accent)]"
        >
          Change zone
        </button>
      </p>
      {editing ? (
        <form
          id="zone-editor"
          className="mt-1 flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) save();
          }}
        >
          <label htmlFor="agent-zone" className="text-[var(--color-fg)]">
            Zone
          </label>
          <input
            id="agent-zone"
            list="agent-zone-options"
            autoFocus
            value={draft}
            disabled={busy}
            aria-invalid={!valid}
            aria-describedby="agent-zone-hint"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                close();
              }
            }}
            className="min-h-11 min-w-0 flex-1 font-mono px-2 rounded border border-[var(--color-border)] bg-transparent text-[var(--color-fg)]"
          />
          <datalist id="agent-zone-options">
            {zones.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
          <button
            type="submit"
            disabled={busy || !valid || draft.trim() === zone}
            className="min-h-11 px-3 rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={close}
            className="min-h-11 px-3 rounded border border-[var(--color-border)] text-[var(--color-fg)]"
          >
            Cancel
          </button>
          <p id="agent-zone-hint" className="basis-full">
            {valid
              ? 'A zone name such as Europe/London or Asia/Singapore.'
              : `${draft.trim() || 'An empty name'} is not a zone this browser knows; pick one from the list.`}
          </p>
        </form>
      ) : null}
      <LiveStatus outcome={outcome} />
    </div>
  );
}

/** The page header: the employee's name, state, zone, autonomy switch and manager channel control. */
export function DashboardHeader({
  agent,
  charter,
  managerLookupFailure,
}: {
  agent: Doc<'agents'>;
  /** What the page is showing, which outranks the row when the two disagree. */
  charter: Doc<'charters'> | null;
  /** A chat surface's failure reason when its probe could not find the manager. */
  managerLookupFailure?: string;
}) {
  const surfaceConfig = useQuery(api.config.surfaceMode);
  const setBossEmail = useMutation(api.agents.setBossEmail);
  const setAutonomousActions = useMutation(api.agents.setAutonomousActions);
  const setManagerNotifications = useMutation(api.agents.setManagerNotifications);
  const setZone = useMutation(api.agents.setZone);
  const stateLabel: Record<Doc<'agents'>['state'], { text: string; tone: string }> = {
    deployed: {
      text: 'Deployed · awaiting Day-1 1:1',
      tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
    },
    'day-one-in-progress': {
      text: 'Day-1 1:1 in progress',
      tone: 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]',
    },
    'charter-pending': {
      text: 'Charter drafted · awaiting boss approval',
      tone: 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]',
    },
    active: {
      text: `Active · ${SUPERVISED_LABEL}`,
      tone: 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]',
    },
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
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs uppercase tracking-[0.2em] text-[var(--color-accent)] mb-1">Day0</p>
          <ManagerLine
            bossEmail={agent.bossEmail}
            lookupFailure={managerLookupFailure}
            onChange={(bossEmail) => setBossEmail({ agentId: agent._id, bossEmail })}
          />
          <ZoneLine
            zone={agentZone(agent)}
            onChange={(zone) => setZone({ agentId: agent._id, zone })}
          />
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
  focusRef,
}: {
  title: string;
  children: React.ReactNode;
  tone?: 'default' | 'accent' | 'warn' | 'ok';
  /** Makes the card the place focus returns to when a change removes the control that made it. */
  focusRef?: React.Ref<HTMLElement>;
}) {
  const headingId = useId();
  const border = {
    default: 'border-[var(--color-border)]',
    accent: 'border-[var(--color-accent)]/40',
    warn: 'border-[var(--color-warn)]/40',
    ok: 'border-[var(--color-ok)]/40',
  }[tone ?? 'default'];
  return (
    <section
      ref={focusRef}
      {...(focusRef ? { tabIndex: -1, 'aria-labelledby': headingId } : {})}
      className={`bg-[var(--color-card)] border ${border} rounded-xl p-4`}
    >
      <h2
        id={focusRef ? headingId : undefined}
        className="text-sm font-semibold tracking-tight text-[var(--color-fg)] mb-3"
      >
        {title}
      </h2>
      {children}
    </section>
  );
}

function ModePicker({ onPick }: { onPick: (mode: 'voice' | 'chat') => void }) {
  // null while the probe is in flight; voice stays clickable so the
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
    <Card title="Day-1 1:1: voice or chat?" tone="accent">
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
          Voice is off on this deployment: no ElevenLabs credentials. Chat asks the same seven
          topics in text.
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
  /** Whose lane the employee stays out of; the scope check reads these. */
  adjacentRoles?: Array<{ who: string; staysOutOfTheirLaneBy: string }>;
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
  busy = false,
}: {
  constraints: CharterConstraint[];
  approved: boolean;
  /** A change to the charter is in flight; the controls wait for it. */
  busy?: boolean;
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
        {approved
          ? 'Rules this charter enforces'
          : 'These words will limit the work. Confirm or strike each one.'}
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
                  {/* A derived rule's quote is the clause itself, not a sentence
                    the manager said, so it is not printed as a quotation. */}
                  {constraint.origin === 'derived' ? (
                    constraint.quote
                  ) : (
                    <>&ldquo;{constraint.quote}&rdquo;</>
                  )}
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
                    ' · not verified: no clause carries these words, so striking it changes nothing'
                  )}
                  {constraint.origin === 'derived'
                    ? " · found by checking the clauses (the charter's wording, not a sentence of yours)"
                    : ''}
                  {constraint.origin === 'manager' ? ' · added by you' : ''}
                  {constraint.struck ? ' · struck' : ''}
                </p>
                {preview?.refusal ? (
                  <p className="text-[10px] text-[var(--color-warn)] mt-0.5">
                    cannot be struck: {preview.refusal}
                  </p>
                ) : preview && preview.removedClauses.length > 0 ? (
                  <p className="text-[10px] text-[var(--color-muted)] mt-0.5">
                    {preview.removedClauses.length === 1
                      ? 'strikes the clause: '
                      : 'strikes the clauses: '}
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
                  type="button"
                  onClick={() => onStrike(index)}
                  disabled={busy || preview?.refusal !== undefined}
                  title={preview?.refusal}
                  aria-label={`Strike: ${constraint.quote}`}
                  className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-warn)] disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:border-[var(--color-border)]"
                >
                  Strike
                </button>
              ) : constraint.struck && onRestore ? (
                <button
                  type="button"
                  onClick={() => onRestore(index)}
                  disabled={busy}
                  aria-label={`Restore: ${constraint.quote}`}
                  className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-ok)] disabled:opacity-50"
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

/**
 * The charter as drafted or approved, with its rules, its notes and, once
 * approved, the amendment panel.
 *
 * The manager it names is the agent row's, the one the header changes
 * (U9 D3 (b)): the charter has no approval chain of its own to edit here.
 */
export function CharterCard({
  charter,
  manager,
  onSentBack,
}: {
  charter: Doc<'charters'>;
  /** The agent row's manager, who approves this employee's work. */
  manager?: string;
  /** Said on the page once the draft is sent back and this card goes. */
  onSentBack?: (text: string) => void;
}) {
  const approve = useMutation(api.charters.approve);
  const requestChanges = useMutation(api.charters.requestChanges);
  const setConstraintStruck = useMutation(api.charters.setConstraintStruck);
  const amend = useMutation(api.charters.amend);
  const card = useRef<HTMLElement>(null);
  const change = useChange(card);
  const body = charter.body as CharterCardBody;
  const constraints = body.constraints ?? [];
  const struckCount = constraints.filter((constraint) => constraint.struck).length;

  function toggleStrike(index: number, struck: boolean): void {
    const quote = constraints[index]?.quote ?? 'the rule';
    change.run(
      async (): Promise<void> => {
        const result = await setConstraintStruck({ charterId: charter._id, index, struck });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: struck
          ? `Struck “${quote}”: approval leaves its clauses out.`
          : `Restored “${quote}”.`,
        refused: 'The rule was not changed.',
      },
    );
  }

  function sendAmendment(
    amendment: CharterChange,
    after?: () => void,
    focus?: () => HTMLElement | null,
  ): void {
    change.run(() => amend({ agentId: charter.agentId, changes: [amendment] }), {
      done: `Charter amended: version ${nextCharterVersion(charter.version)} is the one in force.`,
      refused: 'The amendment was refused.',
      after,
      focus,
    });
  }

  // The approval seeds the work the charter implies on the server, in the
  // same transaction, so nothing here waits on or retries it.
  function onApprove(): void {
    change.run(
      async (): Promise<void> => {
        const result = await approve({ charterId: charter._id });
        if (!result.ok) throw new Error(result.reason);
      },
      {
        done: 'Charter approved: the employee starts on the work it implies.',
        refused: 'The approval was not recorded.',
      },
    );
  }

  // Sending the draft back deletes it, and this card with it, so the outcome
  // is said on the page, which also takes focus.
  function onRequestChanges(): void {
    change.run(() => requestChanges({ charterId: charter._id }), {
      done: SENT_BACK,
      refused: 'The charter was not sent back.',
      after: () => onSentBack?.(SENT_BACK),
    });
  }

  return (
    <Card
      title={`Charter v${charter.version}${charter.approved ? ' · approved' : ' · awaiting approval'}`}
      tone={charter.approved ? 'ok' : 'warn'}
      focusRef={card}
    >
      <div className="space-y-3 text-sm">
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
            Why this hire
          </span>
          <p className="text-[var(--color-fg)]">{body.whyThisHire}</p>
        </div>
        <div>
          <span className="text-[var(--color-muted)] text-xs uppercase tracking-wider">
            Proposed function
          </span>
          <p className="text-[var(--color-fg)]">{body.proposedFunction}</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
          <Goal label="30-day" text={body.shortTermGoals.day30} />
          <Goal label="60-day" text={body.shortTermGoals.day60} />
          <Goal label="90-day" text={body.shortTermGoals.day90} />
        </div>
        <details className="text-xs">
          <summary className={SUMMARY}>Boundaries · collaborators · open questions</summary>
          <div className="mt-2 space-y-2 pl-3 border-l border-[var(--color-border)]">
            <BoundaryList
              label="Reports to"
              items={
                manager ? [`${manager}, the manager named in the header; change it there`] : []
              }
            />
            <BoundaryList label="Will do" items={body.proposedBoundaries.willDo} />
            <BoundaryList label="Will NOT do" items={body.proposedBoundaries.willNotDo} />
            <BoundaryList
              label="Escalation triggers"
              items={body.proposedBoundaries.escalationTriggers}
            />
            <BoundaryList
              label="Systems named in the 1:1"
              items={(body.namedSystems ?? []).map(
                (system) => `${system.name} (${system.class}) - ${system.whereMentioned}`,
              )}
            />
            <BoundaryList
              label="Collaborators"
              items={body.namedCollaborators.map((c) => `${c.name} - ${c.topic}`)}
            />
            <BoundaryList
              label="Adjacent roles (work in their lane is out of scope)"
              items={(body.adjacentRoles ?? []).map(
                (role) => `${role.who} - ${role.staysOutOfTheirLaneBy}`,
              )}
            />
            <BoundaryList label="Priority reading" items={body.priorityReading} />
            <BoundaryList label="Open questions" items={managerOpenQuestions(body)} />
          </div>
        </details>
        <ConstraintList
          constraints={constraints}
          approved={charter.approved}
          busy={change.busy}
          onStrike={(index) =>
            charter.approved
              ? sendAmendment({ kind: 'strike-constraint', index })
              : toggleStrike(index, true)
          }
          onRestore={charter.approved ? undefined : (index) => toggleStrike(index, false)}
          previewStrike={(index) => strikePreview(body, index)}
        />
        <SynthesisNotes notes={synthesisNotes(body)} />
        {charter.approved ? (
          <AmendCharterPanel
            charter={charter}
            body={body}
            busy={change.busy}
            onAmend={sendAmendment}
          />
        ) : null}
        {!charter.approved ? (
          <div className="flex flex-wrap gap-2 pt-1">
            <button
              type="button"
              onClick={onApprove}
              disabled={change.busy}
              className="min-h-11 px-4 rounded-lg bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-sm font-medium disabled:opacity-50"
            >
              {struckCount > 0
                ? `Approve, ${struckCount} ${struckCount === 1 ? 'rule' : 'rules'} struck`
                : 'Approve'}
            </button>
            <button
              type="button"
              onClick={onRequestChanges}
              disabled={change.busy}
              className="min-h-11 px-4 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-warn)] text-sm disabled:opacity-50"
            >
              Request changes
            </button>
          </div>
        ) : null}
        <LiveStatus outcome={change.outcome} />
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
  'min-h-11 flex-1 min-w-0 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-md px-2 text-xs text-[var(--color-fg)]';
const AMEND_BUTTON =
  'shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50';

/** A disclosure's summary with a 44 px target (N14). */
const SUMMARY =
  'min-h-11 py-3 cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]';

/** What the page says once the manager sends a draft charter back. */
const SENT_BACK =
  'Charter sent back: the 1:1 opens again so the employee can redraft it from what you tell it.';

/**
 * One line of text the manager can rewrite or remove; Save sends the
 * amendment. Callers key it by the text, so a new version remounts it with
 * the new text rather than syncing state from props.
 */
function EditableLine({
  text,
  label,
  busy,
  onSave,
  onRemove,
}: {
  text: string;
  /** What the line is, as the field's visible label. */
  label: string;
  busy: boolean;
  onSave: (text: string) => void;
  onRemove?: () => void;
}) {
  const [draft, setDraft] = useState(text);
  const id = useId();
  const changed = draft.trim() !== text.trim();
  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <input
        id={id}
        className={AMEND_INPUT}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className={AMEND_BUTTON}
        disabled={busy || !changed || !draft.trim()}
        aria-label={`Save: ${label}`}
        onClick={() => onSave(draft)}
      >
        Save
      </button>
      {onRemove ? (
        <button
          type="button"
          className={AMEND_BUTTON}
          disabled={busy}
          aria-label={`Remove: ${label}`}
          onClick={onRemove}
        >
          Remove
        </button>
      ) : null}
    </div>
  );
}

/** A labelled input with a button, cleared when the change it sends lands. */
function AddLine({
  label,
  button,
  busy,
  onAdd,
}: {
  /** The field's visible label. */
  label: string;
  /** The button's text. */
  button: string;
  busy: boolean;
  /**
   * Send the text; `clear` empties the field once the change lands, and the
   * field, where the next entry goes, takes focus from the emptied button.
   */
  onAdd: (text: string, clear: () => void, field: () => HTMLElement | null) => void;
}) {
  const [draft, setDraft] = useState('');
  const id = useId();
  const field = useRef<HTMLInputElement>(null);
  return (
    <div className="flex flex-wrap items-center gap-1">
      <label htmlFor={id} className="basis-full text-[10px] text-[var(--color-muted)]">
        {label}
      </label>
      <input
        ref={field}
        id={id}
        className={AMEND_INPUT}
        value={draft}
        disabled={busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      <button
        type="button"
        className={AMEND_BUTTON}
        disabled={busy || !draft.trim()}
        onClick={() =>
          onAdd(
            draft,
            () => setDraft(''),
            () => field.current,
          )
        }
      >
        {button}
      </button>
    </div>
  );
}

/** A sentence that forbids: the manager's "never", "don't", "no …" and the like. */
const PROHIBITION =
  /^\s*no\b|\b(?:never|not|don['\u2019]t|doesn['\u2019]t|won['\u2019]t|mustn['\u2019]t|avoid|stop|without|forbidden|off-limits)\b/i;

/**
 * The clause list a new rule goes under until the manager picks one.
 *
 * A rule is more often a limit than a licence, and a prohibition filed under
 * "will do" admits work through the overlap gate, so a prohibition, and a
 * rule not typed yet, default to "will not do" (P8-9).
 */
export function defaultRuleClause(quote: string): ListClauseField {
  return quote.trim() === '' || PROHIBITION.test(quote) ? 'willNotDo' : 'willDo';
}

/**
 * Amend an approved charter from the card: each Save, Answer, Add or Remove
 * is one typed change and one new version. The list of versions below the
 * editors is the charter's history; nothing here edits a row in place.
 */
export function AmendCharterPanel({
  charter,
  body,
  busy,
  onAmend,
}: {
  charter: Doc<'charters'>;
  body: CharterCardBody;
  /** An amendment is in flight; the editors wait for it. */
  busy: boolean;
  /** Send one typed change; `after` runs and `focus` takes focus once it lands. Its outcome is said on the card. */
  onAmend: (change: CharterChange, after?: () => void, focus?: () => HTMLElement | null) => void;
}) {
  const ruleId = useId();
  const versions = useQuery(api.charters.listForAgent, { agentId: charter.agentId });
  const now = useNow();
  const zone = useAgentZone();
  const [rule, setRule] = useState<{
    quote: string;
    kind: CharterConstraint['kind'];
    /** The list the manager picked; until then the rule follows `defaultRuleClause`. */
    clause?: ListClauseField;
  }>({ quote: '', kind: 'candidate-property' });
  const ruleClause = rule.clause ?? defaultRuleClause(rule.quote);
  const [system, setSystem] = useState<{
    name: string;
    class: SystemClass;
    whereMentioned: string;
  }>({
    name: '',
    class: 'other',
    whereMentioned: '',
  });
  const answered = body.answeredQuestions ?? [];
  const openQuestions = managerOpenQuestions(body);
  return (
    <details className="text-xs">
      <summary className={SUMMARY}>
        Amend this charter · next version v{nextCharterVersion(charter.version)}
      </summary>
      <div className="mt-2 space-y-3 pl-3 border-l border-[var(--color-border)]">
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Proposed function
          </div>
          <EditableLine
            key={body.proposedFunction}
            text={body.proposedFunction}
            label="Proposed function"
            busy={busy}
            onSave={(text) => onAmend({ kind: 'edit-function', text })}
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
                  label={`${CLAUSE_LIST_LABEL[field]}, clause ${index + 1}`}
                  busy={busy}
                  onSave={(text) => onAmend({ kind: 'edit-clause', field, index, text })}
                  onRemove={() => onAmend({ kind: 'edit-clause', field, index, text: '' })}
                />
              ))}
              <AddLine
                label={`Add to ${CLAUSE_LIST_LABEL[field].toLowerCase()}`}
                button="Add"
                busy={busy}
                onAdd={(text, clear, input) =>
                  onAmend(
                    {
                      kind: 'edit-clause',
                      field,
                      index: body.proposedBoundaries[field].length,
                      text,
                    },
                    clear,
                    input,
                  )
                }
              />
            </div>
          </div>
        ))}
        {openQuestions.length > 0 || answered.length > 0 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              Open questions
            </div>
            <div className="space-y-1.5">
              {openQuestions.map((question) => (
                <div key={question}>
                  <AddLine
                    label={question}
                    button="Answer"
                    busy={busy}
                    onAdd={(answer, clear, input) =>
                      onAmend({ kind: 'answer-question', question, answer }, clear, input)
                    }
                  />
                </div>
              ))}
              {answered.map((entry) => (
                <p key={entry.question} className="text-[var(--color-muted)]">
                  {entry.question} <span className="text-[var(--color-fg)]">- {entry.answer}</span>
                </p>
              ))}
            </div>
          </div>
        ) : null}
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Add a rule
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <label
              htmlFor={`${ruleId}-quote`}
              className="basis-full text-[10px] text-[var(--color-muted)]"
            >
              The rule, in your own words
            </label>
            <input
              id={`${ruleId}-quote`}
              className={AMEND_INPUT}
              value={rule.quote}
              disabled={busy}
              onChange={(e) => setRule({ ...rule, quote: e.target.value })}
            />
            <label htmlFor={`${ruleId}-kind`} className="sr-only">
              What the rule limits
            </label>
            <select
              id={`${ruleId}-kind`}
              className={AMEND_INPUT}
              disabled={busy}
              value={rule.kind}
              onChange={(e) =>
                setRule({ ...rule, kind: e.target.value as CharterConstraint['kind'] })
              }
            >
              <option value="candidate-property">what work qualifies</option>
              <option value="system-boundary">where I may act</option>
              <option value="reporting-line">who I report to</option>
            </select>
            <label htmlFor={`${ruleId}-clause`} className="sr-only">
              The clause list it goes under
            </label>
            <select
              id={`${ruleId}-clause`}
              className={AMEND_INPUT}
              disabled={busy}
              value={ruleClause}
              onChange={(e) => setRule({ ...rule, clause: e.target.value as ListClauseField })}
            >
              {LIST_CLAUSE_FIELDS.map((field) => (
                <option key={field} value={field}>
                  under {CLAUSE_LIST_LABEL[field].toLowerCase()}
                </option>
              ))}
            </select>
            <button
              type="button"
              className={AMEND_BUTTON}
              disabled={busy || !rule.quote.trim()}
              onClick={() =>
                onAmend(
                  {
                    kind: 'add-constraint',
                    constraint: { kind: rule.kind, quote: rule.quote, clause: ruleClause },
                  },
                  () => setRule({ quote: '', kind: rule.kind }),
                )
              }
            >
              Add rule
            </button>
          </div>
        </div>
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Adjacent roles (work in their lane is out of scope)
          </div>
          <div className="space-y-1">
            {(body.adjacentRoles ?? []).map((role, index) => (
              <div key={`${index}:${role.who}`} className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-[var(--color-fg)]">
                  {role.who} - {role.staysOutOfTheirLaneBy}
                </span>
                <button
                  type="button"
                  className={AMEND_BUTTON}
                  disabled={busy}
                  aria-label={`Remove: ${role.who}`}
                  onClick={() =>
                    onAmend({
                      kind: 'edit-adjacent-role',
                      index,
                      role: { who: '', staysOutOfTheirLaneBy: '' },
                    })
                  }
                >
                  Remove
                </button>
              </div>
            ))}
            <AddLine
              label="Add a role, as: role - how I stay out of their lane"
              button="Add"
              busy={busy}
              onAdd={(text, clear, input) => {
                const [who, ...rest] = text.split(' - ');
                onAmend(
                  {
                    kind: 'edit-adjacent-role',
                    index: (body.adjacentRoles ?? []).length,
                    role: { who: who ?? '', staysOutOfTheirLaneBy: rest.join(' - ') },
                  },
                  clear,
                  input,
                );
              }}
            />
          </div>
        </div>
        <div>
          <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
            Systems named
          </div>
          <div className="space-y-1">
            {(body.namedSystems ?? []).map((named) => (
              <div key={named.name} className="flex items-center gap-1">
                <span className="flex-1 min-w-0 text-[var(--color-fg)]">
                  {named.name} ({named.class})
                </span>
                <button
                  type="button"
                  className={AMEND_BUTTON}
                  disabled={busy}
                  aria-label={`Remove: ${named.name}`}
                  onClick={() => onAmend({ kind: 'remove-system', name: named.name })}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-1">
              <label
                htmlFor={`${ruleId}-system`}
                className="basis-full text-[10px] text-[var(--color-muted)]"
              >
                Add a system: its name, its kind and where it is used
              </label>
              <input
                id={`${ruleId}-system`}
                className={AMEND_INPUT}
                aria-label="System name"
                value={system.name}
                disabled={busy}
                onChange={(e) => setSystem({ ...system, name: e.target.value })}
              />
              <select
                className={AMEND_INPUT}
                aria-label="System kind"
                disabled={busy}
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
                aria-label="Where it is used, in your words"
                value={system.whereMentioned}
                disabled={busy}
                onChange={(e) => setSystem({ ...system, whereMentioned: e.target.value })}
              />
              <button
                type="button"
                className={AMEND_BUTTON}
                disabled={busy || !system.name.trim() || !system.whereMentioned.trim()}
                onClick={() =>
                  onAmend({ kind: 'add-system', system }, () =>
                    setSystem({ name: '', class: 'other', whereMentioned: '' }),
                  )
                }
              >
                Add system
              </button>
            </div>
          </div>
        </div>
        {versions && versions.length > 1 ? (
          <div>
            <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
              Versions
            </div>
            <ul className="space-y-0.5 text-[var(--color-muted)]">
              {versions.map((row) => (
                <li key={row._id}>
                  v{row.version}
                  {row._id === charter._id ? ' · current' : ''}
                  {row.supersedes ? ' · amendment' : ' · from the 1:1'}
                  {' · '}
                  <span title={clockTimeWithSeconds(row.createdAt, zone)}>
                    {relativeTime(row.createdAt, now)}
                  </span>
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
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
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
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        Notes from drafting
      </div>
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
      <div className="text-[var(--color-muted)] text-[10px] uppercase tracking-wider mb-1">
        {label}
      </div>
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

/** The skills the agent proposed and the manager has not decided, each with Approve and Reject. */
export function ProposedSkillsPanel({
  skills,
  surfaces,
  onAuthoringAttempt,
  fallback,
}: {
  skills: Doc<'skills'>[];
  /** The agent's surfaces in real mode; a skill targeting one that is not
   *  connected cannot be approved yet, and the button says why. */
  surfaces: SurfaceRecord[];
  /** Approving moves the row out of this panel, so the authoring's verdict has
   *  to be reported somewhere that survives the unmount. `null` opens an
   *  attempt and retires whatever the last one said. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Where focus goes when the decided row leaves the panel: the Skills card it moves to. */
  fallback?: React.RefObject<HTMLElement | null>;
}) {
  const approve = useMutation(api.skills.approve);
  const reject = useMutation(api.skills.reject);
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const now = useNow();
  const change = useChange(fallback);

  // The approval is the manager's decision and is said here; the authoring it
  // starts runs for minutes and files its verdict with the Skills card.
  function onApprove(skill: Doc<'skills'>): void {
    const file = (reason?: string): void =>
      onAuthoringAttempt({ skillId: skill._id, name: skill.name, ...(reason ? { reason } : {}) });
    change.run(() => approve({ skillId: skill._id }), {
      done: `Approved ${skill.name}: the employee is authoring it now, and the Skills card says when it is callable.`,
      refused: `${skill.name} was not approved.`,
      after: () => {
        onAuthoringAttempt(null);
        // Discarded because both outcomes are handled here and filed as the
        // attempt the Skills card shows in its live region.
        void author({ skillId: skill._id }).then(
          (result) => file(result.ok ? undefined : (result.reason ?? 'authoring did not finish')),
          (err: unknown) => file(plainErrorMessage(errorMessage(err))),
        );
      },
    });
  }

  // The panel keeps its live region when the last row leaves it, so the
  // outcome of that decision is still said.
  if (skills.length === 0) return <LiveStatus outcome={change.outcome} />;
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
            <div key={s._id} className="border border-[var(--color-border)] rounded-lg p-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-x-2 mb-1">
                <span className="font-medium text-[var(--color-fg)] break-words">{s.name}</span>
                <span className="text-[10px] text-[var(--color-muted)]">
                  requires: {(s.requiredScopes ?? []).join(', ')}
                </span>
              </div>
              <p className="text-[var(--color-muted)] text-xs mb-2">
                {s.rationale ?? s.description}
              </p>
              {refusal ? (
                <p className="text-[10px] text-[var(--color-warn)] mb-2">
                  Cannot approve yet: {refusal}{' '}
                  <a href="#surfaces" className="underline">
                    Surfaces tab
                  </a>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  disabled={Boolean(refusal) || change.busy}
                  title={refusal}
                  onClick={() => onApprove(s)}
                  className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-xs font-medium disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-[var(--color-ok)]/20"
                >
                  Approve · author and verify
                </button>
                <button
                  type="button"
                  disabled={change.busy}
                  aria-label={`Reject ${s.name}`}
                  onClick={() =>
                    change.run(() => reject({ skillId: s._id }), {
                      done: `Rejected ${s.name}: the employee will not author it.`,
                      refused: `${s.name} was not rejected.`,
                    })
                  }
                  className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs disabled:opacity-50"
                >
                  Reject
                </button>
              </div>
            </div>
          );
        })}
        <LiveStatus outcome={change.outcome} />
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

/** The registered skills and the ones waiting on a grant, with the author's attempts. */
export function RegisteredSkillsPanel({
  skills,
  unregistered,
  authoringFailure,
  registered = null,
  onAuthoringAttempt,
  surfaceMode,
  focusRef,
  loading = false,
}: {
  skills: Doc<'skills'>[];
  /** The registered skills' query has not answered yet. */
  loading?: boolean;
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
  /** The skill the manager's last attempt registered, said once its row is registered. */
  registered?: string | null;
  /** Retries report here too, so the notice is never older than the last try. */
  onAuthoringAttempt: (attempt: AuthoringAttempt | null) => void;
  /** Real mode lists the inputs the executor binds for a skill that predates them. */
  surfaceMode?: 'mock' | 'real';
  /** Makes the card the place focus goes when a decided skill leaves the proposed panel. */
  focusRef?: React.Ref<HTMLElement>;
}) {
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  const requestRevision = useMutation(api.skills.requestRevision);
  const [retrying, setRetrying] = useState<Id<'skills'> | null>(null);
  const [returnTo, setReturnTo] = useState<HTMLElement | null>(null);
  const now = useNow();
  const describedBy = useId();

  // A retry or a revision authors for minutes, so its verdict is filed as the
  // attempt (said in the card's live region) rather than awaited by a hook.
  async function reauthor(
    skillId: Id<'skills'>,
    name: string,
    revise: boolean,
    origin: HTMLElement,
  ): Promise<void> {
    setRetrying(skillId);
    setReturnTo(origin);
    onAuthoringAttempt(null);
    try {
      if (revise) await requestRevision({ skillId });
      const result = await author({ skillId });
      onAuthoringAttempt(
        result.ok
          ? { skillId, name }
          : {
              skillId,
              name,
              reason:
                result.reason ?? (revise ? 'revision did not succeed' : 'retry did not succeed'),
            },
      );
    } catch (err) {
      onAuthoringAttempt({ skillId, name, reason: plainErrorMessage(errorMessage(err)) });
    } finally {
      setRetrying(null);
    }
  }

  // The button is disabled while its run holds it, so focus comes back to it
  // once it is enabled again, unless the manager has moved on.
  useEffect(() => {
    if (retrying !== null || returnTo === null) return;
    returnFocus(returnTo, null);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the focus return happens once per settled run
    setReturnTo(null);
  }, [retrying, returnTo]);

  return (
    <Card title={`Skills · ${skills.length} registered`} focusRef={focusRef}>
      <div role="status" aria-live="polite" aria-atomic="true">
        {authoringFailure ? (
          <p className="mb-3 p-2 rounded-md bg-[var(--color-danger)]/10 border border-[var(--color-danger)]/30 text-xs text-[var(--color-danger)]">
            Authoring did not finish: {authoringFailure}
          </p>
        ) : registered ? (
          <p className="mb-3 text-xs text-[var(--color-ok)]">
            {registered} is registered: it passed the check and is callable.
          </p>
        ) : null}
      </div>
      {loading ? (
        <p className="text-xs text-[var(--color-muted)]">loading skills…</p>
      ) : skills.length === 0 ? (
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
                {s.sourceType === 'agent-authored' ? (
                  <SkillInputs body={s.body} surfaceMode={surfaceMode} />
                ) : null}
              </div>
              {s.sourceType === 'agent-authored' ? (
                <button
                  type="button"
                  onClick={(event) => void reauthor(s._id, s.name, true, event.currentTarget)}
                  disabled={retrying === s._id}
                  title={REVISE_HINT}
                  aria-label={`Revise ${s.name}`}
                  aria-describedby={`${describedBy}-revise`}
                  className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-warn)] text-xs disabled:opacity-50 shrink-0"
                >
                  {retrying === s._id ? 'Revising…' : 'Revise'}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {skills.some((skill) => skill.sourceType === 'agent-authored') ? (
        <p id={`${describedBy}-revise`} className="mt-2 text-[10px] text-[var(--color-muted)]">
          {REVISE_HINT}
        </p>
      ) : null}

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
                    <p
                      id={`${describedBy}-${s._id}`}
                      className="text-[10px] text-[var(--color-muted)]"
                    >
                      {retryVerifiesSavedDraft(s) ? RETRY_CHECKS_HINT : RETRY_AUTHORS_HINT}
                    </p>
                    <RefusedDraftDetails skill={s} />
                  </div>
                  <button
                    type="button"
                    onClick={(event) => void reauthor(s._id, s.name, false, event.currentTarget)}
                    disabled={retrying === s._id}
                    title={retryVerifiesSavedDraft(s) ? RETRY_CHECKS_HINT : RETRY_AUTHORS_HINT}
                    aria-label={`Retry ${s.name}`}
                    aria-describedby={`${describedBy}-${s._id}`}
                    className="min-h-11 px-3 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 shrink-0"
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

/** What Revise does, beside the registered list and for its hover. */
const REVISE_HINT =
  'Discard this body and author the skill again, then verify it - open only before its first execution, while the item it was proposed for still waits for it';
/** What Retry does for a row whose draft is kept. */
const RETRY_CHECKS_HINT =
  'Run the body and smoke test this skill already has through the sandbox check - no new authoring call';
/** What Retry does for every other row. */
const RETRY_AUTHORS_HINT = 'Author this skill again, with the reason it stopped, then verify it';

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
      tabIndex={0}
      role="region"
      aria-label="Verification log"
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
          · The author used the input{plural ? 's' : ''} marked &quot;added by Day0&quot; without
          declaring {plural ? 'them' : 'it'}, so Day0 declared {plural ? 'them' : 'it'}: the
          executor reads {plural ? 'them' : 'it'} from the candidate or its runbook at run time.
        </span>
      ) : null}
      {bound.size > 0 ? (
        <span>
          {' '}
          · This skill was registered before Day0 taught the input marked &quot;bound by Day0&quot;:
          the executor binds it from the Reply target, so the reply goes to the chat surface the ask
          came from.
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
      <summary className={SUMMARY}>
        Refused draft · {files.map((file) => file.name).join(' and ')} · not registered
      </summary>
      <div className="mt-1 space-y-1">
        {files.map((file) => (
          <div key={file.name}>
            <div className="font-mono text-[10px] text-[var(--color-muted)]">{file.name}</div>
            <pre
              tabIndex={0}
              role="region"
              aria-label={`Refused ${file.name}`}
              className="text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]"
            >
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
export function CheckForNewWork({ agentId }: { agentId: Id<'agents'> }) {
  const check = useMutation(api.workLoop.checkForNewWork);
  const change = useChange();
  return (
    <div className="mb-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-[10px] text-[var(--color-muted)]">
          Connected surfaces are polled every five minutes.
        </p>
        <button
          type="button"
          disabled={change.busy}
          onClick={() =>
            change.run(() => check({ agentId }), {
              done: checkForWorkMessage,
              refused: 'The check did not start.',
            })
          }
          className="shrink-0 min-h-11 px-3 rounded-md text-[10px] border border-[var(--color-border)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {change.busy ? 'Checking…' : 'Check for new work'}
        </button>
      </div>
      <LiveStatus outcome={change.outcome} />
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
                className={`min-h-11 cursor-pointer px-2 rounded hover:bg-[var(--color-bg)] flex items-center justify-between ${
                  empty ? 'text-[var(--color-muted)]' : 'text-[var(--color-fg)]'
                }`}
              >
                <span className="font-mono">{name}</span>
                <span className="text-[10px]">{empty ? '∅' : `${content.length}b`}</span>
              </summary>
              <pre
                tabIndex={0}
                role="region"
                aria-label={name}
                className="mt-1 ml-2 text-[10px] text-[var(--color-muted)] whitespace-pre-wrap max-h-48 overflow-auto bg-[var(--color-bg)] p-2 rounded border border-[var(--color-border)]"
              >
                {empty ? '(empty)' : content}
              </pre>
            </details>
          );
        })}
      </div>
    </Card>
  );
}

// What needs the manager first: literal actions awaiting approval, then plans,
// then skills, then deferrals, which wait on a grant or a connection the manager
// gives and which the roster counts as needing them. A failed or stopped run
// waits on the manager's Retry, so it sits above the skipped rows, which wait
// on nobody.
const QUEUE_ORDER = [
  'actions-pending',
  'plan-pending',
  'needs-skill',
  'deferred',
  'discovered',
  'claimed',
  'plan-approved',
  'executing',
  'completed',
  'failed',
  'skipped',
  'cancelled',
];

/**
 * The work queue in the order the page lists it.
 *
 * Args:
 *   workItems: The employee's work items.
 *
 * Returns:
 *   A sorted copy; rows of one state keep their order.
 */
export function sortedForQueue<
  T extends {
    state: string;
    _creationTime?: number;
    priority?: string;
    evaluationAttempts?: number;
  },
>(workItems: readonly T[]): T[] {
  // The rows waiting for a free slot are listed in the order the loop takes
  // them, so the top of the queue is the next one evaluated (U3 D5).
  const waiting = (row: T) => ({ ...row, _creationTime: row._creationTime ?? 0 });
  return [...workItems].sort(
    (a, b) =>
      QUEUE_ORDER.indexOf(a.state) - QUEUE_ORDER.indexOf(b.state) ||
      (a.state === 'discovered' ? compareWaitingRows(waiting(a), waiting(b)) : 0),
  );
}

/** The employee's work items in the order that puts what needs the manager first. */
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
  loading = false,
}: {
  agentId: Id<'agents'>;
  workItems: Doc<'workItems'>[];
  /** The queue's query has not answered yet, which is not the same as an empty queue. */
  loading?: boolean;
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

  const items = useMemo(() => sortedForQueue(workItems), [workItems]);
  const queue = useRef<HTMLElement>(null);

  // One in-flight call per (step, item). Strict Mode runs every effect twice
  // on mount, and a subscription update re-runs them before the first call has
  // moved the row, so without this the same item is handed to the same action
  // several times over. Each step's claim mutation refuses the duplicate, but
  // a refusal is not a reason to keep asking.
  const inFlight = useRef(new Set<string>());
  const once = useCallback((step: string, id: string, call: () => Promise<unknown>) => {
    const key = `${step}:${id}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    call()
      // A step that fails on the row records the failure there, where the card
      // reads it. A refusal before the row is touched (the item gone, the
      // charter not approved, an ownership refusal, a claim another call
      // already holds) leaves nothing on the row and is dropped here; the
      // promise only holds the in-flight key.
      .catch((): void => undefined)
      .finally(() => inFlight.current.delete(key));
  }, []);

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
      focusRef={queue}
    >
      {surfaceMode === 'real' && charterApproved ? <CheckForNewWork agentId={agentId} /> : null}
      {loading ? (
        <p className="text-xs text-[var(--color-muted)]">loading the work queue…</p>
      ) : items.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">
          {charterApproved ? 'no work seeded yet' : 'work queue lights up after charter approval'}
        </p>
      ) : (
        <div className="space-y-3">
          <PendingDecisionsPanel
            members={pendingDecisionMembers(items)}
            surfaces={surfaces}
            onApproveBatch={(members) => approveActionsBatch({ members })}
            fallback={queue}
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
              servedByLoop={surfaceMode === 'real'}
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
  if (state === 'failed' || state === 'cancelled')
    return 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';
  if (state === 'skipped' || state === 'deferred')
    return 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]';
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
  /** The landed row this one reuses instead of sending again, and the number of the run that sent it. */
  reusedFrom?: string;
  reusedFromRun?: number;
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
  /** The charter clause the closing phase decided this step under. */
  charterClause?: CharterClauseRef;
}

/** How a clause list reads inside a sentence on the ledger. */
const CLAUSE_FIELD_PHRASE: Record<CharterClauseRef['field'], string> = {
  willDo: 'will do',
  willNotDo: 'will not do',
  escalationTriggers: 'escalation trigger',
};

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
    (index: number, position: number): boolean =>
      position === 0 || index === indexes[position - 1]! + 1,
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
  const replayOf = restore.steps.flatMap((step): string[] =>
    step.replayOf ? [step.replayOf] : [],
  );
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
  const zone = useAgentZone();
  return (
    <div className="mt-2 p-2 rounded-md bg-[var(--color-accent)]/10 border border-[var(--color-accent)]/30 text-xs">
      <p className="text-[var(--color-accent)] font-medium mb-0.5">
        {managerFeedbackLabel(feedback)}
        <span
          className="ml-1 font-normal text-[10px] text-[var(--color-muted)]"
          title={clockTimeWithSeconds(feedback.at, zone)}
        >
          {clockTimeWithSeconds(feedback.at, zone)}
        </span>
      </p>
      <p className="text-[var(--color-fg)] whitespace-pre-wrap break-words">{feedback.reason}</p>
      {feedback.addressedAt !== undefined ? (
        <p className="mt-0.5 text-[10px] text-[var(--color-muted)]">
          addressed by the run that completed {clockTimeWithSeconds(feedback.addressedAt, zone)}
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
  const blocked = (refused?.planStepOutcomes ?? []).filter(
    (outcome) => outcome.status !== 'satisfied',
  );
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
          <li
            key={outcome.step}
          >{`Step ${outcome.step} · ${outcome.status} - ${outcome.evidence}`}</li>
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
export function WithheldActionsDetails({
  withheld,
}: {
  withheld: WithheldActionRow[] | undefined;
}) {
  if (!withheld || withheld.length === 0) return null;
  const waiting = withheld.filter((row) => isWithheldForAnswer(row.reason));
  if (waiting.length > 0 && waiting.length < withheld.length) {
    return (
      <>
        <WithheldActionsDetails withheld={waiting} />
        <WithheldActionsDetails
          withheld={withheld.filter((row) => !isWithheldForAnswer(row.reason))}
        />
      </>
    );
  }
  const forAnswer = waiting.length > 0;
  return (
    <details className="mt-2 text-xs">
      <summary className="cursor-pointer text-[var(--color-muted)] hover:text-[var(--color-accent)]">
        {forAnswer ? 'Waiting on your answer' : 'Withheld by the evidence check'} ·{' '}
        {withheld.length} {withheld.length === 1 ? 'action' : 'actions'} · never sent
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
    return "These obligations no longer line up with the plan's steps, so the gates read neither and hold nothing on their account.";
  }
  return transitionWithheld(plan)
    ? 'One of the two readings leaves the state change to you, so a state change the run makes is held for your decision whatever the autonomy switch says; a retry note from you that names the state is that decision.'
    : "Neither reading leaves the state change to you, so it is not held on that account: the run follows the judgement's reading, and a state change it makes goes through the autonomy switch like any other write.";
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
        Obligations not settled: {failedOpen}. The closing gates verify no read or ticket state
        change for this plan; the closing phase still authors from the ledger.
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
        {obligations.basis === 'judgement' ? ' · judged' : " · the planner's own, unchecked"}
        {' · '}
        ticket state {transition}
        {step}
        {reads.length > 0 ? ` · ${reads.join('; ')}` : ' · no reads declared'}
      </p>
      {obligations.plannerTransition ? (
        <p className="text-[var(--color-warn)]">
          The planner declared the ticket state{' '}
          {TRANSITION_LABELS[obligations.plannerTransition] ?? obligations.plannerTransition}; the
          judgement read it as {transition}. {disagreementOutcome(steps, obligations)}
        </p>
      ) : null}
      {obligations.failedOpen ? (
        <p className="text-[var(--color-warn)]">
          The obligations judgement could not be reached ({obligations.failedOpen}); the
          planner&apos;s declaration stands unchecked.
        </p>
      ) : null}
    </div>
  );
}

/** The plan's steps beside what the run recorded for each. */
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
            {outcome.charterClause ? (
              <span className="block pl-3">
                {'under the charter clause \u201c'}
                {outcome.charterClause.text}
                {`\u201d (${CLAUSE_FIELD_PHRASE[outcome.charterClause.field]}, charter v${outcome.charterClause.charterVersion})`}
              </span>
            ) : null}
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
    return name
      ? `skill proposal "${name}" rejected by the manager`
      : 'skill proposal rejected by the manager';
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
  if (
    typeof verdict?.reason !== 'string' ||
    !verdict.reason.startsWith(CLAIMED_BY_COLLEAGUE_SKIP_PREFIX)
  ) {
    return undefined;
  }
  if (typeof holder?.agentId !== 'string' || typeof holder.name !== 'string') return undefined;
  return { agentId: holder.agentId, name: holder.name };
}

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
export function nextItemToEvaluate(
  items: readonly Doc<'workItems'>[],
): Doc<'workItems'> | undefined {
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

/** The skipped row's control: the manager gives the agent an item it set aside. */
export const TAKE_IT_ANYWAY = 'Take it anyway';

/** What Retry does on a skip no rule waives: the item is evaluated again from the start. */
export const SKIP_RETRY_NOTE =
  'Retry evaluates this item again from the start; the employee may set it aside again for the same reason.';

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
export function cancelPlanRequest(
  workItemId: Id<'workItems'>,
  reason?: string,
): { workItemId: Id<'workItems'>; reason?: string } {
  return { workItemId, ...(reason?.trim() ? { reason } : {}) };
}

/** How the reason of a run the re-read before its first write stopped begins (`withheldBeforeFirstWrite`). */
export const TICKET_REREAD_STOP = 'withheld before the first write: ';

/**
 * The row-level reason a failed item's card shows.
 *
 * A stop's own wording ("nothing landed") counts the run's writes the way the
 * stop decision does; the Retry gate counts every landed write, the manager's
 * DM included. Where the two disagree the card follows the gate, because the
 * gate is what the manager meets next.
 */
export function failedItemReason(item: {
  skipReason?: string;
  managerFeedback?: { reason: string };
  output?: {
    refusedClosing?: unknown;
    openQuestion?: unknown;
    actions?: unknown;
    applied?: unknown;
    initial?: { openQuestion?: unknown; actions?: unknown; applied?: unknown } | null;
  } | null;
  providerReconciliation?: { confirmedAt: number };
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
    const landed = retryRequiresProviderReconciliation(item.output, item.skipReason);
    const unconfirmed = landed && !item.providerReconciliation;
    // A stop at the closing gate keeps the landed prerequisites and the
    // refused set on the row; Retry resumes at the closing phase.
    if (item.output?.refusedClosing) {
      return unconfirmed
        ? `stopped at the closing gate; the prerequisites landed, so confirm them below and Retry resumes there: ${stopDetail(item.skipReason)}`
        : `stopped at the closing gate, the prerequisites landed and Retry resumes there: ${stopDetail(item.skipReason)}`;
    }
    const detail = stopDetail(item.skipReason);
    const questionOpen = Boolean(item.output?.openQuestion || item.output?.initial?.openQuestion);
    // The run asked its question and withheld the writes that wait on the answer.
    if (questionOpen && isOpenQuestionStop(detail)) {
      return unconfirmed
        ? `stopped with a question open for you, and the writes that wait on it were never sent; confirm what landed below, then answer it with Retry with a note: ${detail}`
        : `stopped with a question open for you, and the writes that wait on it were never sent; answer it with Retry with a note: ${detail}`;
    }
    // Stopped for something else while a question is open: a note on this
    // Retry answers nothing (wave 1.5 review D2 (b)), and a stop at the
    // re-read before the first write is read as the re-read (m1, O1).
    if (questionOpen) {
      const retry = detail.startsWith(TICKET_REREAD_STOP)
        ? 'retry once the ticket is back, then answer the question when it is asked again'
        : 'retry, then answer the question when it is asked again';
      return unconfirmed
        ? `stopped before its question could be answered, and a note does not answer it on this stop; confirm what landed below, then ${retry}: ${detail}`
        : `stopped before its question could be answered, and a note does not answer it on this stop; ${retry}: ${detail}`;
    }
    if (unconfirmed) {
      return `stopped after a write landed or may have; confirm the provider below before Retry: ${stopDetail(item.skipReason)}`;
    }
    return landed
      ? `stopped, a write landed before it stopped and nothing is left to decide: ${stopDetail(item.skipReason)}`
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
  const source = decision.decidedVia === 'channel' ? decision.surfaceName : 'the day0 dashboard';
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
  return Array.from(
    { length: count },
    (_, index): ActionVerdict => normaliseActionVerdict(verdicts?.[index] ?? {}),
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
  busy = false,
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
  /** A decision on this card is in flight; the controls wait for it. */
  busy?: boolean;
  /** Approve the rows; the card says what it came to in its live region. */
  onApprove: (approvedIndexes: number[]) => void;
  /** Reject the run with the manager's reason; said on the card too. */
  onReject: (reason: string) => void;
}) {
  const reasonId = useId();
  // The gate decided each row when it held the run: `auto` rows are already
  // applied and are not shown here; `refused` rows (a missing grant, an
  // unconnected surface, a forged trailer) cannot be ticked and the server
  // refuses them at approval; `held` rows are the manager's to approve. The
  // "Approve all" button is disabled while a refused row exists so it never
  // promises what the gate will not deliver.
  const refusedIndexes = useMemo(
    () =>
      new Set(
        verdicts.flatMap((verdict, index) => (verdict.disposition === 'refused' ? [index] : [])),
      ),
    [verdicts],
  );
  const heldIndexes = useMemo(
    () => verdicts.flatMap((verdict, index) => (verdict.disposition === 'held' ? [index] : [])),
    [verdicts],
  );
  const shown = useMemo(
    () =>
      actions
        .map((action, index) => ({ action, index }))
        .filter(({ index }) => verdicts[index]?.disposition !== 'auto'),
    [actions, verdicts],
  );
  const [selected, setSelected] = useState<Set<number>>(() => new Set(heldIndexes));
  const [reason, setReason] = useState('');

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
            const summary = summariseAction(action, surfaces, { replyTarget });
            return (
              <li key={index} className="flex items-start gap-2">
                <label className="flex min-h-11 min-w-11 shrink-0 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={on}
                    disabled={busy || refused}
                    onChange={(event) => toggle(index, event.target.checked)}
                    aria-label={`approve: ${summary}`}
                  />
                </label>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-[var(--color-fg)] break-words">
                    {summary}
                    {refused ? (
                      <span className="text-[var(--color-warn)]">
                        {' '}
                        · refused · {verdict.reason}
                      </span>
                    ) : verdict?.disposition === 'held' ? (
                      <span className="text-[var(--color-muted)]"> · {verdict.reason}</span>
                    ) : null}
                  </p>
                  <details className="mt-0.5">
                    <summary className="min-h-11 py-3 text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
                      exact payload
                    </summary>
                    <ActionPayload action={action} />
                  </details>
                  <RepairNote repair={repairs?.find((attempt) => attempt.index === index)} />
                  <div className="flex items-center gap-2 mt-0.5">
                    {!refused && !on ? (
                      <span className="text-[10px] text-[var(--color-muted)]">
                        held · will not be sent
                      </span>
                    ) : null}
                    {refused ? null : on ? (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, false)}
                        aria-label={`reject this action: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-danger)] underline"
                      >
                        reject this action
                      </button>
                    ) : (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => toggle(index, true)}
                        aria-label={`include: ${summary}`}
                        className="min-h-11 px-1 text-[10px] text-[var(--color-accent)] underline"
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
          onClick={() => onApprove([...selected].sort((a, b) => a - b))}
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve selected ({selected.size})
        </button>
        <button
          type="button"
          disabled={busy || anyRefused || heldIndexes.length === 0}
          title={anyRefused ? APPROVE_ALL_REFUSED : undefined}
          aria-describedby={anyRefused ? `${reasonId}-all` : undefined}
          onClick={() => onApprove(heldIndexes)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-ok)]/40 text-[var(--color-ok)] text-xs disabled:opacity-40 disabled:cursor-not-allowed"
        >
          Approve all
        </button>
        {anyRefused ? (
          <p id={`${reasonId}-all`} className="basis-full text-[10px] text-[var(--color-muted)]">
            {APPROVE_ALL_REFUSED}
          </p>
        ) : null}
        <label htmlFor={reasonId} className="basis-full text-[10px] text-[var(--color-muted)]">
          Reason for rejecting the run
        </label>
        <input
          id={reasonId}
          type="text"
          value={reason}
          disabled={busy}
          onChange={(event) => setReason(event.target.value)}
          className="min-h-11 flex-1 min-w-[10rem] px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <button
          type="button"
          disabled={busy}
          onClick={() => onReject(reason)}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
        >
          Reject run
        </button>
      </div>
    </div>
  );
}

/** Why Approve all is disabled while the gate refuses a row, beside the button and for its hover. */
const APPROVE_ALL_REFUSED =
  'A row in this run is refused by the gate and cannot be approved; approve the rest by selection.';

/** What the manager decided with the plan: the answers given, and a note to the planner's own. */
export interface PlanApproval {
  answers: Array<{ questionId: Id<'managerQuestions'>; text: string }>;
  note?: string;
  /** N11: "this would have taken me about N minutes", when the manager gave it. */
  manualEstimateMinutes?: number;
}

/**
 * What the approval form sends: the item, the answers given, the note and the
 * manager's estimate.
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
): {
  workItemId: Id<'workItems'>;
  answers?: PlanApproval['answers'];
  note?: string;
  manualEstimateMinutes?: number;
} {
  return {
    workItemId,
    ...(decision.answers.length > 0 ? { answers: decision.answers } : {}),
    ...(decision.note ? { note: decision.note } : {}),
    ...(decision.manualEstimateMinutes !== undefined
      ? { manualEstimateMinutes: decision.manualEstimateMinutes }
      : {}),
  };
}

/**
 * The minutes the manager typed into the plan card's estimate, read as the
 * server takes it: a whole number of minutes from 1, or nothing when the field
 * is empty.
 *
 * Args:
 *   typed: The field as typed.
 *
 * Returns:
 *   The minutes, undefined for an empty field, or null for text the server
 *   would refuse.
 */
export function typedEstimateMinutes(typed: string): number | undefined | null {
  const text = typed.trim();
  if (text === '') return undefined;
  if (!/^\d+$/.test(text)) return null;
  const minutes = Number(text);
  return minutes >= 1 ? minutes : null;
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
  busy = false,
}: {
  riskNotes: string;
  questions: Doc<'managerQuestions'>[];
  onApprove: (decision: PlanApproval) => void;
  /** Cancels the plan with the manager's reason, empty when none was written. */
  onCancel: (reason: string) => void;
  /** Whether a decision on this plan is in flight. */
  busy?: boolean;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [note, setNote] = useState('');
  const [cancelReason, setCancelReason] = useState('');
  const [estimate, setEstimate] = useState('');
  const open = questions.filter((question) => !question.answer);
  const planNote = riskNotes.trim();
  const minutes = typedEstimateMinutes(estimate);
  const estimateId = useId();
  function decision(): PlanApproval {
    return {
      answers: open.flatMap((question) => {
        const text = (answers[question._id] ?? '').trim();
        return text ? [{ questionId: question._id, text }] : [];
      }),
      ...(note.trim() ? { note: note.trim() } : {}),
      ...(typeof minutes === 'number' ? { manualEstimateMinutes: minutes } : {}),
    };
  }
  return (
    <div className="mt-2 space-y-2">
      {open.length > 0 ? (
        <div className="p-2 rounded-md border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/10">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {open.length === 1
              ? 'A question for you before this plan runs'
              : `${open.length} questions for you before this plan runs`}
          </p>
          <ul className="space-y-1.5">
            {open.map((question) => (
              <li key={question._id}>
                <label htmlFor={`${estimateId}-${question._id}`} className="text-[var(--color-fg)]">
                  {question.question}
                </label>
                <p className="text-[10px] text-[var(--color-muted)]">
                  from the charter · touched by the {question.context.touchedBy}
                  {question.context.words.length > 0
                    ? `: ${question.context.words.join(', ')}`
                    : ''}
                  {' · your answer is written into the charter with the approval (optional)'}
                </p>
                <input
                  id={`${estimateId}-${question._id}`}
                  type="text"
                  value={answers[question._id] ?? ''}
                  disabled={busy}
                  onChange={(event) =>
                    setAnswers((current) => ({ ...current, [question._id]: event.target.value }))
                  }
                  aria-label={`answer: ${question.question}`}
                  className="mt-0.5 min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
                />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {planNote ? (
        <div className="p-2 rounded-md border border-[var(--color-border)] bg-[var(--color-bg)]">
          <p className="text-[10px] uppercase tracking-wider text-[var(--color-muted)] mb-0.5">
            Planner&apos;s note
          </p>
          <p className="text-[var(--color-fg)]">{planNote}</p>
          <label
            htmlFor={`${estimateId}-note`}
            className="mt-1 block text-[10px] text-[var(--color-muted)]"
          >
            Your answer to the note, for this run (optional)
          </label>
          <input
            id={`${estimateId}-note`}
            type="text"
            value={note}
            disabled={busy}
            onChange={(event) => setNote(event.target.value)}
            aria-label="answer to the planner's note"
            className="min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
          />
        </div>
      ) : null}
      <div>
        <label
          htmlFor={`${estimateId}-cancel`}
          className="block text-[10px] text-[var(--color-muted)]"
        >
          Reason, if you cancel (optional)
        </label>
        <input
          id={`${estimateId}-cancel`}
          type="text"
          value={cancelReason}
          disabled={busy}
          onChange={(event) => setCancelReason(event.target.value)}
          aria-label="reason for cancelling the plan"
          className="min-h-11 w-full px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[var(--color-fg)]">
        <label htmlFor={estimateId}>This would have taken me about</label>
        <input
          id={estimateId}
          type="number"
          inputMode="numeric"
          min={1}
          step={1}
          value={estimate}
          disabled={busy}
          onChange={(event) => setEstimate(event.target.value)}
          aria-describedby={`${estimateId}-hint`}
          aria-invalid={minutes === null}
          className="min-h-11 w-20 px-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs"
        />
        <span>minutes</span>
        <span
          id={`${estimateId}-hint`}
          className="basis-full text-[10px] text-[var(--color-muted)]"
        >
          {minutes === null
            ? 'A whole number of minutes, or leave it empty.'
            : 'Optional. Summed over finished work as hours saved, a gauge for you, never a headline.'}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={() => onApprove(decision())}
          disabled={busy || minutes === null}
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs disabled:opacity-50"
        >
          {open.length > 0 || planNote ? 'Approve plan with answers' : 'Approve plan'}
        </button>
        <button
          type="button"
          onClick={() => onCancel(cancelReason.trim())}
          disabled={busy}
          className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-xs disabled:opacity-50"
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
export function pendingDecisionMembers(
  items: readonly Doc<'workItems'>[],
): PendingDecisionMember[] {
  return items.flatMap((item): PendingDecisionMember[] => {
    if (
      item.state !== 'actions-pending' ||
      !item.pendingRunId ||
      item.approvedIndexes !== undefined
    ) {
      return [];
    }
    const actions = ((item.output ?? {}) as RunOutput).actions ?? [];
    const verdicts = pendingVerdicts(item.actionVerdicts, actions.length);
    const heldIndexes = verdicts.flatMap((verdict, index) =>
      verdict.disposition === 'held' ? [index] : [],
    );
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
  fallback,
}: {
  members: PendingDecisionMember[];
  surfaces: SurfaceRecord[];
  onApproveBatch: (
    members: Array<{
      workItemId: Id<'workItems'>;
      pendingRunId: Id<'events'>;
      approvedIndexes: number[];
    }>,
  ) => Promise<unknown>;
  /** Where focus goes when the approval empties the panel: the work queue. */
  fallback?: React.RefObject<HTMLElement | null>;
}) {
  const change = useChange(fallback);
  // The panel keeps its live region when an approval empties it, so what the
  // approval came to is still said.
  if (members.length < 2) return <LiveStatus outcome={change.outcome} />;
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
                {member.refused} {member.refused === 1 ? 'row is' : 'rows are'} refused by the gate;
                decide this one on its card.
              </p>
            ) : null}
            <ul className="ml-3 space-y-0.5">
              {member.heldIndexes.map((index) => (
                <li key={index} className="text-[var(--color-fg)] break-words">
                  {summariseAction(member.actions[index], surfaces)}
                  <details className="mt-0.5">
                    <summary className="min-h-11 py-3 text-[10px] text-[var(--color-muted)] cursor-pointer select-none">
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
          disabled={change.busy || eligible.length === 0}
          onClick={() =>
            change.run(
              () =>
                onApproveBatch(
                  eligible.map((member) => ({
                    workItemId: member.workItemId,
                    pendingRunId: member.pendingRunId,
                    approvedIndexes: member.heldIndexes,
                  })),
                ),
              {
                done: `Approved ${heldCount} held ${heldCount === 1 ? 'action' : 'actions'} across ${eligible.length} ${eligible.length === 1 ? 'item' : 'items'}: they apply now.`,
                refused: 'Nothing was approved.',
              },
            )
          }
          className="min-h-11 px-3 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] text-xs font-medium disabled:opacity-50"
        >
          Approve {heldCount} held {heldCount === 1 ? 'action' : 'actions'} across {eligible.length}{' '}
          {eligible.length === 1 ? 'item' : 'items'}
        </button>
        <span className="text-[10px] text-[var(--color-muted)]">
          Each item is approved exactly as shown; if one has moved on, nothing is approved and the
          list refreshes.
        </span>
      </div>
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

/** What the waiting line reads of a row. */
type WaitingItem = Pick<
  Doc<'workItems'>,
  | 'state'
  | 'verdict'
  | 'evaluationClaimedAt'
  | 'evaluationAttempts'
  | 'evaluationUnavailableAt'
  | 'evaluationUnavailableCause'
>;

/**
 * Why a row that holds no slot is waiting, in the manager's words: for a
 * free slot, for the scope check to reach the model again (E-70 D3), or for
 * the manager's Retry after its evaluations kept dying (S D3).
 *
 * Args:
 *   item: The row, with the cause its last unreachable scope check gave.
 *   zone: The agent's zone, for the time.
 *
 * Returns:
 *   One sentence, or undefined for a row that is not waiting on the loop.
 */
export function waitingLine(item: WaitingItem, zone: string | undefined): string | undefined {
  const verdict = item.verdict as
    | { decision?: unknown; reason?: unknown; attempts?: unknown }
    | undefined;
  const attempts =
    typeof verdict?.attempts === 'number' ? verdict.attempts : (item.evaluationAttempts ?? 0);
  const cause = item.evaluationUnavailableCause;
  const because = cause ? ` (${cause})` : '';
  const unavailableAt =
    item.evaluationUnavailableAt !== undefined
      ? clockTime(item.evaluationUnavailableAt, zone)
      : undefined;
  if (item.state === 'deferred' && verdict?.reason === EVALUATION_ATTEMPTS_SPENT) {
    return `Parked: ${attempts} evaluations of this item stopped without a verdict, so it no longer takes a slot. Retry sends it back to be evaluated.`;
  }
  if (item.state === 'deferred' && verdict?.reason === 'scope-judgement-unavailable') {
    return `Waiting: the scope check could not reach the model${unavailableAt ? ` at ${unavailableAt}` : ''}${because}, ${attempts} times. Check for new work asks it again; nothing runs until it answers.`;
  }
  // A row back in `discovered` waits for a free slot whatever it was judged
  // before: Retry and a re-admission leave the old verdict on the row. Only a
  // verdict that queued it at the cap says something else, on its own line.
  if (item.state !== 'discovered' || verdict?.decision === 'queue') return undefined;
  if (
    item.evaluationUnavailableAt !== undefined &&
    item.evaluationUnavailableAt >= (item.evaluationClaimedAt ?? 0)
  ) {
    return `Waiting: the scope check could not reach the model at ${unavailableAt}${because}. Day0 tries again after ten minutes; nothing runs until it answers.`;
  }
  if (item.evaluationClaimedAt !== undefined) {
    const attempt = attempts > 1 ? `, attempt ${attempts} of ${MAX_EVALUATION_ATTEMPTS}` : '';
    return `Evaluation started ${clockTime(item.evaluationClaimedAt, zone)}${attempt}; if it does not answer, the item waits for the next free slot.`;
  }
  return 'Waiting for a free slot: Day0 evaluates the most urgent item first, then the oldest, as work finishes.';
}

/** One work item: its verdict, plan, held actions, ledger and the controls the state allows. */
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
  servedByLoop = false,
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
  onApprovePlan: (decision: PlanApproval) => Promise<unknown> | void;
  onCancelPlan: (reason: string) => Promise<unknown> | void;
  onRetryFailed: (feedback?: string) => Promise<unknown> | void;
  onReconcileFailed: (confirmed: boolean) => Promise<unknown>;
  onApproveActions: (approvedIndexes: number[]) => Promise<unknown>;
  onRejectActions: (reason: string) => Promise<unknown>;
  onResendDecision: () => Promise<unknown>;
  /** Whether the server's loop serves the queue (real mode); the mock page evaluates on its own. */
  servedByLoop?: boolean;
}) {
  const now = useNow();
  const zone = useAgentZone();
  const cardRef = useRef<HTMLDivElement>(null);
  // A decision moves the row, and the control that made it often goes with it,
  // so the outcome is said in the card's own live region and focus comes back
  // to the control when it stayed, or to the card rather than the page.
  const change = useChange(cardRef);
  const deciding = change.busy;
  const decide = (call: () => Promise<unknown> | void, done: string, refused: string): void =>
    change.run(call, { done, refused });
  const verdict = item.verdict as
    | {
        decision: string;
        reason?: string;
        suggestedSkillName?: string;
        missingSurface?: string;
        missingPermissions?: string[];
      }
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
  const refusedActions = unlandedActions.filter(
    (a) => isSurfaceTool(a.tool) && isGateRefusal(a.reason),
  );
  // A row whose response was lost, or one an interrupted apply could not
  // account for, may have landed: it is not listed as never reaching anything.
  const unknownActions = unlandedActions.filter(
    (a) =>
      !refusedActions.includes(a) &&
      (a.outcomeUnknown === true || a.reason === OUTCOME_UNKNOWN_REASON),
  );
  const failedActions = unlandedActions.filter(
    (a) => !refusedActions.includes(a) && !unknownActions.includes(a),
  );
  const landedActions = appliedActions.filter((a) => a.ok && !a.held);
  const landedAutonomously = landedActions.filter((a) => a.authority === 'autonomous').length;
  const autonomyTurnedOnAt = autonomyTurnedOnAfterDraft(
    item.planPendingAt,
    landedAutonomously > 0,
    autonomyChanges,
  );
  const reconciliationEntries =
    item.providerReconciliation?.entries ?? providerReconciliationEntries(output);
  const needsProviderReconciliation = retryRequiresProviderReconciliation(output, item.skipReason);
  const retryBlocked = needsProviderReconciliation && !item.providerReconciliation;
  // The quality-fit filter's skip is the agent's judgement, not the manager's;
  // Retry hands the item back with that filter waived.
  const skipVerdictReason =
    item.state === 'skipped' &&
    typeof (verdict as { reason?: unknown } | undefined)?.reason === 'string'
      ? (verdict as { reason: string }).reason
      : undefined;
  const qualityFitSkipped = skipVerdictReason?.startsWith(QUALITY_FIT_SKIP_PREFIX) === true;
  // The scope judgement is the agent's reading of the charter and the
  // documented systems; Retry is the manager saying the work is theirs to give.
  const outOfScopeSkipped = skipVerdictReason?.startsWith(OUT_OF_SCOPE_SKIP_PREFIX) === true;
  const skipWaivable = qualityFitSkipped || outOfScopeSkipped;
  // A skipped row's control is not a retry of a run: it hands the agent an
  // item it set aside. Named apart so the page holds one Retry when a run stops.
  const takeAnywayNote = qualityFitSkipped
    ? `${TAKE_IT_ANYWAY} re-evaluates this item without the quality-fit filter; its plan still needs your approval.`
    : outOfScopeSkipped
      ? `${TAKE_IT_ANYWAY} re-evaluates this item as in scope, on your decision; its plan still needs your approval.`
      : undefined;
  // Refused at the claim: the colleague who holds the item works it, and the
  // row comes back by itself if they let it go, so the control is the
  // colleague's card, where the manager can let it go.
  const heldByColleague = colleagueHolding(item);
  // Every other skip (a skill tried and found not to cover it, the employee's
  // own claim elsewhere, a low value) is re-evaluated by Retry: the manager
  // who disagrees always has a control (P3-1).
  const skipRetryable = item.state === 'skipped' && !skipWaivable && !heldByColleague;
  const noteToken = retryNoteToken(item);
  const [typedRetryNote, setTypedRetryNote] = useState<TypedRetryNote>({
    text: '',
    token: noteToken,
  });
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
  // Resend and Ask share one mutation; what it came to is the card's to say.
  const askAgain = (surfaceName: string): void =>
    decide(onResendDecision, `Asked again on ${surfaceName}.`, 'The request was not sent.');
  // A row that parked while no manager channel was connected was never asked;
  // once a channel is, the card can ask (the sweep also does, a lease later).
  const askableChannel =
    !item.decision &&
    (item.state === 'plan-pending' ||
      (item.state === 'actions-pending' && item.approvedIndexes === undefined))
      ? surfaces.find(
          (surface) =>
            surface.class === 'chat' &&
            !!surface.managerDmChannelId &&
            !!surface.managerUserId &&
            verdictFor(surface, now) === 'connected',
        )
      : undefined;
  // A failed item whose run landed nothing and left nothing to decide is
  // shown as stopped: Retry stands, and the badge says no harm was done.
  const shownState = item.state === 'failed' && isStopped(item.skipReason) ? 'stopped' : item.state;
  // A row whose evaluations kept dying waits for this Retry and nothing else (S D3).
  const parkedForRetry =
    item.state === 'deferred' &&
    (verdict as { reason?: unknown } | undefined)?.reason === EVALUATION_ATTEMPTS_SPENT;
  const waiting = servedByLoop ? waitingLine(item, zone) : undefined;
  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      aria-labelledby={`work-item-${item._id}`}
      className="border border-[var(--color-border)] rounded-lg p-3"
    >
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
          <h3 id={`work-item-${item._id}`} className="text-sm font-medium text-[var(--color-fg)]">
            {item.title}
          </h3>
          <p className="text-xs text-[var(--color-muted)] mt-1 line-clamp-2">
            {item.contentSummary}
          </p>
        </div>
      </div>

      {decidedFrom ? (
        <p className="mt-1 text-[10px] text-[var(--color-muted)]">{decidedFrom}</p>
      ) : null}

      {askableChannel ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-muted)]">
          <span>
            {item.state === 'plan-pending' ? 'This plan was' : 'These actions were'} not asked on{' '}
            {askableChannel.displayName} yet: they parked while no manager channel was connected.
          </span>
          <button
            type="button"
            disabled={deciding}
            onClick={() => askAgain(askableChannel.displayName)}
            className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)] disabled:opacity-50"
          >
            Ask on {askableChannel.displayName}
          </button>
        </p>
      ) : null}

      {undelivered && item.decision ? (
        <p className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-[var(--color-warn)]">
          <span>
            {item.decision.surfaceName} request not delivered
            {undelivered === 'request not delivered' ? '' : ` (${undelivered})`}
          </span>
          <button
            type="button"
            disabled={deciding}
            onClick={() => askAgain(item.decision?.surfaceName ?? 'the manager channel')}
            className="min-h-11 px-3 rounded-md border border-[var(--color-border)] text-[10px] text-[var(--color-fg)] disabled:opacity-50"
          >
            Resend
          </button>
        </p>
      ) : null}

      {waiting ? (
        <p className="mt-2 text-xs text-[var(--color-fg)]">{waiting}</p>
      ) : item.state === 'cancelled' ? (
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
          ) : verdict.decision === 'defer' && verdict.reason === 'awaiting-charter' ? (
            <span className="text-[var(--color-fg)]">
              defer - waiting for you to approve the charter; it is evaluated once you do
            </span>
          ) : verdict.decision === 'defer' &&
            verdict.reason === 'awaiting-permission' &&
            verdict.missingPermissions?.length ? (
            <span className="text-[var(--color-fg)]">
              defer - awaiting-permission: needs {verdict.missingPermissions.join(', ')}
            </span>
          ) : heldByColleague ? (
            <span className="text-[var(--color-fg)]">
              skip · another employee holds this:{' '}
              <Link
                href={`/agent/${heldByColleague.agentId}`}
                className="inline-flex min-h-11 items-center text-[var(--color-accent)] underline"
              >
                {heldByColleague.name}
              </Link>
              <span className="block text-[10px] text-[var(--color-muted)]">
                To give it to this employee instead, cancel it on {heldByColleague.name}&apos;s
                card; it comes back here by itself once they let it go.
              </span>
            </span>
          ) : (
            <span className="text-[var(--color-fg)]">
              {verdict.decision}
              {verdict.reason ? ` - ${verdict.reason}` : ''}
            </span>
          )}
        </div>
      ) : null}

      {plan ? (
        <div className="mt-3 p-2 rounded-md bg-[var(--color-bg)] border border-[var(--color-border)] text-xs">
          <div className="font-medium text-[var(--color-fg)] mb-1">
            Plan ({plan.estimatedMinutes}m, {plan.reversibility})
          </div>
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
          <PlanObligationsLine
            steps={plan.steps}
            obligations={plan.obligations}
            failedOpen={plan.obligationsFailedOpen}
          />
          {autonomyTurnedOnAt !== undefined ? (
            <p className="mt-2 text-[var(--color-ok)]">
              <time
                dateTime={new Date(autonomyTurnedOnAt).toISOString()}
                title={clockTimeWithSeconds(autonomyTurnedOnAt, zone)}
              >
                {autonomyTurnedOnAfterDraftNote(
                  clockTime(autonomyTurnedOnAt, zone),
                  landedAutonomously,
                  landedActions.length,
                )}
              </time>
            </p>
          ) : null}
          {item.state === 'plan-pending' && item.planDraftedWithout !== undefined ? (
            <p className="mt-2 text-[var(--color-warn)]">
              {draftedWithoutLine({
                system:
                  surfaces.find((surface) => surface.slug === item.planDraftedWithout?.surfaceSlug)
                    ?.displayName ?? item.planDraftedWithout.surfaceSlug,
                subject: item.planDraftedWithout.subject,
                cause: item.planDraftedWithout.cause,
              })}
            </p>
          ) : null}
          {item.state === 'plan-pending' && item.planRejectedAt !== undefined ? (
            <p className="mt-2 text-[var(--color-warn)]">
              This plan was redrafted after you rejected an earlier plan. It waits for your approval
              even while autonomous actions are on.
            </p>
          ) : null}
          {item.state === 'plan-pending' ? (
            <PlanApprovalForm
              key={item._id}
              riskNotes={plan.riskNotes ?? ''}
              questions={questions}
              busy={deciding}
              onApprove={(decision) =>
                decide(
                  () => onApprovePlan(decision),
                  `Plan approved: ${item.title}.`,
                  'The plan was not approved.',
                )
              }
              onCancel={(reason) =>
                decide(
                  () => onCancelPlan(reason),
                  `Plan cancelled: ${item.title}.`,
                  'The plan was not cancelled.',
                )
              }
            />
          ) : null}
          {item.state !== 'plan-pending' &&
          item.managerAnswers &&
          item.managerAnswers.length > 0 ? (
            <div className="mt-2 text-[var(--color-muted)]">
              <p className="text-[10px] uppercase tracking-wider mb-0.5">Answered at approval</p>
              <ul className="space-y-0.5">
                {item.managerAnswers.map((entry) => (
                  <li key={`${entry.question}:${entry.answeredAt}`}>
                    {entry.question}{' '}
                    <span className="text-[var(--color-fg)]">- {entry.answer}</span>
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
          busy={deciding}
          onApprove={(approvedIndexes) =>
            decide(
              () => onApproveActions(approvedIndexes),
              approvedIndexes.length === 0
                ? `Approved with nothing selected: ${item.title} lands nothing.`
                : `Approved ${approvedIndexes.length} ${approvedIndexes.length === 1 ? 'action' : 'actions'}: they apply now.`,
              'The actions were not approved.',
            )
          }
          onReject={(reason) =>
            decide(
              () => onRejectActions(reason),
              `Run rejected: nothing held on ${item.title} is sent.`,
              'The run was not rejected.',
            )
          }
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
                {a.reusedFrom ? (
                  <span className="ml-1 text-[10px] text-[var(--color-muted)]">
                    {a.reusedFromRun
                      ? `reused from run ${a.reusedFromRun}`
                      : 'reused from an earlier run'}
                  </span>
                ) : null}
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
                  <code className="block font-mono text-[10px] whitespace-pre-wrap break-words">
                    {a.effect}
                  </code>
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

      {unknownActions.length > 0 ? (
        <div className="mt-2 p-2 rounded-md bg-[var(--color-warn)]/10 border border-[var(--color-warn)]/30 text-xs">
          <p className="text-[var(--color-warn)] font-medium mb-1">
            {unknownActions.length} {unknownActions.length === 1 ? 'action' : 'actions'} with an
            unknown outcome · may have landed
          </p>
          <ul className="space-y-0.5 text-[var(--color-warn)]">
            {unknownActions.map((a, i) => (
              <li key={i}>
                {a.tool} - {a.reason ?? 'the response was lost'}
                <PhaseLabel phase={a.phase} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {item.state === 'failed' ||
      item.state === 'completed' ||
      skipWaivable ||
      skipRetryable ||
      parkedForRetry ||
      item.state === 'cancelled' ? (
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
              busy={deciding}
              onConfirm={() =>
                decide(
                  () => onReconcileFailed(true),
                  'Reconciliation recorded: Retry is enabled.',
                  'Could not record reconciliation.',
                )
              }
            />
          ) : null}
          {item.state === 'failed' || item.state === 'completed' || cancelledPlan ? (
            <>
              <label
                htmlFor={`retry-note-${item._id}`}
                className="block text-[10px] text-[var(--color-muted)]"
              >
                {item.state === 'completed'
                  ? 'Note for the retry: say what to change or answer what the employee asked'
                  : cancelledPlan
                    ? 'Note for the new plan (optional)'
                    : 'Note for the retry (optional): answer what the employee asked, or say what to change'}
              </label>
              <input
                id={`retry-note-${item._id}`}
                type="text"
                value={retryNote}
                disabled={deciding}
                onChange={(event) =>
                  setTypedRetryNote({ text: event.target.value, token: noteToken })
                }
                aria-label="note for the retry"
                className="min-h-11 w-full mb-1.5 px-2 rounded-md border border-[var(--color-border)] bg-transparent text-xs"
              />
            </>
          ) : null}
          <button
            type="button"
            onClick={() =>
              decide(
                () => onRetryFailed(retryNote),
                takeAnywayNote
                  ? `Taken: ${item.title} goes back to be evaluated.`
                  : `Sent back: ${item.title}.`,
                'The item was not sent back.',
              )
            }
            disabled={deciding || retryBlocked || (item.state === 'completed' && !sendingBack)}
            title={takeAnywayNote}
            className="min-h-11 px-3 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {takeAnywayNote ? TAKE_IT_ANYWAY : 'Retry'}
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
          {item.state === 'cancelled' && !cancelledPlan ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              Retry evaluates this item again from the start; if it still needs a skill, a new
              proposal comes to you.
            </p>
          ) : null}
          {cancelledPlan ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">
              {autonomousActions
                ? 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs, even while autonomous actions are on.'
                : 'Retry drafts a new plan and your reason goes with it; the plan comes back to you before anything runs.'}
            </p>
          ) : null}
          {takeAnywayNote ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">{takeAnywayNote}</p>
          ) : null}
          {skipRetryable ? (
            <p className="text-[10px] text-[var(--color-muted)] mt-1">{SKIP_RETRY_NOTE}</p>
          ) : null}
        </div>
      ) : null}
      <LiveStatus outcome={change.outcome} />
    </div>
  );
}

/** The checklist a failed run shows before a retry: confirm what landed on the provider. */
export function ProviderReconciliationControl({
  entries,
  reconciliation,
  busy = false,
  onConfirm,
}: {
  entries: readonly ReconciliationEntry[];
  reconciliation?: { actor: string; confirmedAt: number };
  /** A decision on the card is in flight; the confirmation waits for it. */
  busy?: boolean;
  /** Record the manager's confirmation; the card says what it came to. */
  onConfirm: () => void;
}) {
  const zone = useAgentZone();
  const [confirmed, setConfirmed] = useState(false);

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
          <time
            dateTime={new Date(reconciliation.confirmedAt).toISOString()}
            title={clockTimeWithSeconds(reconciliation.confirmedAt, zone)}
          >
            {clockTime(reconciliation.confirmedAt, zone)}
          </time>
          . Retry is enabled.
        </p>
      ) : (
        <>
          <label className="mt-2 flex min-h-11 items-center gap-2 text-[var(--color-fg)]">
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
            onClick={onConfirm}
            className="mt-2 min-h-11 px-3 rounded-md border border-[var(--color-warn)]/40 text-[var(--color-warn)] text-xs disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Confirm reconciliation
          </button>
        </>
      )}
    </div>
  );
}

type PermissionSource = 'deploy' | 'manager' | 'skill' | 'surface';

/** One permission scope as the panel shows it, with whether it is active. */
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

/** The permission scopes with their revoke controls. */
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
  const id = useId();
  return (
    <ul className="space-y-2 text-xs">
      {scopes.map((row) => {
        const confirming = confirmingScope === row.scope;
        const busy = busyScope !== null;
        return (
          <li key={row.scope} className="rounded-md border border-[var(--color-border)] p-2">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="font-mono text-[var(--color-fg)] break-all">{row.scope}</p>
                <p className="text-[10px] text-[var(--color-muted)]">
                  {row.active ? 'granted' : 'revoked'} - from {PERMISSION_SOURCE_LABEL[row.source]}
                </p>
              </div>
              {/* One button whose word follows the grant, so focus stays on it
                  when a revoke or a re-grant flips the row. */}
              <button
                type="button"
                id={permissionControlId(id, row.scope)}
                disabled={busy}
                aria-label={`${row.active ? 'Revoke' : 'Re-grant'} ${row.scope}`}
                aria-expanded={row.active ? confirming : undefined}
                onClick={() => (row.active ? onAskRevoke(row.scope) : onRegrant(row.scope))}
                className={`shrink-0 min-h-11 px-3 rounded border text-[10px] disabled:opacity-50 ${
                  row.active
                    ? 'border-[var(--color-danger)]/40 text-[var(--color-danger)]'
                    : 'border-[var(--color-accent)]/40 text-[var(--color-accent)]'
                }`}
              >
                {row.active ? 'Revoke' : 'Re-grant'}
              </button>
            </div>
            {confirming ? (
              <div
                role="group"
                aria-label={`Revoke ${row.scope}?`}
                className="mt-2 pt-2 border-t border-[var(--color-border)]"
              >
                <p className="text-[10px] text-[var(--color-fg)] mb-2">
                  Revoke {row.scope}? Day0 will stop queued and in-flight work that still needs this
                  standing scope at its final authority check. Actions already approved by you keep
                  their exact approval; a provider call past its final authority check may still
                  finish.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onRevoke(row.scope)}
                    className="min-h-11 px-3 rounded bg-[var(--color-danger)]/20 text-[10px] text-[var(--color-danger)] disabled:opacity-50"
                  >
                    Confirm revoke
                  </button>
                  <button
                    type="button"
                    autoFocus
                    disabled={busy}
                    onClick={() => {
                      onCancelRevoke();
                      document.getElementById(permissionControlId(id, row.scope))?.focus();
                    }}
                    onKeyDown={(event) => {
                      if (event.key !== 'Escape') return;
                      event.preventDefault();
                      onCancelRevoke();
                      document.getElementById(permissionControlId(id, row.scope))?.focus();
                    }}
                    className="min-h-11 px-3 rounded border border-[var(--color-border)] text-[10px] disabled:opacity-50"
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

/** The id of a permission row's revoke or re-grant button, unique on the page. */
function permissionControlId(list: string, scope: string): string {
  return `${list}-${scope.replace(/[^A-Za-z0-9_-]/g, '-')}`;
}

/**
 * What revoking a grant does, including the manager channel's own scope:
 * the DM to the manager is authorised by `boss:message` (or the chat
 * surface's write scope, which is never standing), and every new item needs
 * a way to reach the manager, so its evaluation waits for the grant (U3 D5).
 */
export const PERMISSIONS_NOTE =
  "Reads and manager messages stop when their grant is revoked. A literal write you approve remains authorised by that exact approval. boss:message is the manager channel's own scope: revoking it makes the channel one-way, so Day0 stops messaging you there and decisions wait on this dashboard, and new work waits until you grant it again.";

/** The employee's grants, each with its revoke or re-grant, under what revoking does. Real mode only. */
export function PermissionsCard({ agentId }: { agentId: Id<'agents'> }) {
  const scopes = useQuery(api.agents.permissionScopes, { agentId });
  const revokeScope = useMutation(api.agents.revokeScope);
  const grantScopes = useMutation(api.agents.grantScopes);
  const [confirmingScope, setConfirmingScope] = useState<string | null>(null);
  const [busyScope, setBusyScope] = useState<string | null>(null);
  const card = useRef<HTMLElement>(null);
  const control = useRef<string | null>(null);
  const change = useChange(card);

  function decide(scope: string, kind: 'revoke' | 'grant'): void {
    setBusyScope(scope);
    // The confirmation closes with the revoke, so focus goes to the row's own
    // button, which now reads Re-grant.
    control.current = document.activeElement?.closest('li')?.querySelector('button')?.id ?? null;
    change.run<unknown>(
      () =>
        kind === 'revoke'
          ? revokeScope({
              agentId,
              scope,
              reason: 'Revoked by the manager from the agent dashboard.',
            })
          : grantScopes({ agentId, scopes: [scope] }),
      {
        done:
          kind === 'revoke'
            ? `Revoked ${scope}: work that still needs it stops at its final authority check.`
            : `Granted ${scope} again.`,
        refused: kind === 'revoke' ? `${scope} was not revoked.` : `${scope} was not granted.`,
        after: () => setConfirmingScope(null),
        focus: () => (control.current ? document.getElementById(control.current) : null),
      },
    );
  }

  // Busy follows the change, so the rows wait for it and let go together.
  const pending = change.busy ? busyScope : null;
  return (
    <Card title="Permissions" focusRef={card}>
      <p className="text-[10px] text-[var(--color-muted)] mb-3 leading-relaxed">
        {PERMISSIONS_NOTE}
      </p>
      {scopes === undefined ? (
        <p className="text-xs text-[var(--color-muted)]">loading permissions…</p>
      ) : scopes.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">no permission history yet</p>
      ) : (
        <PermissionRows
          scopes={scopes}
          confirmingScope={confirmingScope}
          busyScope={pending}
          onAskRevoke={(scope) => {
            change.clear();
            setConfirmingScope(scope);
          }}
          onCancelRevoke={() => setConfirmingScope(null)}
          onRevoke={(scope) => decide(scope, 'revoke')}
          onRegrant={(scope) => decide(scope, 'grant')}
        />
      )}
      <LiveStatus outcome={change.outcome} />
    </Card>
  );
}

function metricValue(value: string | undefined): string {
  return value ?? 'loading…';
}

/** The employee's supervision figures. */
export function MetricsCard({ metrics }: { metrics: AgentMetrics | undefined }) {
  // A decision made on the dashboard is a decision whether or not a chat
  // surface was ever asked, so "not yet" means no decision at all (P6-9).
  const decisions = metrics?.decisions;
  const decided = decisions
    ? decisions.approved + decisions.rejected + decisions.partiallyApproved
    : 0;
  const humanDecisions = decisions
    ? decided === 0
      ? 'not yet'
      : `${decisions.approved} / ${decisions.rejected}`
    : undefined;
  const decidedFrom = decisions
    ? decisions.byVia.dashboard.decided + decisions.byVia.channel.decided === 0
      ? 'not yet'
      : `${decisions.byVia.dashboard.decided} / ${decisions.byVia.channel.decided}`
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
        <div className="mt-3 pt-2 border-t border-[var(--color-border)] text-[10px] text-[var(--color-muted)] leading-relaxed">
          <p>
            {metrics.decisions.requested} asked on a chat surface -{' '}
            {metrics.decisions.partiallyApproved} partial - {metrics.actions.automatic.writes}{' '}
            automatic {metrics.actions.automatic.writes === 1 ? 'change' : 'changes'} -{' '}
            {metrics.actions.held} held - {metrics.actions.refused} refused
            {metrics.actions.sessionRestores > 0
              ? ` - ${metrics.actions.sessionRestores} browser ${metrics.actions.sessionRestores === 1 ? 'call' : 'calls'} replayed to sign in again`
              : null}
          </p>
          <p>Also applied on their own: {readsAndMessages(metrics.actions.automatic)}.</p>
        </div>
      ) : null}
      {metrics ? (
        <div className="mt-3 pt-2 border-t border-[var(--color-border)]">
          <h3 className="mb-1.5 text-[10px] font-normal uppercase tracking-wider text-[var(--color-muted)]">
            Pilot figures
          </h3>
          <dl className="space-y-1.5">
            {PILOT_FIGURES.map((figure) => (
              <div
                key={figure.label}
                title={figure.definition}
                className="flex items-start justify-between gap-3 text-xs"
              >
                <dt className="basis-1/2 shrink-0 text-[var(--color-muted)] leading-tight">
                  {figure.label.toLowerCase()}
                  <span className="block text-[10px]">{figure.unit}</span>
                </dt>
                <dd className="min-w-0 font-mono text-[var(--color-fg)] text-right break-words">
                  {figure.value(metrics.pilot)}
                </dd>
              </div>
            ))}
          </dl>
          <details className="mt-1 text-[10px] text-[var(--color-muted)]">
            <summary className={SUMMARY}>What each pilot figure counts</summary>
            <dl className="space-y-1">
              {PILOT_FIGURES.map((figure) => (
                <div key={figure.label}>
                  <dt className="inline text-[var(--color-fg)]">{figure.label}: </dt>
                  <dd className="inline">{figure.definition}</dd>
                </div>
              ))}
            </dl>
          </details>
        </div>
      ) : null}
    </Card>
  );
}

/**
 * The work item an event is about, by its title, when the page lists it.
 *
 * Args:
 *   event: The stored event.
 *   titles: The employee's work item titles by id.
 *
 * Returns:
 *   The title, or undefined for an event about no listed item.
 */
export function eventItemTitle(
  event: Pick<Doc<'events'>, 'payload'>,
  titles: ReadonlyMap<string, string>,
): string | undefined {
  const workItemId = (event.payload as { workItemId?: unknown } | null | undefined)?.workItemId;
  return typeof workItemId === 'string' ? titles.get(workItemId) : undefined;
}

export function EventTicker({
  events,
  titles,
}: {
  /** The newest events, or undefined while the query loads. */
  events: Doc<'events'>[] | undefined;
  titles: ReadonlyMap<string, string>;
}) {
  const now = useNow();
  const zone = useAgentZone();
  return (
    <Card title="Live event feed">
      {events === undefined ? (
        <p className="text-xs text-[var(--color-muted)]">loading the feed…</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--color-muted)]">no events yet</p>
      ) : (
        // Focusable, so a keyboard reaches the events below the fold.
        <ul
          tabIndex={0}
          aria-label="Live event feed, newest first"
          className="space-y-1 text-[10px] font-mono max-h-72 overflow-y-auto"
        >
          {events.map((e) => {
            const title = eventItemTitle(e, titles);
            return (
              <li key={e._id} className="flex gap-2 text-[var(--color-muted)]">
                {/* Was a UTC clock beside the Slack panel's local one: the same
                  event stamped eight hours apart on one page. */}
                <time
                  dateTime={new Date(e.createdAt).toISOString()}
                  className="shrink-0 tabular-nums"
                  title={clockTimeWithSeconds(e.createdAt, zone)}
                >
                  {relativeTime(e.createdAt, now)}
                </time>
                <span className="min-w-0 break-words">
                  <span className="text-[var(--color-accent)]">{eventLabel(e)}</span>
                  {title ? <span className="text-[var(--color-fg)]"> · {title}</span> : null}
                </span>
              </li>
            );
          })}
        </ul>
      )}
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
