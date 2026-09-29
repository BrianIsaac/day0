'use client';

import { useRef, useState } from 'react';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { holdsLiveAuthoringClaim } from '@/lib/skill-authoring';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { useNow } from '../time';
import type { AuthoringAttempt } from './authoring';
import { ProposedSkillsPanel } from './ProposedSkillsPanel';
import { RegisteredSkillsPanel } from './RegisteredSkillsPanel';

/**
 * The Skills tab: the skills the employee proposed, waiting on the manager, and the ones it has,
 * with the verdict of the last authoring run the manager started from this tab.
 */
export function SkillsView() {
  const { agent, surfaceMode, surfaces, arriving } = useEmployee();
  const agentId = agent._id;
  const proposedSkills = useQuery(api.skills.proposed, { agentId });
  const registeredSkills = useQuery(api.skills.registered, { agentId });
  const unverifiedSkills = useQuery(api.skills.awaitingVerification, { agentId });
  const failedSkills = useQuery(api.skills.verificationFailed, { agentId });
  const [lastAttempt, setLastAttempt] = useState<AuthoringAttempt | null>(null);
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

  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      <ProposedSkillsPanel
        skills={proposedSkills ?? []}
        surfaces={surfaces}
        onAuthoringAttempt={setLastAttempt}
        fallback={skillsCard}
      />
      <RegisteredSkillsPanel
        skills={registeredSkills ?? []}
        unregistered={[...(unverifiedSkills ?? []), ...(failedSkills ?? [])]}
        authoringFailure={authoringFailure}
        registered={authoringRegistered}
        onAuthoringAttempt={setLastAttempt}
        surfaceMode={surfaceMode}
        focusRef={skillsCard}
        loading={registeredSkills === undefined}
      />
    </Columns>
  );
}
