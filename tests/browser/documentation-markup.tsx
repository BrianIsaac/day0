import { useRef, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConvexProvider, type ConvexReactClient } from 'convex/react';
import { Card } from '../../app/components/Card';
import { Columns } from '../../app/components/Columns';
import { useChange } from '../../app/components/use-change';
import { SourceTable, TRUST_HELP, type LinkedSource } from '../../app/documentation/SourceTable';
import {
  RelationCard,
  type RelationCardRow,
} from '../../app/agent/[agentId]/documentation/RelationCard';
import { PageRows, type PageRow } from '../../app/agent/[agentId]/documentation/PageTable';
import { RelationAnswered } from '../../app/agent/[agentId]/documentation/RelationAnswered';
import { LinkSourceForm } from '../../app/documentation/LinkSourceForm';

/**
 * Print the Documentation tab's main column as the review's bed 3 drew it (W15-R50): the Sources
 * card with the company folder and the five readers' sources linked, two relation cards, and the
 * company folder's fourteen pages as 16-s's bed stored them (the tile runbook's second version
 * among them, whose title is the longest a page's successor select offers), in the tab's own
 * columns, for
 * the browser job to mount under the build's stylesheet at a phone's width
 * (`documentation-width.spec.ts`). The tab needs a backend the job does not hold, so its parts are
 * rendered from the components here, in their own process under `tsx`, as
 * `first-week-markup.ts` renders the week. The cards' controls only build their calls while they
 * render, so the Convex context they read is given a client that is never called.
 *
 * Asked for `answered` (the first argument), it prints the column as it stands once a card was
 * answered (wave 17, 17-FD; `documentation-tab.spec.ts`): "Your answer" where the card was, a
 * successor proposed by its pages' dates and a duplicate one of whose pages has only the time it
 * was read, the pages, and the form that links a location.
 */

/** A linked source as `docSources.listMine` lists it, synced. */
function source(
  id: string,
  kind: LinkedSource['kind'],
  label: string,
  locator: string,
  pageCount: number,
): LinkedSource {
  return {
    _id: id,
    _creationTime: 1,
    userId: 'owner',
    label,
    kind,
    locator,
    status: 'synced',
    lastSyncAt: Date.UTC(2026, 9, 11, 14, 5),
    lastCompletedSyncId: `run-${id}`,
    createdAt: 1,
    updatedAt: 1,
    pageCount,
    ...(kind === 'folder' ? {} : { credentialId: `credential-${id}` }),
  } as unknown as LinkedSource;
}

/** The company folder and the five readers' sources, with the locations bed 3 linked. */
const SOURCES: readonly LinkedSource[] = [
  {
    ...source('folder', 'folder', 'Company folder', '.', 14),
    // Discovery and the people extraction fail alike on a bed with no model behind its route.
    lastDiscoveryError:
      'the model route answered 404 at http://redactor:8000/v1/chat/completions?model=day0-discovery-default',
    lastPeopleExtractionError:
      'the model route answered 404 at http://redactor:8000/v1/chat/completions?model=day0-discovery-default',
  } as LinkedSource,
  source(
    'confluence-cloud',
    'confluence-v2',
    'Ops wiki (Cloud)',
    'https://acme.atlassian.net/wiki/spaces/OPS/overview',
    3,
  ),
  source(
    'confluence-dc',
    'confluence-dc',
    'Ops wiki (Data Center)',
    'https://wiki.acme.corp/confluence/spaces/OPS/overview',
    3,
  ),
  source(
    'sharepoint',
    'sharepoint',
    'Runbooks site',
    'https://acme.sharepoint.com/sites/Runbooks/Shared%20Documents/Forms/AllItems.aspx',
    3,
  ),
  source(
    'yuque',
    'yuque',
    'RevOps runbooks',
    'https://acme.yuque.com/revops/runbooks/close-the-quarter',
    3,
  ),
  {
    ...source(
      'drive',
      'drive',
      'Runbooks folder',
      'https://drive.google.com/drive/u/0/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz012345?usp=sharing',
      3,
    ),
    status: 'error',
    lastError:
      'https://www.googleapis.com/drive/v3/files?q=%271AbCdEfGhIjKlMnOpQrStUvWxYz012345%27+in+parents answered 403',
  } as LinkedSource,
];

/** A proposal between two of the readers' pages of one title, as bed 3's fixtures held them. */
function proposal(id: string, from: string, to: string): RelationCardRow {
  const page = (source: string, updatedAt: number) => ({
    sourceId: `source-${source}`,
    ref: `${source}/运维手册`,
    title: '运维手册',
    source,
    updatedAt,
    edited: true,
    authority: 'team',
  });
  return {
    _id: id,
    kind: 'possible_duplicate',
    status: 'proposed',
    from: page(from, Date.UTC(2026, 9, 11, 9, 0)),
    to: page(to, Date.UTC(2026, 9, 10, 9, 0)),
    evidence: [{ measure: 'shared-text', value: 100 }],
    offered: ['supersedes', 'keep-both', 'not-the-same'],
  } as unknown as RelationCardRow;
}

