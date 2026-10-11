'use client';

import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAction, useMutation } from 'convex/react';
import type { FunctionReturnType } from 'convex/server';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { Button } from '../components/Button';
import { Chip } from '../components/Chip';
import { INPUT_CLASS } from '../components/Field';
import { StatusRegion } from '../components/StatusRegion';
import { useChange } from '../components/use-change';
import { sourceStatus } from './source-status';
import { SOURCE_AUTHORITIES, sourceAuthorityOf, type SourceAuthority } from '@/docs/authority';

/** How each trust is named in the Trust select (the wave file's section 8). */
export const TRUST_NAMES: Readonly<Record<SourceAuthority, string>> = {
  official: 'Official',
  team: 'Team',
  personal: 'Personal',
};

/**
 * What the Trust select means, under it where there is room to say so. Trust weighs the ranking
 * (`AUTHORITY_WEIGHT`); it is no rule that one source's page always wins.
 */
export const TRUST_HELP =
  'Official is weighed above team, and team above personal, when pages answer alike. A page that is not current is read from no source; recency only breaks ties.';

/** One linked source as `docSources.listMine` lists it, with its stored page count. */
export type LinkedSource = FunctionReturnType<typeof api.docSources.listMine>[number];

/** How each kind of location is named in the table. */
const KIND_NAMES: Readonly<Record<LinkedSource['kind'], string>> = {
  folder: 'Folder',
  git: 'Git',
  urls: 'URLs',
  mcp: 'MCP server',
  feishu: 'Feishu',
  sharepoint: 'SharePoint',
  'confluence-v2': 'Confluence Cloud',
  'confluence-dc': 'Confluence Data Center',
  yuque: 'Yuque',
  drive: 'Google Drive',
};

/**
 * What the rotate field asks for: an MCP server's connection secret, a Feishu app's ID and
 * secret in the one field, the secret one of wave 15's readers takes (in the one field, in the
 * shape its reader reads), or another source's reader secret.
 *
 * @param kind - The source's kind.
 */
function rotateFieldName(kind: LinkedSource['kind']): string {
  switch (kind) {
    case 'mcp':
      return 'New connection secret';
    case 'feishu':
      return 'New app ID and secret, as app ID:secret';
    case 'sharepoint':
      return 'New app registration, as tenant ID:client ID:client secret';
    case 'confluence-v2':
      return 'New API token';
    case 'confluence-dc':
      return 'New personal access token';
    case 'yuque':
      return 'New token';
    case 'drive':
      return 'New service account key, the JSON file’s contents';
    case 'folder':
    case 'git':
    case 'urls':
      return 'New reader secret';
  }
}

/** The employee whose reading the table shows beside each source, on its Documentation tab. */
export interface SourceReader {
  readonly name: string;
  /** The sources the manager left out when the employee was deployed. */
  readonly excluded: ReadonlySet<string>;
}

/** The source whose pages the table beside it lists, and how to pick another. */
export interface PageSelection {
  readonly selected: Id<'docSources'> | undefined;
  readonly onSelect: (sourceId: Id<'docSources'>) => void;
}

/**
 * The second step of a destructive change to a linked source (P6-7): what it
 * does, the change, and Keep, which takes focus so Enter does nothing harmful.
 *
 * @param props - What is being confirmed, for which source, and the two choices.
 * @returns The confirmation under the source.
 */
