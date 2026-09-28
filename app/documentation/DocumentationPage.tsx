'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DOCS_NOTION_LOCATOR, serverKindHelp } from '@/docs/components';
import { REPOSITORY_URL } from '@/setup/quickstart';
import { LiveStatus, refusalText, useChange } from '../agent/[agentId]/live-status';

type SourceKind = 'folder' | 'git' | 'urls' | 'mcp';
type ServerKind = 'notion' | 'confluence' | 'drive' | 'generic';

export function locatorForSourceKind(kind: SourceKind): string {
  return kind === 'folder' ? '.' : '';
}

/**
 * The link form's text fields once a source has been linked: both empty, so
 * the next source's label and location are typed into a blank field instead
 * of over the last one's. The kind stays as chosen, and the folder default
 * (`.`) is not offered again: that folder has just been linked.
 *
 * Returns:
 *   The label and locator to show.
 */
export function linkFormAfterLink(): { label: string; locator: string } {
  return { label: '', locator: '' };
}

/** The author guide to the page shapes day0 reads, as the repository publishes it. */
export const AUTHOR_GUIDE_URL = `${REPOSITORY_URL}/blob/main/docs/running/documentation.md`;

/**
 * The secret a link sends for a source kind (E-74).
 *
 * An MCP server's connection secret is required; a git repository or a
 * list of wiki pages may carry the reader's own secret, sent only when one
 * was typed; a folder takes none.
 *
 * @param kind - The selected source kind.
 * @param typed - What the secret field held.
 */
export function credentialForLink(kind: SourceKind, typed: string): string | undefined {
  if (kind === 'mcp') return typed;
  return (kind === 'git' || kind === 'urls') && typed !== '' ? typed : undefined;
}

/**
 * The optional reader secret of a private repository or a wiki behind a
 * login: entered here, encrypted when submitted, and never written into the
 * location itself (E-74).
 *
 * Args:
 *   props: The selected source kind.
 *
 * Returns:
 *   The field and its help line for a git or URL source, nothing otherwise.
 */
export function ReaderSecretField(props: { kind: SourceKind }): React.ReactNode {
  if (props.kind !== 'git' && props.kind !== 'urls') return null;
  return (
    <div className="grid gap-1">
      <label className="text-xs text-[var(--color-muted)]" htmlFor="reader-secret">
        Reader secret (optional)
      </label>
      <input
        id="reader-secret"
        name="credential"
        type="password"
        autoComplete="new-password"
        placeholder={props.kind === 'git' ? 'Access token, or user:token' : 'Access token'}
        className="min-h-11 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
      />
      <p className="text-xs text-[var(--color-muted)]">
        {props.kind === 'git'
          ? 'For a private repository. It is encrypted when submitted, sent only to the repository host, and never displayed again.'
          : 'For pages behind a login, all on one https site. It is encrypted when submitted, sent only to that site, and never displayed again.'}
      </p>
    </div>
  );
}

/**
 * Say what this source kind will actually reach, and what has to be running.
 *
 * Three of the four kinds are read by the backend itself and depend on nothing
 * else; the fourth reaches an MCP server, and only one of those servers is one
 * day0 bundles a component for. Saying so in the form is what keeps a reader
 * from assuming every documentation source needs a container started.
 *
 * Args:
 *   props: The selected source kind, and the MCP server kind when it applies.
 *
 * Returns:
 *   The help line under the form fields.
 */
export function SourceKindHelp(props: {
  kind: SourceKind;
  serverKind: ServerKind;
}): React.ReactNode {
  return (
    <p className="text-xs text-[var(--color-muted)]">
      {props.kind === 'mcp'
        ? `${serverKindHelp(props.serverKind)} The secret is encrypted when submitted and is never displayed again.`
        : 'The backend reads this location itself. No day0 component has to be running.'}
    </p>
  );
}

/**
 * The second step of a destructive change to a linked source (P6-7): what it
 * does, the change, and Keep, which takes focus so Enter does nothing harmful.
 *
 * Args:
 *   props: What is being confirmed, for which source, and the two choices.
 *
 * Returns:
 *   The confirmation row under the source.
 */
