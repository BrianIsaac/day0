'use client';

import dynamic from 'next/dynamic';
import type { Id } from '@convex/_generated/dataModel';
import { ROOM_HEIGHT } from './room-frame';
import { useQuery, useMutation } from 'convex/react';
import { api } from '@convex/_generated/api';
import { useMemo, useState, useRef, useEffect } from 'react';
import type { SurfaceRecord } from '@/surfaces/types';
import { toSurfaceRecord } from '@/surfaces/records';
import {
  type KeptCorrection,
  keptCorrectionsTitle,
  KeptCorrectionsPanel,
} from './corrections-panel';
import type { AuthoringAttempt } from './skills/authoring';
import { type ChangeOutcome } from '../../components/use-change';
import { StatusRegion } from '../../components/StatusRegion';
import { useArrival } from '../../arrival';
import { useNow, AgentZoneContext } from './time';
import { holdsLiveAuthoringClaim } from '@/lib/skill-authoring';
import { agentZone } from '@/lib/zone';
import { DashboardHeader } from './EmployeeHeader';
import { isManagerLookupFailure } from '@/surfaces/manager-lookup';
import { connectedManagerChannel } from './manager-channel';
import { CharterCard } from './charter/CharterCard';
import { ProposedSkillsPanel } from './skills/ProposedSkillsPanel';
import { WorkQueue } from './work/WorkQueue';
import { autonomousActionsOn } from '@/work/autonomy';
import { WorkspacePanel } from './record/WorkspacePanel';
import { RegisteredSkillsPanel } from './skills/RegisteredSkillsPanel';
import { Card } from '../../components/Card';
import { PermissionsCard } from './surfaces/PermissionsCard';
import { MetricsCard } from './record/MetricsCard';
import { EventTicker } from './record/EventTicker';

interface Props {
  agentId: Id<'agents'>;
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
  // The draft the manager sent back, until the page shows what follows it.
  const [sentBack, setSentBack] = useState<Id<'charters'> | null>(null);
  const onboarding = useRef<HTMLDivElement>(null);
  const arriving = useArrival(agent !== undefined && agent !== null);
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
  const charterId = charter?._id;
  // What follows a draft sent back is the 1:1 again, or, when an approved
  // charter stands beneath the draft, that charter: only the first reopens
  // anything, so only then does the page say so and take focus. A charter
  // drafted later retires the sentence.
  useEffect(() => {
    if (sentBack !== null && onboardingShown) {
      onboarding.current?.focus();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- said once, when the 1:1 is back on the page after a draft was sent back
      setPageOutcome({ tone: 'done', text: ONBOARDING_REOPENED });
      setSentBack(null);
    } else if (sentBack !== null && charterId !== undefined && charterId !== sentBack) {
      setSentBack(null);
    } else if (sentBack === null && charterId !== undefined) {
      setPageOutcome(null);
    }
  }, [sentBack, onboardingShown, charterId]);

  if (!agent) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[var(--color-muted)]">
        loading employee…
      </div>
    );
  }

  // A drafted charter ends the 1:1, whatever the agent row still says. The
  // room stayed open under the charter it had just produced (badge reading
  // "streaming", footer reading "drafting your charter…") because both were
  // keyed to a state the chat route never moved on.
  const showOnboarding = onboardingShown;

  return (
    <AgentZoneContext value={agentZone(agent)}>
      <div className="min-h-screen px-6 py-8 max-w-7xl mx-auto">
        <DashboardHeader
          agent={agent}
          charter={charter ?? null}
          managerLookupFailure={
            (surfaceRows ?? []).find(
              (row) => row.class === 'chat' && isManagerLookupFailure(row.reason),
            )?.reason
          }
          managerChannel={connectedManagerChannel(surfaces, now) !== undefined}
        />

        <StatusRegion outcome={pageOutcome} />

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
          <div data-cards={arriving ? '' : undefined} className="lg:col-span-2 space-y-4">
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
              <CharterCard charter={charter} manager={agent.bossEmail} onSentBack={setSentBack} />
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

          <div data-cards={arriving ? '' : undefined} className="space-y-4">
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
      </div>
    </AgentZoneContext>
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
          className={`flex-1 min-h-11 px-4 py-3 rounded-lg font-medium ${
            voiceOff
              ? 'border border-[var(--color-border)] text-[var(--color-muted)] cursor-not-allowed'
              : 'bg-[var(--color-accent)] text-[var(--color-bg)] hover:opacity-90'
          }`}
        >
          Voice (ElevenLabs)
        </button>
        <button
          onClick={() => onPick('chat')}
          className={`flex-1 min-h-11 px-4 py-3 rounded-lg font-medium ${
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

/** What the page says when sending the draft back reopened the 1:1. */
const ONBOARDING_REOPENED =
  'The 1:1 is open again, so the employee can redraft the charter from what you tell it.';