/** The company folder's pages with the second version of the tile runbook 16-s's bed added (F3). */
const COMPANY_PAGES: ReadonlyArray<readonly [string, string]> = [
  ['finance/handbook.md', 'Finance close handbook'],
  ['finance/runbooks/close-status-note.md', 'How to write the close status note'],
  ['logistics/handbook.md', 'Logistics desk handbook'],
  ['logistics/runbooks/exception-note.md', 'How to record a shipment exception'],
  ['onboarding.md', 'Kestrel Supply onboarding'],
  ['revops/handbook.md', 'Revenue operations handbook'],
  ['revops/runbooks/how-to-post-slack.md', 'How to post to Slack'],
  ['revops/runbooks/how-to-refresh-the-tile.md', 'How to refresh the Looker pipeline tile'],
  ['revops/runbooks/how-to-update-ticket.md', 'How to update a Linear ticket'],
  ['revops/runbooks/q3-close-checklist.md', 'Q3 close checklist'],
  ['systems/looker-pipeline-tile.md', 'Looker pipeline tile'],
  ['systems/netledger.md', 'NetLedger'],
  ['systems/northstar-crm.md', 'Northstar CRM'],
  [
    'revops/runbooks/how-to-refresh-the-tile-v2.md',
    'How to refresh the Looker pipeline tile, version 2',
  ],
];

/** The company folder's pages as `docPages.listForSource` lists them. */
const PAGES: readonly PageRow[] = COMPANY_PAGES.map(
  ([ref, title], index) =>
    ({
      _id: `page-${index}`,
      ref,
      title,
      updatedAt: Date.UTC(2026, 9, 12, 8, 5),
      status: 'active',
      statusSource: 'default',
    }) as unknown as PageRow,
);

/** The page table's rows, with the change reporter the table shares. */
function Pages(): ReactNode {
  const table = useRef<HTMLDivElement>(null);
  const change = useChange(table);
  return (
    <Card title="Pages · Company folder" meta={`${PAGES.length} stored`}>
      <div ref={table} className="grid gap-3">
        <PageRows pages={PAGES} allNamed zone="UTC" change={change} />
      </div>
    </Card>
  );
}

/** A client the context holds and nothing calls: the markup is printed, never pressed. */
const UNCALLED = {} as ConvexReactClient;

/**
 * The company folder's runbook and its team copy, as 16-FD's bed dated them, three days apart.
 *
 * @param copyDated - Whether the copy's source dated it; false, Day0 holds only when it read it.
 */
function copies(id: string, copyDated: boolean): RelationCardRow {
  const page = (title: string, source: string, updatedAt: number, dated: boolean) => ({
    sourceId: `source-${source}`,
    ref: `${source}/${title}`,
    title,
    source,
    updatedAt,
    edited: dated,
    dated,
    authority: 'team',
  });
  return {
    _id: id,
    kind: copyDated ? 'possible_successor' : 'possible_duplicate',
    status: 'proposed',
    from: page(
      'Refreshing the pipeline tile (team copy)',
      copyDated ? 'Company folder' : 'Team pages',
      Date.UTC(2026, 9, 10, 11, 15),
      copyDated,
    ),
    to: page(
      'How to refresh the Looker pipeline tile',
      'Company folder',
      Date.UTC(2026, 9, 7, 11, 15),
      true,
    ),
    evidence: [
      { measure: 'shared-text', value: 60 },
      ...(copyDated ? [{ measure: 'edit-dates', value: 3 }] : []),
    ],
    offered: ['supersedes', 'keep-both', 'not-the-same'],
  } as unknown as RelationCardRow;
}

/** The column once a card was answered: the answer, two cards still to answer, the pages, the form. */
function Answered(): ReactNode {
  return (
    <Columns aside={null}>
      <Card title="Sources" meta={TRUST_HELP}>
        <SourceTable
          sources={SOURCES}
          zone="UTC"
          reader={{ name: 'Priya', excluded: new Set<string>() }}
          pages={{ selected: 'folder' as never, onSelect: (): void => undefined }}
        />
      </Card>
      <RelationAnswered
        answered={{
          relationId: 'relation-answered' as never,
          text: '“运维手册” now supersedes “运维手册”.',
          undo: true,
        }}
        cardGone
        onUndone={(): void => undefined}
      />
      <RelationCard relation={copies('relation-dated', true)} zone="UTC" />
      <RelationCard relation={copies('relation-undated', false)} zone="UTC" />
      <Pages />
      <Card title="Link a location">
        <LinkSourceForm />
      </Card>
    </Columns>
  );
}

process.stdout.write(
  renderToStaticMarkup(
    <ConvexProvider client={UNCALLED}>
      {process.argv[2] === 'answered' ? (
        <Answered />
      ) : (
        <Columns aside={null}>
          <Card title="Sources" meta={TRUST_HELP}>
            <SourceTable
              sources={SOURCES}
              zone="UTC"
              reader={{ name: 'Priya', excluded: new Set<string>() }}
              pages={{ selected: 'folder' as never, onSelect: (): void => undefined }}
            />
          </Card>
          <RelationCard
            relation={proposal('relation-1', 'Ops wiki (Cloud)', 'RevOps runbooks')}
            zone="UTC"
          />
          <RelationCard
            relation={proposal('relation-2', 'Runbooks site', 'Runbooks folder')}
            zone="UTC"
          />
          <Pages />
        </Columns>
      )}
    </ConvexProvider>,
  ),
);