export function SourceConfirmation(props: {
  kind: 'unlink' | 'revoke';
  label: string;
  busy: boolean;
  onConfirm: () => void;
  onKeep: () => void;
}): React.ReactNode {
  const unlinking = props.kind === 'unlink';
  return (
    <div
      role="group"
      aria-label={unlinking ? `Unlink ${props.label}?` : `Revoke the secret for ${props.label}?`}
      className="basis-full border-t border-[var(--color-border)] pt-3 text-xs"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        props.onKeep();
      }}
    >
      <p className="mb-2 text-[var(--color-fg)]">
        {unlinking
          ? `Unlink ${props.label}? Its pages leave every employee's reading, and the systems only it documents lose their evidence.`
          : `Revoke the secret for ${props.label}? Day0 stops reading this location until you rotate in a new secret.`}
      </p>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={props.busy}
          onClick={props.onConfirm}
          className="min-h-11 rounded px-3 bg-[var(--color-danger)]/20 text-[var(--color-danger)] disabled:opacity-50"
        >
          {unlinking ? 'Confirm unlink' : 'Confirm revoke'}
        </button>
        <button
          type="button"
          autoFocus
          disabled={props.busy}
          onClick={props.onKeep}
          className="min-h-11 rounded px-3 border border-[var(--color-border)] disabled:opacity-50"
        >
          {unlinking ? 'Keep it linked' : 'Keep the secret'}
        </button>
      </div>
    </div>
  );
}

