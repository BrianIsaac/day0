'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useEffect, useMemo, useState, type ReactNode, type RefObject } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Button } from '../../components/Button';
import { Card } from '../../components/Card';
import { Columns } from '../../components/Columns';
import { useEmployee } from './employee-context';
import { employeeTabHref } from './employee-tabs';
import { RecordLines, RECENT_EVENTS } from './EmployeeRail';
import { PanelLoading, ROOM_FRAME } from './PanelLoading';

/*
 * The rooms are the page's own chunks, loaded when they mount: the voice room carries the
 * ElevenLabs SDK, which the first paint of the page does not need. The voice room also touches
 * the browser at import, so it is never rendered on the server.
 */
const ChatRoom = dynamic(() => import('./ChatRoom').then((module) => module.ChatRoom), {
  loading: () => <PanelLoading label="the 1:1" frame={ROOM_FRAME} />,
});

const VoiceRoom = dynamic(() => import('./VoiceRoom').then((module) => module.VoiceRoom), {
  ssr: false,
  loading: () => <PanelLoading label="the 1:1" frame={ROOM_FRAME} />,
});

/** How many record lines day zero lists: the deploy and what came with it. */
const DAY_ZERO_RECORD_LINES = 2;

/** How the one-to-one is being held: not yet chosen, or in one of its two rooms. */
type Room = 'pick' | 'chat' | 'voice';

/**
 * The choice of room for the Day-1 one-to-one, in the employee's first person. Voice is the
 * default where it is configured; where it is not, it is greyed out, Chat takes the primary look
 * and a line says why.
 *
 * @param onPick - Open the chosen room.
 */
