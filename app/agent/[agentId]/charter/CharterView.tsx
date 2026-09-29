'use client';

import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { CharterCard } from './CharterCard';

/**
 * The Charter tab: the charter the one-to-one drafted, for review while it waits on the manager
 * and as the record of what the employee works under once approved, with its amendments.
 */
export function CharterView() {
  const { agent, charter, arriving, reportSentBack } = useEmployee();
  return (
    <Columns arriving={arriving} aside={<EmployeeRail />}>
      {charter ? (
        <CharterCard charter={charter} manager={agent.bossEmail} onSentBack={reportSentBack} />
      ) : (
        <Card title="Charter">
          <p className="text-sm text-[var(--color-muted)]">
            {agent.name} has no charter yet: the Day-1 one-to-one drafts it.
          </p>
        </Card>
      )}
    </Columns>
  );
}