/** Owner-level documentation source management. */
export function DocumentationPage(): React.ReactNode {
  const config = useQuery(api.config.surfaceMode);
  const sources = useQuery(api.docSources.listMine);
  const link = useAction(api.docSources.link);
  const rotateCredential = useAction(api.docSources.rotateCredential);
  const revokeCredential = useMutation(api.credentials.revoke);
  const unlink = useMutation(api.docSources.unlink);
  const resync = useMutation(api.docSources.resync);
  const [kind, setKind] = useState<SourceKind>('folder');
  const [label, setLabel] = useState('Team folder');
  const [locator, setLocator] = useState('.');
  const [serverKind, setServerKind] = useState<ServerKind>('notion');
  const [busy, setBusy] = useState(false);
  const [rotatingSourceId, setRotatingSourceId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<{
    sourceId: Id<'docSources'>;
    kind: 'unlink' | 'revoke';
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const list = useRef<HTMLElement>(null);
  const change = useChange(list);
  const busySourceId = change.busy ? rotatingSourceId : null;

  /** One change to one linked source, said in the list's live region. */
  function onSourceChange(
    call: () => Promise<unknown>,
    words: { done: string; refused: string; after?: () => void },
  ): void {
    setConfirming(null);
    change.run(call, words);
  }

  /** Link the submitted source and clear its write-only credential field. */
  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const formData = new FormData(form);
    const credential = String(formData.get('credential') || '');
    form.reset();
    setBusy(true);
    setError(null);
    try {
      await link({
        label,
        kind,
        locator,
        serverKind: kind === 'mcp' ? serverKind : undefined,
        credential: credentialForLink(kind, credential),
      });
      const cleared = linkFormAfterLink();
      setLabel(cleared.label);
      setLocator(cleared.locator);
    } catch (failure) {
      setError(refusalText(failure, 'The location was not linked.'));
    } finally {
      setBusy(false);
    }
  }

  /** Rotate one source credential and clear its write-only input immediately. */
  function onRotate(
    event: FormEvent<HTMLFormElement>,
    source: { _id: Id<'docSources'>; label: string },
  ): void {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = String(new FormData(form).get('credential') || '');
    form.reset();
    onSourceChange(() => rotateCredential({ sourceId: source._id, credential }), {
      done: `The secret for ${source.label} is replaced; the next sync reads with it.`,
      refused: 'The secret was not replaced.',
      after: () => setRotatingSourceId(null),
    });
  }

  const isReal = config?.mode === 'real';
  return (
    <main className="max-w-5xl mx-auto w-full px-6 py-10">
      <div className="flex items-start justify-between gap-4 mb-8">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Documentation</h1>
          <p className="text-sm text-[var(--color-muted)] mt-2">
            Link read-only locations. Day0 learns systems and action shapes from their pages.
          </p>
        </div>
        <span className="text-xs border border-[var(--color-border)] rounded-full px-3 py-1">
          {config?.label || 'loading'}
        </span>
      </div>

      {!isReal ? (
        <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
          <h2 className="font-medium">Demo docs (seeded)</h2>
          <p className="text-sm text-[var(--color-muted)] mt-2">
            Linking is a local-run feature. The hosted mock uses its disclosed synthetic pages.
          </p>
        </section>
      ) : (
        <>
          <section
            ref={list}
            tabIndex={-1}
            aria-label="Linked documentation"
            className="space-y-3 mb-8"
          >
            <LiveStatus outcome={change.outcome} />
            {(sources || []).map((source) => (
              <article
                key={source._id}
                className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4"
              >
                <div>
                  <div className="flex items-center gap-2">
                    <h2 className="font-medium">{source.label}</h2>
                    <span className="text-[10px] uppercase text-[var(--color-accent)]">
                      {source.kind}
                    </span>
                    <span className="text-[10px] rounded px-2 py-0.5 bg-[var(--color-bg)]">
                      {source.status}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--color-muted)] mt-1 break-all">
                    {source.locator}
                  </p>
                  <p className="text-xs text-[var(--color-muted)] mt-1">
                    {source.pageCount} pages{source.lastError ? ` - ${source.lastError}` : ''}
                  </p>
                  {/* Discovery runs after every completed sync and decides which
                      systems this source evidences. A failure leaves the last
                      accepted set standing, so nothing else on the page would
                      change to say the newest pages were never read. */}
                  {source.lastDiscoveryError ? (
                    <p className="text-xs text-[var(--color-warn)] mt-1">
                      System discovery: {source.lastDiscoveryError}
                    </p>
                  ) : null}
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {source.credentialId && rotatingSourceId === source._id ? (
                    <form
                      onSubmit={(event) => onRotate(event, source)}
                      className="flex flex-wrap gap-2"
                    >
                      <label className="sr-only" htmlFor={`rotate-${source._id}`}>
                        {source.kind === 'mcp' ? 'New connection secret' : 'New reader secret'}
                      </label>
                      <input
                        id={`rotate-${source._id}`}
                        name="credential"
                        type="password"
                        autoComplete="new-password"
                        required
                        placeholder={
                          source.kind === 'mcp' ? 'New connection secret' : 'New reader secret'
                        }
                        className="min-h-11 text-xs px-3 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                      />
                      <button
                        disabled={busySourceId === source._id}
                        className="min-h-11 text-xs border border-[var(--color-border)] rounded px-3 disabled:opacity-50"
                      >
                        {busySourceId === source._id ? 'Rotating...' : 'Save'}
                      </button>
                    </form>
                  ) : null}
                  {source.credentialId ? (
                    <>
                      <button
                        type="button"
                        disabled={change.busy}
                        aria-label={`Rotate the secret for ${source.label}`}
                        onClick={() => setRotatingSourceId(source._id)}
                        className="min-h-11 text-xs border border-[var(--color-border)] rounded px-3 disabled:opacity-50"
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        disabled={change.busy}
                        id={`revoke-${source._id}`}
                        aria-label={`Revoke the secret for ${source.label}`}
                        aria-expanded={
                          confirming?.sourceId === source._id && confirming.kind === 'revoke'
                        }
                        onClick={() => setConfirming({ sourceId: source._id, kind: 'revoke' })}
                        className="min-h-11 text-xs border border-[var(--color-danger)]/40 text-[var(--color-danger)] rounded px-3 disabled:opacity-50"
                      >
                        Revoke
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    disabled={change.busy}
                    aria-label={`Re-sync ${source.label}`}
                    onClick={() =>
                      onSourceChange(() => resync({ sourceId: source._id }), {
                        done: `Re-syncing ${source.label}; its page count updates when the sync finishes.`,
                        refused: 'The sync did not start.',
                      })
                    }
                    className="min-h-11 text-xs border border-[var(--color-border)] rounded px-3 disabled:opacity-50"
                  >
                    Re-sync
                  </button>
                  <button
                    type="button"
                    disabled={change.busy}
                    id={`unlink-${source._id}`}
                    aria-label={`Unlink ${source.label}`}
                    aria-expanded={
                      confirming?.sourceId === source._id && confirming.kind === 'unlink'
                    }
                    onClick={() => setConfirming({ sourceId: source._id, kind: 'unlink' })}
                    className="min-h-11 text-xs border border-[var(--color-danger)]/40 text-[var(--color-danger)] rounded px-3 disabled:opacity-50"
                  >
                    Unlink
                  </button>
                </div>
                {confirming?.sourceId === source._id ? (
                  <SourceConfirmation
                    kind={confirming.kind}
                    label={source.label}
                    busy={change.busy}
                    onConfirm={() =>
                      confirming.kind === 'unlink'
                        ? onSourceChange(() => unlink({ sourceId: source._id }), {
                            done: `Unlinked ${source.label}: its pages leave every employee's reading.`,
                            refused: `${source.label} was not unlinked.`,
                          })
                        : onSourceChange(
                            () => revokeCredential({ credentialId: source.credentialId! }),
                            {
                              done: `Revoked the secret for ${source.label}; the next sync cannot read until you rotate in a new one.`,
                              refused: 'The secret was not revoked.',
                            },
                          )
                    }
                    onKeep={() => {
                      setConfirming(null);
                      document.getElementById(`${confirming.kind}-${source._id}`)?.focus();
                    }}
                  />
                ) : null}
              </article>
            ))}
            {sources?.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">No locations linked yet.</p>
            ) : null}
          </section>

          <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
            <h2 className="font-semibold">Link a documentation location</h2>
            <p className="text-xs text-[var(--color-muted)] mt-1 mb-4">
              Write pages in the shapes{' '}
              <a
                href={AUTHOR_GUIDE_URL}
                target="_blank"
                rel="noreferrer"
                className="underline text-[var(--color-accent)]"
              >
                the documentation author guide
              </a>{' '}
              describes, so day0 finds each system, address, credential and intake queue on them.
            </p>
            <form onSubmit={onSubmit} className="grid gap-3">
              <label htmlFor="source-kind" className="text-xs text-[var(--color-muted)]">
                Kind of location
              </label>
              <select
                id="source-kind"
                value={kind}
                onChange={(event) => {
                  const nextKind = event.target.value as SourceKind;
                  setKind(nextKind);
                  setLocator(locatorForSourceKind(nextKind));
                }}
                className="min-h-11 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              >
                <option value="folder">Folder of Markdown</option>
                <option value="git">Git repository</option>
                <option value="urls">List of URLs</option>
                <option value="mcp">MCP server</option>
              </select>
              <label htmlFor="source-label" className="text-xs text-[var(--color-muted)]">
                Location label
              </label>
              <input
                id="source-label"
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Location label"
                className="min-h-11 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              />
              <label htmlFor="source-locator" className="text-xs text-[var(--color-muted)]">
                Where it is
              </label>
              <textarea
                id="source-locator"
                value={locator}
                onChange={(event) => setLocator(event.target.value)}
                placeholder={
                  kind === 'folder'
                    ? 'Relative to /docs, for example .'
                    : kind === 'mcp' && serverKind === 'notion'
                      ? DOCS_NOTION_LOCATOR
                      : 'Location URL, or one URL per line'
                }
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded min-h-20"
              />
              {kind === 'mcp' ? (
                <div className="grid sm:grid-cols-2 gap-3">
                  <label className="grid gap-1 text-xs text-[var(--color-muted)]">
                    Server
                    <select
                      value={serverKind}
                      onChange={(event) => setServerKind(event.target.value as typeof serverKind)}
                      className="min-h-11 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-sm text-[var(--color-fg)]"
                    >
                      <option value="notion">Notion</option>
                      <option value="confluence">Confluence</option>
                      <option value="drive">Google Drive</option>
                      <option value="generic">Generic resources</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-[var(--color-muted)]">
                    Connection secret
                    <input
                      name="credential"
                      type="password"
                      autoComplete="new-password"
                      required
                      placeholder="Connection secret"
                      className="min-h-11 px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded text-sm text-[var(--color-fg)]"
                    />
                  </label>
                </div>
              ) : null}
              <ReaderSecretField kind={kind} />
              <SourceKindHelp kind={kind} serverKind={serverKind} />
              <p role="alert" className="text-xs text-[var(--color-danger)]">
                {error ?? ''}
              </p>
              <button
                disabled={busy}
                className="min-h-11 justify-self-start px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50"
              >
                {busy ? 'Linking...' : 'Link location'}
              </button>
            </form>
          </section>
        </>
      )}
    </main>
  );
}
