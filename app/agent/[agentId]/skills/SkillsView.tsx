'use client';

import { useMemo, useRef } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { holdsLiveAuthoringClaim } from '@/lib/skill-authoring';
import { Columns } from '../../../components/Columns';
import { autonomousActionsOn } from '@/work/autonomy';
import { useEmployee } from '../employee-context';
import { useNow } from '../../../components/time';
import { HowSkillsAreMade } from './HowSkillsAreMade';
import { ProposedSkillsPanel } from './ProposedSkillsPanel';
import { RegisteredSkillsPanel } from './RegisteredSkillsPanel';

/**
 * The states that settle the last authoring verdict: the row registered, was rejected or given
 * up, was retired, or was replaced by its revision. The verdict describes none of them.
 */
const VERDICT_SETTLED_STATES: ReadonlySet<string> = new Set([
  'registered',
  'rejected',
  'retired',
  'superseded',
]);

/**
 * The Skills tab (round two section 3.9): the skills the employee proposed, waiting on the
 * manager, the ones it can call, and the ones not callable yet, with the verdict of the last
 * authoring run the manager started from this tab (held by the shell, so it outlives a visit to
 * another tab), beside how a skill is made.
 */
export function SkillsView() {
  const { agent, surfaceMode, surfaces, arriving, lastAttempt, setLastAttempt } = useEmployee();
  const agentId = agent._id;
  const proposedSkills = useQuery(api.skills.proposed, { agentId });
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  const unverifiedSkills = useQuery(api.skills.awaitingVerification, { agentId });
  const failedSkills = useQuery(api.skills.verificationFailed, { agentId });
  // A revision approved and not yet being written appears in neither list above.
  const pendingRevisions = useQuery(api.skillControls.pendingRevisions, { agentId });
  const workItems = useQuery(api.work.listForAgent, { agentId });
  const itemTitles = useMemo(
    (): Map<string, string> => new Map((workItems ?? []).map((item) => [item._id, item.title])),
    [workItems],
  );
  // Ticks, so an authoring claim stops being described as live the moment it
  // stops being honoured rather than on the next thing the boss happens to do.
  const now = useNow();
  const skillsCard = useRef<HTMLElement>(null);

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
  // A run holding the skill now, a registration, a rejection, a retire and a
  // revision registering in the row's place are all facts newer than the
  // verdict, and each of them makes it a lie. A claim whose run died is none
  // of them: it is left on the row by a run that never came back, so it is
  // exactly the case the verdict is describing and must not hide it.
  const authoringFailure =
    lastAttempt?.reason !== undefined &&
    attemptedSkill &&
    !holdsLiveAuthoringClaim(attemptedSkill, now) &&
    !VERDICT_SETTLED_STATES.has(attemptedSkill.state)
      ? `${lastAttempt.name}: ${lastAttempt.reason}`
      : null;
  // A registration the manager started is said once the row says it too.
  const authoringRegistered =
    lastAttempt && lastAttempt.reason === undefined && attemptedSkill?.state === 'registered'
      ? lastAttempt.name
      : null;

  return (
    <Columns arriving={arriving} aside={<HowSkillsAreMade name={agent.name} />}>
      <ProposedSkillsPanel
        skills={proposedSkills ?? []}
        surfaces={surfaces}
        onAuthoringAttempt={setLastAttempt}
        fallback={skillsCard}
        name={agent.name}
        itemTitles={itemTitles}
      />
      <RegisteredSkillsPanel
        skills={registeredSkills ?? []}
        // An adoption in flight, stopped short or failed is drawn by the adoption card alone, whose
        // controls check the offered version again or set the offer aside first; a Retry here
        // would act on the row with the offer still on it (the wave 10 review, M3).
        unregistered={[
          ...(pendingRevisions ?? []),
          ...(unverifiedSkills ?? []),
          ...(failedSkills ?? []),
        ].filter((skill) => skill.offeredVersionId === undefined)}
        authoringFailure={authoringFailure}
        registered={authoringRegistered}
        onAuthoringAttempt={setLastAttempt}
        surfaceMode={surfaceMode}
        focusRef={skillsCard}
        loading={registeredSkills === undefined}
        employee={agent.name}
        autonomous={autonomousActionsOn(agent)}
      />
    </Columns>
  );
}
