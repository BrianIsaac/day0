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
import { PageTable } from './PageTable';

/**
 * The Documentation tab (round two section 3.9, `agent-documentation.html`), as far as the
 * backend records documentation: the owner's linked sources as the table the Documentation page
 * draws, with whether this employee reads each and every control the page offers; the stored
 * pages of the source picked, with whether its newest sync read them; and the link form in the
 * real kinds. Trust per source, page status by authority with who decided it, and the relation
 * card for two pages that read as versions of one runbook wait on the documentation authority
 * records (A5) and are not drawn. The hosted office links nothing and says where its pages are.
 */
export function DocumentationView() {
  const { agent, surfaceMode, arriving } = useEmployee();
  const zone = useAgentZone();
  const sources = useQuery(api.docSources.listMine, surfaceMode === 'real' ? {} : 'skip');
  const [picked, setPicked] = useState<Id<'docSources'> | undefined>(undefined);
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
              In the hosted office {agent.name} reads the office&apos;s wiki and how-to guides, on
              the <Link href={surfaces}>Surfaces tab</Link> under Docs. Linking your own
              documentation is part of running Day0 on your own systems.
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
      <Card title="Sources" meta="linked once for all your employees">
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
      {shown ? <PageTable key={shown._id} source={shown} zone={zone} /> : null}
      <Card title="Link a location">
        <LinkSourceForm />
      </Card>
    </Columns>
  );
}
