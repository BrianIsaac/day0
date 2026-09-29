'use client';

import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { CharterAside } from './CharterAside';
import { CharterCard } from './CharterCard';

/**
 * The Charter tab: the charter the one-to-one drafted, for review while it waits on the manager
 * (`charter-review.html`) and as the record of what the employee works under once approved, with
 * its amendments (`agent-charter.html`). The transcript it was drafted from is kept beside it.
 */
export function CharterView() {
  const { agent, charter, arriving, reportSentBack } = useEmployee();
  const transcript = useQuery(
    api.charters.transcriptOf,
    charter ? { charterId: charter._id } : 'skip',
  );
  const versions = useQuery(
    api.charters.listForAgent,
    charter?.approved ? { agentId: agent._id } : 'skip',
  );
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
          transcript={transcript === undefined ? undefined : (transcript?.transcript ?? null)}
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
      />
    </Columns>
  );
}
