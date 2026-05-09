'use client';

import { useState, useEffect, useMemo } from 'react';
import { useQuery, useMutation, useAction } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Doc, Id } from '@convex/_generated/dataModel';
import { ChatRoom } from './ChatRoom';
import { VoiceRoom } from './VoiceRoom';
import { MockEnvironment } from './MockEnvironment';

interface Props {
  agentId: Id<'agents'>;
}

export function AgentDashboard({ agentId }: Props) {
  const agent = useQuery(api.agents.get, { agentId });
  const charter = useQuery(api.charters.latest, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const proposedSkills = useQuery(api.skills.proposed, { agentId });
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  const events = useQuery(api.events.recent, { agentId, limit: 30 });
  const voiceSession = useQuery(api.voice.latest, { agentId });

  const [mode, setMode] = useState<'pick' | 'chat' | 'voice'>('pick');

  // Sync local mode with server state. If the boss reloaded mid-session,
  // route them back into the room they were in (voice or chat). If the
  // agent transitioned back to `deployed` (e.g. via Request Changes on
  // the charter), reset to the picker so they can choose again.
  useEffect(() => {
    if (!agent) return;
    if (agent.state === 'deployed' && mode !== 'pick') {
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

  const showOnboarding = agent.state === 'deployed' || agent.state === 'day-one-in-progress';

  return (
    <main className="min-h-screen px-6 py-8 max-w-7xl mx-auto">
      <Header agent={agent} />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-6">
        <div className="lg:col-span-2 space-y-4">
          {showOnboarding ? (
            mode === 'pick' ? (
              <ModePicker onPick={(m) => setMode(m)} />
            ) : mode === 'voice' ? (
              <VoiceRoom
                agentId={agentId}
                bossLabel={agent.bossEmail}
                onSwitchMode={() => setMode('pick')}
              />
            ) : (
              <ChatRoom
                agentId={agentId}
                bossLabel={agent.bossEmail}
                onSwitchMode={() => setMode('pick')}
              />
            )
          ) : null}

          {charter ? <CharterCard charter={charter} /> : null}

          <ProposedSkillsPanel
            agentId={agentId}
            skills={proposedSkills ?? []}
          />

          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <WorkQueue
              agentId={agentId}
              workItems={workItems ?? []}
              registeredSkillCount={(registeredSkills ?? []).length}
              charterApproved={!!charter?.approved}
            />

            <MockEnvironment agentId={agentId} />
          </div>
        </div>

        <div className="space-y-4">
          <WorkspacePanel workspace={workspace ?? {}} />
          <RegisteredSkillsPanel skills={registeredSkills ?? []} />
          <EventTicker events={events ?? []} />
        </div>
      </div>
    </main>
  );
}

function Header({ agent }: { agent: Doc<'agents'> }) {
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
  const s = stateLabel[agent.state];
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
        <span className={`px-3 py-1 rounded-full text-xs font-medium ${s.tone}`}>{s.text}</span>
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
  return (
    <Card title="Day-1 1:1 — voice or chat?" tone="accent">
      <p className="text-sm text-[var(--color-muted)] mb-4">
        I&apos;d like a few minutes to understand the role you brought me on for. Voice is faster
        (~5 min); chat is fine if you&apos;d rather type.
      </p>
      <div className="flex gap-3">
        <button
          onClick={() => onPick('voice')}
          className="flex-1 px-4 py-3 rounded-lg bg-[var(--color-accent)] text-[var(--color-bg)] font-medium hover:opacity-90"
        >
          Voice (ElevenLabs)
        </button>
        <button
          onClick={() => onPick('chat')}
          className="flex-1 px-4 py-3 rounded-lg border border-[var(--color-border)] hover:border-[var(--color-accent)]"
        >
          Chat (GPT-5.5)
        </button>
      </div>
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
}: {
  agentId: Id<'agents'>;
  skills: Doc<'skills'>[];
}) {
  const approve = useMutation(api.skills.approve);
  const reject = useMutation(api.skills.reject);
  const author = useAction(api.skillActions.authorAndRegisterSkill);
  if (skills.length === 0) return null;
  return (
    <Card title="Proposed skills · awaiting your call" tone="warn">
      <div className="space-y-3">
        {skills.map((s) => (
          <div
            key={s._id}
            className="border border-[var(--color-border)] rounded-lg p-3 text-sm"
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-medium text-[var(--color-fg)]">{s.name}</span>
              <span className="text-[10px] text-[var(--color-muted)]">requires: {(s.requiredScopes ?? []).join(', ')}</span>
            </div>
            <p className="text-[var(--color-muted)] text-xs mb-2">{s.rationale ?? s.description}</p>
            <div className="flex gap-2">
              <button
                onClick={async () => {
                  await approve({ skillId: s._id });
                  author({ skillId: s._id }).catch(() => {});
                  void agentId;
                }}
                className="px-3 py-1.5 rounded-md bg-[var(--color-ok)]/20 text-[var(--color-ok)] hover:bg-[var(--color-ok)]/30 text-xs font-medium"
              >
                Approve · author in Daytona
              </button>
              <button
                onClick={() => reject({ skillId: s._id })}
                className="px-3 py-1.5 rounded-md border border-[var(--color-border)] hover:border-[var(--color-danger)] text-xs"
              >
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function RegisteredSkillsPanel({ skills }: { skills: Doc<'skills'>[] }) {
  return (
    <Card title={`Skills · ${skills.length} registered`}>
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
            </li>
          ))}
        </ul>
      )}
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
  agentId,
  workItems,
  registeredSkillCount,
  charterApproved,
}: {
  agentId: Id<'agents'>;
  workItems: Doc<'workItems'>[];
  registeredSkillCount: number;
  charterApproved: boolean;
}) {
  const evaluate = useAction(api.workActions.evaluateWorkItem);
  const draftPlan = useAction(api.workActions.draftPlan);
  const executePlan = useAction(api.workActions.executeApprovedPlan);
  const approvePlan = useMutation(api.work.approvePlan);
  const cancelPlan = useMutation(api.work.cancelPlan);
  const retryFailed = useMutation(api.work.retryFailed);

  const items = useMemo(
    () =>
      [...workItems].sort((a, b) => {
        const order = ['plan-pending', 'needs-skill', 'discovered', 'claimed', 'plan-approved', 'executing', 'completed', 'skipped', 'cancelled', 'failed', 'deferred'];
        return order.indexOf(a.state) - order.indexOf(b.state);
      }),
    [workItems],
  );

  // Auto-progression: once charter is approved, evaluate every discovered
  // item; once a verdict comes back, draft a plan if claim, etc.
  useEffect(() => {
    if (!charterApproved) return;
    for (const it of workItems) {
      if (it.state === 'discovered') {
        evaluate({ agentId, workItemId: it._id }).catch(() => {});
        break;
      }
    }
  }, [charterApproved, workItems, agentId, evaluate]);

  useEffect(() => {
    for (const it of workItems) {
      if (it.state === 'claimed' && !it.plan) {
        draftPlan({ agentId, workItemId: it._id }).catch(() => {});
      }
      if (it.state === 'plan-approved') {
        executePlan({ agentId, workItemId: it._id }).catch(() => {});
      }
    }
  }, [workItems, agentId, draftPlan, executePlan]);

  return (
    <Card title={`Work queue · ${items.length} items · ${registeredSkillCount} skills available`}>
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
              onApprovePlan={() => approvePlan({ workItemId: item._id })}
              onCancelPlan={() => cancelPlan({ workItemId: item._id })}
              onRetryFailed={() => retryFailed({ workItemId: item._id })}
            />
          ))}
        </div>
      )}
    </Card>
  );
}