export function ModePicker({ onPick }: { onPick: (mode: 'voice' | 'chat') => void }) {
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
        // The probe failing is voice being unavailable, which the picker says below.
        if (!cancelled) setVoiceConfigured(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const voiceOff = voiceConfigured === false;
  return (
    <Card title="Day-1 one-to-one: voice or chat?" tone="accent">
      <p className="mb-4 text-[15px] text-[var(--color-fg-2)]">
        I&apos;d like a few minutes to understand the role you brought me on for. Voice is faster,
        about five minutes; chat is fine if you&apos;d rather type.
      </p>
      <div className="flex flex-wrap gap-3">
        <Button
          variant={voiceOff ? 'secondary' : 'primary'}
          size="large"
          onClick={() => onPick('voice')}
          disabled={voiceOff}
          title={voiceOff ? 'ElevenLabs credentials not set on this deployment' : undefined}
          className="flex-1"
        >
          Voice
        </Button>
        <Button
          variant={voiceOff ? 'primary' : 'secondary'}
          size="large"
          onClick={() => onPick('chat')}
          className="flex-1"
        >
          Chat
        </Button>
      </div>
      {voiceOff ? (
        <p className="mt-3 text-[13px] text-[var(--color-muted)]">
          Voice is off on this deployment: no ElevenLabs credentials. Chat asks the same seven
          topics in text.
        </p>
      ) : null}
    </Card>
  );
}

/** A byte count as the page prints it: `6.9 kB`, `0.3 kB`. */
function kilobytes(bytes: number): string {
  return `${(bytes / 1000).toFixed(1)} kB`;
}

/**
 * What the employee knows before its one-to-one, in place of the panels that would all be empty:
 * who it reports to, the office it works in, its skills and its files.
 */
function WhatItKnows() {
  const { agent, surfaceMode } = useEmployee();
  const agentId = agent._id;
  const registered = useQuery(api.skills.registered, { agentId });
  const workspace = useQuery(api.workspace.read, { agentId });
  const files = Object.values(workspace ?? {});
  const office = employeeTabHref(agent._id, 'surfaces');
  const facts: ReadonlyArray<readonly [string, ReactNode]> = [
    ['Manager', agent.bossEmail],
    [
      'Office',
      surfaceMode === undefined ? (
        'loading'
      ) : surfaceMode === 'real' ? (
        <Link href={office}>your own systems, each connected only once you approve it</Link>
      ) : (
        <Link href={office}>the hosted mock office</Link>
      ),
    ],
    [
      'Skills',
      registered === undefined
        ? 'loading'
        : registered.length === 0
          ? 'none yet'
          : registered.map((skill) => skill.name).join(', '),
    ],
    [
      'Files',
      workspace === undefined
        ? 'loading'
        : `${files.filter((content) => content.trim() !== '').length} of ${files.length} written, ${kilobytes(files.reduce((total, content) => total + new TextEncoder().encode(content).length, 0))}`,
    ],
  ];
  return (
    <Card title={`What ${agent.name} knows so far`}>
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 text-sm sm:grid-cols-[max-content_minmax(0,1fr)] sm:gap-y-1.5">
        {facts.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="mt-2 text-[var(--color-muted)] first:mt-0 sm:mt-0">{label}</dt>
            <dd className="m-0 break-words text-[var(--color-fg)]">{value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/** The first lines of the record: what the deploy did. */
function DayZeroRecord() {
  const { agent } = useEmployee();
  const events = useQuery(api.events.recent, { agentId: agent._id, limit: RECENT_EVENTS });
  const titles = useMemo((): Map<string, string> => new Map(), []);
  return (
    <Card title="Record">
      {events === undefined ? (
        <p className="text-sm text-[var(--color-muted)]">Loading the record</p>
      ) : events.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">Nothing recorded yet.</p>
      ) : (
        <RecordLines events={events} titles={titles} lines={DAY_ZERO_RECORD_LINES} />
      )}
    </Card>
  );
}

/**
 * The employee page on day zero (round two section 3.3): the Day-1 one-to-one, first as the
 * choice of room and then as the room itself, beside what the employee knows so far and the
 * first lines of its record. No tabs are drawn: every one of them would be empty until the
 * charter is drafted.
 *
 * A reload mid-session goes back into the room it was in; a charter sent back returns the page
 * here with the picker.
 *
 * @param onboarding - The region the page focuses when a charter sent back reopens it.
 * @param arriving - Whether the page's cards are still arriving.
 */
export function DayZero({
  onboarding,
  arriving,
}: {
  onboarding: RefObject<HTMLDivElement | null>;
  arriving: boolean;
}) {
  const { agent } = useEmployee();
  const voiceSession = useQuery(api.voice.latest, { agentId: agent._id });
  const [room, setRoom] = useState<Room>('pick');

  // Sync the room with the server. Two cases:
  //   1. Reload mid-session: route back into the room they were in
  //      (uses the voiceSession row to figure out which).
  //   2. Request Changes on the charter: agent.state flips back to
  //      `deployed` AND a prior voiceSession exists. Reset to picker.
  // The `voiceSession` guard is critical: without it, the moment a fresh
  // user picks a room (state is still `deployed`, room flips off `pick`)
  // this effect would race the user's click and snap them back to picker.
  //
  // This resync stays an effect on purpose. Deriving the room cannot express
  // case 2 (the boss's own pick has to be discarded when the server moves
  // underneath it), and resetting via a subtree `key` would remount
  // `ChatRoom`, whose mount effect opens a voice session, so every state
  // transition would start a duplicate 1:1.
  useEffect(() => {
    if (agent.state === 'deployed' && room !== 'pick' && voiceSession) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the server moved the 1:1 back under the manager's pick
      setRoom('pick');
      return;
    }
    if (agent.state === 'day-one-in-progress' && room === 'pick' && voiceSession) {
      setRoom(voiceSession.mode === 'chat' ? 'chat' : 'voice');
    }
  }, [agent.state, voiceSession, room]);

  return (
    <Columns
      arriving={arriving}
      aside={
        <>
          <WhatItKnows />
          <DayZeroRecord />
        </>
      }
    >
      <div
        ref={onboarding}
        tabIndex={-1}
        role="region"
        aria-label="The 1:1 that drafts the charter"
      >
        {room === 'pick' ? (
          <ModePicker onPick={setRoom} />
        ) : room === 'voice' ? (
          <VoiceRoom
            agentId={agent._id}
            bossLabel={agent.bossEmail}
            onSwitchMode={() => setRoom('chat')}
          />
        ) : (
          <ChatRoom
            agentId={agent._id}
            bossLabel={agent.bossEmail}
            onSwitchMode={() => setRoom('voice')}
          />
        )}
      </div>
    </Columns>
  );
}