export function SourceConfirmation(props: {
  kind: 'unlink' | 'revoke';
  label: string;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}): ReactNode {
  const unlinking = props.kind === 'unlink';
  return (
    <div
      role="group"
      aria-label={unlinking ? `Unlink ${props.label}?` : `Revoke the secret for ${props.label}?`}
      className="grid gap-2 text-sm"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        props.onKeep();
      }}
    >
      <p className="text-[var(--color-fg)]">
        {unlinking
          ? `Unlink ${props.label}? Its pages leave every employee's reading, and the systems only it documents lose their evidence.`
          : `Revoke the secret for ${props.label}? Day0 stops reading this location until you rotate in a new secret.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button variant="danger" size="small" disabled={props.busy} onClick={props.onConfirm}>
          {unlinking ? 'Confirm unlink' : 'Confirm revoke'}
        </Button>
        <Button size="small" autoFocus disabled={props.busy} onClick={props.onKeep}>
          {unlinking ? 'Keep it linked' : 'Keep the secret'}
        </Button>
      </div>
    </div>
  );
}

/** One cell, with the label a stacked row prints above its value on a phone. */
function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <td role="cell" className="px-3 py-3 align-top max-sm:p-0">
      {/* The header carries the same word for assistive technology; this copy is visual only. */}
      <span aria-hidden="true" className="mb-1 block text-xs text-[var(--color-muted)] sm:hidden">
        {label}
      </span>
      {children}
    </td>
  );
}

/**
 * The owner's linked documentation sources as a table that stacks on a phone (round two section
 * 3.9): each source with its kind, location, stored pages and sync state, and its controls
 * (Re-sync; Rotate and Revoke for a source with a secret; Unlink, which asks first). On an
 * employee's Documentation tab it also says whether that employee reads each source and picks the
 * source the page table lists. Every change is said in one live region and focus comes back to
 * the control, or to the table when the row went with the change.
 *
 * @param sources - The owner's sources.
 * @param zone - The zone times are said in.
 * @param reader - The employee whose reading is shown, on its tab.
 * @param pages - The page table's source and how to pick another, on the tab.
 */
export function SourceTable({
  sources,
  zone,
  reader,
  pages,
}: {
  sources: readonly LinkedSource[];
  zone?: string;
  reader?: SourceReader;
  pages?: PageSelection;
}): ReactNode {
  const rotateCredential = useAction(api.docSources.rotateCredential);
  const revokeCredential = useMutation(api.credentials.revoke);
  const unlink = useMutation(api.docSources.unlink);
  const resync = useMutation(api.docSources.resync);
  const setAuthority = useMutation(api.docStatus.setSourceAuthority);
  const [rotatingSourceId, setRotatingSourceId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    sourceId: Id<'docSources'>;
    kind: 'unlink' | 'revoke';
  } | null>(null);
  const list = useRef<HTMLElement>(null);
  const change = useChange(list);
  // Which source's rotation is in flight, so only its Save reads Rotating.
  const [rotating, setRotating] = useState<string | null>(null);

  /**
   * One change to one linked source, said in the table's live region. A
   * confirmation closes once the change lands, so a refusal leaves it open
   * with focus on the control that met it; focus then goes to the row's own
   * control, or to the table when the row went with the change.
   */
  function onSourceChange(
    call: () => Promise<unknown>,
    words: { done: string; refused: string; after?: () => void; focus?: () => HTMLElement | null },
  ): void {
    change.run(call, {
      ...words,
      after: () => {
        setConfirming(null);
        words.after?.();
      },
    });
  }

  /** Rotate one source credential and clear its write-only input immediately. */
  function onRotate(event: FormEvent<HTMLFormElement>, source: LinkedSource): void {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = String(new FormData(form).get('credential') || '');
    form.reset();
    setRotating(source._id);
    onSourceChange(
      async (): Promise<void> => {
        try {
          await rotateCredential({ sourceId: source._id, credential });
        } finally {
          setRotating(null);
        }
      },
      {
        done: `The secret for ${source.label} is replaced; the next sync reads with it.`,
        refused: 'The secret was not replaced.',
        after: () => setRotatingSourceId(null),
        focus: () => document.getElementById(`rotate-control-${source._id}`),
      },
    );
  }

  const columns = [
    'Source',
    'Trust',
    'Pages',
    'Status',
    ...(reader ? [`Read by ${reader.name}`] : []),
  ];
  return (
    <section ref={list} tabIndex={-1} aria-label="Linked documentation" className="grid gap-3">
      <StatusRegion outcome={change.outcome} />
      {sources.length === 0 ? (
        <p className="text-sm text-[var(--color-muted)]">No locations linked yet.</p>
      ) : (
        <table role="table" className="w-full text-left text-sm max-sm:block">
          <thead role="rowgroup" className="max-sm:sr-only">
            <tr
              role="row"
              className="border-b border-[var(--color-border)] text-xs text-[var(--color-muted)]"
            >
              {columns.map((column) => (
                <th
                  key={column}
                  scope="col"
                  role="columnheader"
                  className="px-3 py-2.5 font-medium first:pl-0"
                >
                  {column}
                </th>
              ))}
            </tr>
          </thead>
          {sources.map((source) => {
            const status = sourceStatus(source, zone);
            const credentialId = source.credentialId;
            const open = confirming?.sourceId === source._id ? confirming : null;
            const shown = pages?.selected === source._id;
            return (
              // One group per source: its facts, then its controls on a line of their own.
              <tbody
                key={source._id}
                role="rowgroup"
                className="border-b border-[var(--color-border)] last:border-b-0 max-sm:grid max-sm:gap-3 max-sm:py-4"
              >
                <tr role="row" className="max-sm:grid max-sm:gap-3">
                  <th
                    scope="row"
                    role="rowheader"
                    className="py-3 pr-3 text-left align-top font-normal max-sm:p-0"
                  >
                    <span className="block font-semibold text-[var(--color-fg)]">
                      {source.label}
                    </span>
                    <span className="block text-xs text-[var(--color-muted)]">
                      {KIND_NAMES[source.kind]} ·{' '}
                      <span className="font-mono [overflow-wrap:anywhere]">{source.locator}</span>
                    </span>
                    {/* Discovery runs after every completed sync and decides which systems this
                        source evidences. A failure leaves the last accepted set standing, so
                        nothing else on the row would say the newest pages were never read. */}
                    {source.lastDiscoveryError &&
                    source.lastDiscoveryError === source.lastPeopleExtractionError ? (
                      // Both passes failed alike: one failure, said once.
                      <span className="mt-1 block text-[13px] text-[var(--color-warn)]">
                        System discovery and people from its pages: {source.lastDiscoveryError}
                      </span>
                    ) : (
                      <>
                        {source.lastDiscoveryError ? (
                          <span className="mt-1 block text-[13px] text-[var(--color-warn)]">
                            System discovery: {source.lastDiscoveryError}
                          </span>
                        ) : null}
                        {/* The people extraction after each sync proposes the people its pages
                            name; a failure leaves the last proposals standing and nothing else
                            says so (W13-R9). */}
                        {source.lastPeopleExtractionError ? (
                          <span className="mt-1 block text-[13px] text-[var(--color-warn)]">
                            People from its pages: {source.lastPeopleExtractionError}
                          </span>
                        ) : null}
                      </>
                    )}
                  </th>
                  <Cell label="Trust">
                    {/* How far the source is trusted (A5): absent reads as team (A19). */}
                    <select
                      aria-label={`Trust for ${source.label}`}
                      value={sourceAuthorityOf(source)}
                      disabled={change.busy}
                      onChange={(event) => {
                        const authority = event.target.value as SourceAuthority;
                        onSourceChange(() => setAuthority({ sourceId: source._id, authority }), {
                          done: `${source.label} is now trusted as ${TRUST_NAMES[authority].toLowerCase()}.`,
                          refused: 'The trust was not changed.',
                        });
                      }}
                      className={`${INPUT_CLASS} min-w-[120px]`}
                    >
                      {SOURCE_AUTHORITIES.map((authority) => (
                        <option key={authority} value={authority}>
                          {TRUST_NAMES[authority]}
                        </option>
                      ))}
                    </select>
                  </Cell>
                  <Cell label="Pages">
                    <span className="tabular-nums">{source.pageCount}</span>
                  </Cell>
                  <Cell label="Status">
                    <span className="grid justify-items-start gap-1">
                      <Chip tone={status.tone}>{status.text}</Chip>
                      {status.lastRead ? (
                        <span className="text-xs text-[var(--color-muted)]">
                          Last read {status.lastRead}
                        </span>
                      ) : null}
                      {source.lastError ? (
                        <span className="text-[13px] text-[var(--color-warn)]">
                          {source.lastError}
                        </span>
                      ) : null}
                    </span>
                  </Cell>
                  {reader ? (
                    <Cell label={`Read by ${reader.name}`}>
                      {reader.excluded.has(source._id) ? 'No, left out at deploy' : 'Yes'}
                    </Cell>
                  ) : null}
                </tr>
                <tr role="row" className="max-sm:block">
                  <td role="cell" colSpan={columns.length} className="pb-4 max-sm:block max-sm:p-0">
                    <div className="flex flex-wrap gap-2">
                      {pages ? (
                        <Button
                          size="small"
                          aria-pressed={shown}
                          aria-label={`Show the pages of ${source.label}`}
                          onClick={() => pages.onSelect(source._id)}
                        >
                          Pages
                        </Button>
                      ) : null}
                      <Button
                        size="small"
                        disabled={change.busy}
                        aria-label={`Re-sync ${source.label}`}
                        onClick={() =>
                          onSourceChange(() => resync({ sourceId: source._id }), {
                            done: `Re-syncing ${source.label}; its page count updates when the sync finishes.`,
                            refused: 'The sync did not start.',
                          })
                        }
                      >
                        Re-sync
                      </Button>
                      {source.credentialId ? (
                        <>
                          <Button
                            size="small"
                            disabled={change.busy}
                            id={`rotate-control-${source._id}`}
                            aria-label={`Rotate the secret for ${source.label}`}
                            onClick={() => setRotatingSourceId(source._id)}
                          >
                            Rotate
                          </Button>
                          <Button
                            variant="danger"
                            size="small"
                            disabled={change.busy}
                            id={`revoke-${source._id}`}
                            aria-label={`Revoke the secret for ${source.label}`}
                            aria-expanded={open?.kind === 'revoke'}
                            onClick={() => setConfirming({ sourceId: source._id, kind: 'revoke' })}
                          >
                            Revoke
                          </Button>
                        </>
                      ) : null}
                      <Button
                        variant="danger"
                        size="small"
                        disabled={change.busy}
                        id={`unlink-${source._id}`}
                        aria-label={`Unlink ${source.label}`}
                        aria-expanded={open?.kind === 'unlink'}
                        onClick={() => setConfirming({ sourceId: source._id, kind: 'unlink' })}
                      >
                        Unlink
                      </Button>
                    </div>
                    {source.credentialId && rotatingSourceId === source._id ? (
                      <form
                        onSubmit={(event) => onRotate(event, source)}
                        className="mt-3 flex flex-wrap gap-2"
                      >
                        <label className="sr-only" htmlFor={`rotate-${source._id}`}>
                          {rotateFieldName(source.kind)}
                        </label>
                        <input
                          id={`rotate-${source._id}`}
                          name="credential"
                          type="password"
                          autoComplete="new-password"
                          required
                          placeholder={rotateFieldName(source.kind)}
                          className={`${INPUT_CLASS} w-full sm:w-80`}
                        />
                        <Button type="submit" size="small" disabled={change.busy}>
                          {rotating === source._id ? 'Rotating…' : 'Save'}
                        </Button>
                      </form>
                    ) : null}
                    {open ? (
                      <div className="mt-3 border-t border-[var(--color-border)] pt-3">
                        <SourceConfirmation
                          kind={open.kind}
                          label={source.label}
                          busy={change.busy}
                          onConfirm={() =>
                            open.kind === 'unlink'
                              ? onSourceChange(() => unlink({ sourceId: source._id }), {
                                  done: `Unlinked ${source.label}: its pages leave every employee's reading.`,
                                  refused: `${source.label} was not unlinked.`,
                                })
                              : credentialId
                                ? onSourceChange(() => revokeCredential({ credentialId }), {
                                    done: `Revoked the secret for ${source.label}; the next sync cannot read until you rotate in a new one.`,
                                    refused: 'The secret was not revoked.',
                                    focus: () => document.getElementById(`revoke-${source._id}`),
                                  })
                                : setConfirming(null)
                          }
                          onKeep={() => {
                            setConfirming(null);
                            document.getElementById(`${open.kind}-${source._id}`)?.focus();
                          }}
                        />
                      </div>
                    ) : null}
                  </td>
                </tr>
              </tbody>
            );
          })}
        </table>
      )}
    </section>
  );
}
