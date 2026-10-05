'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { sameManagerAddress } from '@/agent/manager-address';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { actorAt, CharterAside } from './CharterAside';
import { CharterCard } from './CharterCard';
import { charterActors } from './charter-actors';

/**
 * The Charter tab: the charter the one-to-one drafted, for review while it waits on the manager
 * (`charter-review.html`) and as the record of what the employee works under once approved, with
 * its amendments (`agent-charter.html`). The transcript it was drafted from is kept beside it,
 * until a handover: the old manager's words leave with them, and the tab says whose they were.
 */
export function CharterView() {
  const { agent, charter, arriving, reportSentBack, surfaceMode } = useEmployee();
  const oneToOne = useQuery(
    api.charters.transcriptOf,
    charter ? { charterId: charter._id } : 'skip',
  );
  const versions = useQuery(
    api.charters.listForAgent,
    charter?.approved ? { agentId: agent._id } : 'skip',
  );
  const earlier = useQuery(
    api.managerTransfers.earlierManagers,
    charter?.approved ? { agentId: agent._id } : 'skip',
  );
  // Who acted before a handover is named, never "you" for the earlier manager.
  const actor = (at: number): string => actorAt(at, earlier, agent.bossEmail);
  if (!charter) {
    return (
      <Columns arriving={arriving}>
        <Card title="Charter">
          <p className="text-sm text-[var(--color-muted)]">
            {agent.name} has no charter yet: the Day-1 one-to-one drafts it.
          </p>
        </Card>
      </Columns>
    );
  }
  return (
    <Columns
      arriving={arriving}
      aside={
        <CharterAside
          charter={charter}
          name={agent.name}
          transcript={
            oneToOne === undefined
              ? undefined
              : oneToOne !== null && 'transcript' in oneToOne
                ? oneToOne.transcript
                : null
          }
          heldBy={
            oneToOne !== undefined && oneToOne !== null && 'heldBy' in oneToOne
              ? {
                  address: oneToOne.heldBy,
                  yours: sameManagerAddress(oneToOne.heldBy, agent.bossEmail),
                }
              : undefined
          }
          actor={actor}
          versions={versions}
          onSentBack={reportSentBack}
        />
      }
    >
      <CharterCard
        charter={charter}
        manager={agent.bossEmail}
        name={agent.name}
        autonomous={agent.autonomousActions === true}
        pageDrivesWork={surfaceMode === 'mock'}
        approvedBy={charter.approvedAt === undefined ? 'you' : actor(charter.approvedAt)}
        actors={charterActors(versions, actor, charter.approvedAt ?? charter.createdAt)}
      />
    </Columns>
  );
}