function stateColor(state: string): string {
  if (state === 'completed') return 'bg-[var(--color-ok)]/15 text-[var(--color-ok)]';
  if (state === 'plan-pending' || state === 'needs-skill') return 'bg-[var(--color-warn)]/15 text-[var(--color-warn)]';
  if (state === 'failed' || state === 'cancelled') return 'bg-[var(--color-danger)]/15 text-[var(--color-danger)]';
  if (state === 'skipped' || state === 'deferred') return 'bg-[var(--color-muted)]/15 text-[var(--color-muted)]';
  return 'bg-[var(--color-accent)]/15 text-[var(--color-accent)]';
}

function WorkItemCard({
  item,
  onApprovePlan,
  onCancelPlan,
  onRetryFailed,
}: {
  item: Doc<'workItems'>;
  onApprovePlan: () => void;
  onCancelPlan: () => void;
  onRetryFailed: () => void;
}) {
  const verdict = item.verdict as { decision: string; reason?: string; suggestedSkillName?: string } | undefined;
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
  const output = item.output as { draft: string; notes: string } | undefined;
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

      {verdict ? (
        <div className="mt-2 text-xs">
          <span className="text-[var(--color-muted)]">verdict:</span>{' '}
          <span className="text-[var(--color-fg)]">
            {verdict.decision}
            {verdict.reason ? ` — ${verdict.reason}` : ''}
          </span>
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

      {output ? (
        <details className="mt-2 text-xs">
          <summary className="cursor-pointer text-[var(--color-accent)]">
            Draft output ({output.draft.length} chars)
          </summary>
          <pre className="mt-2 p-2 rounded bg-[var(--color-bg)] border border-[var(--color-border)] whitespace-pre-wrap text-[var(--color-fg)]">
            {output.draft}
          </pre>
          {output.notes ? (
            <p className="mt-1 text-[var(--color-muted)] italic">notes: {output.notes}</p>
          ) : null}
        </details>
      ) : null}

      {item.state === 'failed' ? (
        <div className="flex gap-2 mt-2">
          <button
            onClick={onRetryFailed}
            className="px-3 py-1 rounded-md bg-[var(--color-warn)]/20 text-[var(--color-warn)] text-xs font-medium hover:bg-[var(--color-warn)]/30"
          >
            Retry
          </button>
          {item.skipReason ? (
            <span className="text-[10px] text-[var(--color-muted)] italic self-center">
              {item.skipReason.slice(0, 80)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function EventTicker({ events }: { events: Doc<'events'>[] }) {
  return (
    <Card title="Live event feed">
      <ul className="space-y-1 text-[10px] font-mono max-h-72 overflow-y-auto">
        {events.map((e) => (
          <li key={e._id} className="flex gap-2 text-[var(--color-muted)]">
            <span>{new Date(e.createdAt).toISOString().slice(11, 19)}</span>
            <span className="text-[var(--color-accent)]">{e.type}</span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
