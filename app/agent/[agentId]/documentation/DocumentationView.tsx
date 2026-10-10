'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Card } from '../../../components/Card';
import { Columns } from '../../../components/Columns';
import { LinkSourceForm } from '../../../documentation/LinkSourceForm';
import { SourceTable } from '../../../documentation/SourceTable';
import { useEmployee } from '../employee-context';
import { EmployeeRail } from '../EmployeeRail';
import { employeeTabHref } from '../employee-tabs';
import { useAgentZone } from '../../../components/time';
import { ConflictCard } from './ConflictCard';
import { PageTable } from './PageTable';
import { RelationAnswered, type AnsweredRelation } from './RelationAnswered';
import { RelationCard } from './RelationCard';

/**
 * The Documentation tab (round two section 3.9, `agent-documentation.html`), as far as the
 * backend records documentation: the owner's linked sources as the table the Documentation page
 * draws, with whether this employee reads each and every control the page offers; the stored
 * pages of the source picked, with whether its newest sync read them; and the link form in the
 * real kinds. Since wave 15 (A5) it also draws how far each source is trusted, each page's
 * status with who or what decided it, and a card for every relation the manager has still to
 * answer: two pages that read as versions of one runbook, or two that disagree. An answered
 * card leaves the tab, so the tab keeps the last answer where the cards are, with "Undo". The
 * hosted office links nothing and says where its pages are.
 */
export function DocumentationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const zone = useAgentZone();
  const sources = useQuery(api.docSources.listMine, surfaceMode === 'real' ? {} : 'skip');
  const relations = useQuery(api.docRelations.listOpen, surfaceMode === 'real' ? {} : 'skip');
  const [picked, setPicked] = useState<Id<'docSources'> | undefined>(undefined);
  const [answered, setAnswered] = useState<AnsweredRelation | null>(null);
  const excluded = useMemo(
    (): ReadonlySet<string> => new Set(agent.excludedDocSourceIds ?? []),
    [agent.excludedDocSourceIds],
  );
  const surfaces = employeeTabHref(agent._id, 'surfaces');
  // The picked source while it is still linked, else the first: an unlinked source's table goes.
  const shown = sources?.find((source) => source._id === picked) ?? sources?.[0];

  const aside = (
    <>
      <Card title={`What ${agent.name} reads`}>
        <p className="text-sm text-[var(--color-fg-2)]">
          {surfaceMode === 'mock' ? (
            <>
              In the hosted office {agent.name} reads the office’s wiki and how-to guides, on the{' '}
              <Link href={surfaces}>Surfaces tab</Link> under Docs. Linking your own documentation
              is part of running Day0 on your own systems.
            </>
          ) : (
            <>
              Every source you link, for all your employees, apart from any you left out when you
              deployed {agent.name}; that choice is fixed at deploy. The same table is on the{' '}
              <Link href="/documentation" prefetch={false}>
                Documentation page
              </Link>
              , and the pages {agent.name}&apos;s connections cite are on the{' '}
              <Link href={surfaces}>Surfaces tab</Link> under Docs.
            </>
          )}
        </p>
      </Card>
      <EmployeeRail />
    </>
  );

  if (surfaceMode !== 'real') {
    return (
      <Columns arriving={arriving} aside={aside}>
        <Card title="Sources">
          <p className="text-sm text-[var(--color-muted)]">
            {surfaceMode === undefined
              ? 'Loading'
              : 'The hosted office links no documentation of yours; its pages are disclosed and synthetic.'}
          </p>
        </Card>
      </Columns>
    );
  }

  return (
    <Columns arriving={arriving} aside={aside}>
      <Card
        title="Sources"
        meta="official over team over personal; within a source a page’s status decides; recency only breaks ties"
      >
        {sources === undefined ? (
          <p className="text-sm text-[var(--color-muted)]">Loading the linked locations</p>
        ) : (
          <SourceTable
            sources={sources}
            zone={zone}
            reader={{ name: agent.name, excluded }}
            pages={{ selected: shown?._id, onSelect: setPicked }}
          />
        )}
      </Card>
      {answered !== null ? (
        <RelationAnswered
          answered={answered}
          cardGone={!(relations ?? []).some((relation) => relation._id === answered.relationId)}
          onUndone={(text) => setAnswered({ relationId: answered.relationId, text, undo: false })}
        />
      ) : null}
      {(relations ?? []).map((relation) =>
        relation.kind === 'possible_conflict' ? (
          <ConflictCard
            key={relation._id}
            relation={relation}
            name={agent.name}
            onAnswered={setAnswered}
          />
        ) : (
          <RelationCard
            key={relation._id}
            relation={relation}
            name={agent.name}
            zone={zone}
            onAnswered={setAnswered}
          />
        ),
      )}
      {shown ? <PageTable key={shown._id} source={shown} zone={zone} /> : null}
      <Card title="Link a location">
        <LinkSourceForm />
      </Card>
    </Columns>
  );
}
