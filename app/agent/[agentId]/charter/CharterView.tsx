'use client';

import { useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { sameManagerAddress } from '@/agent/manager-address';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { useEmployee } from '../employee-context';
import { employeeTabHref } from '../employee-tabs';
import { AgreementsCard } from './AgreementsCard';
import { AGREEMENTS_LOADING, AGREEMENTS_META, AGREEMENTS_TITLE } from '@/work/agreement-words';
import { actorAt, CharterAside } from './CharterAside';
import { CharterCard } from './CharterCard';
import { charterActors } from './charter-actors';

/**
 * The Charter tab: the charter the one-to-one drafted, for review while it waits on the manager
 * (`charter-review.html`) and as the record of what the employee works under once approved, with
 * its amendments (`agent-charter.html`). The transcript it was drafted from is kept beside it,
 * until a handover: the old manager's words leave with them, and the tab says whose they were.
 * Beside it in real mode, the working agreements kept with it (A18).
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
  // Real mode only, as agreements are: the working agreements kept beside the charter (A18).
  const agreements = useQuery(
    api.workingAgreements.listForAgent,
    charter?.approved && surfaceMode === 'real' ? { agentId: agent._id } : 'skip',
  );
  const keepAgreement = useMutation(api.workingAgreements.keep);
  const editAgreement = useMutation(api.workingAgreements.edit);
  const retireAgreement = useMutation(api.workingAgreements.retire);
  const dismissAgreement = useMutation(api.workingAgreements.dismiss);
  const onCard = (agreementId: Id<'workingAgreements'>) => ({ agreementId, agentId: agent._id });
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
      {charter.approved && surfaceMode === 'real' && agreements === undefined ? (
        <Card title={AGREEMENTS_TITLE} meta={AGREEMENTS_META}>
          <p aria-busy="true" className="text-sm text-[var(--color-muted)]">
            {AGREEMENTS_LOADING}
          </p>
        </Card>
      ) : null}
      {agreements !== undefined ? (
        <AgreementsCard
          agreements={agreements}
          employeeName={agent.name}
          workHref={employeeTabHref(agent._id, 'work')}
          onKeepForEveryEmployee={(agreementId) =>
            keepAgreement({
              ...onCard(agreementId),
              forEveryEmployee: true,
              via: 'agreements-card',
            })
          }
          onEdit={(agreementId, statement) => editAgreement({ ...onCard(agreementId), statement })}
          onRetire={(agreementId) => retireAgreement(onCard(agreementId))}
          onDismiss={(agreementId) => dismissAgreement(onCard(agreementId))}
        />
      ) : null}
    </Columns>
  );
}
