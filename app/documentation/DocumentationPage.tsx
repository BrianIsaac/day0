'use client';

import { useState, type FormEvent } from 'react';
import { useAction, useMutation, useQuery } from 'convex/react';
import { api } from '@convex/_generated/api';
import type { Id } from '@convex/_generated/dataModel';
import { DOCS_NOTION_LOCATOR, serverKindHelp } from '@/docs/components';
import { plainErrorMessage } from '@/lib/plain-error';

type SourceKind = 'folder' | 'git' | 'urls' | 'mcp';
type ServerKind = 'notion' | 'confluence' | 'drive' | 'generic';

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
export function SourceKindHelp(props: { kind: SourceKind; serverKind: ServerKind }): React.ReactNode {
  return (
    <p className="text-xs text-[var(--color-muted)]">
      {props.kind === 'mcp'
        ? `${serverKindHelp(props.serverKind)} The secret is encrypted when submitted and is never displayed again.`
        : 'The backend reads this location itself. No day0 component has to be running.'}
    </p>
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
  const [busySourceId, setBusySourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
        credential: kind === 'mcp' ? credential : undefined,
      });
    } catch (failure) {
      setError(plainErrorMessage((failure as Error).message));
    } finally {
      setBusy(false);
    }
  }

  /** Rotate one source credential and clear its write-only input immediately. */
  async function onRotate(
    event: FormEvent<HTMLFormElement>,
    sourceId: Id<'docSources'>,
  ): Promise<void> {
    event.preventDefault();
    const form = event.currentTarget;
    const credential = String(new FormData(form).get('credential') || '');
    form.reset();
    setBusySourceId(sourceId);
    setError(null);
    try {
      await rotateCredential({
        sourceId,
        credential,
      });
      setRotatingSourceId(null);
    } catch (failure) {
      setError(plainErrorMessage((failure as Error).message));
    } finally {
      setBusySourceId(null);
    }
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
          <section className="space-y-3 mb-8">
            {(sources || []).map((source) => (
              <article
                key={source._id}
                className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-4 flex items-center justify-between gap-4"
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
                </div>
                <div className="flex flex-wrap justify-end gap-2">
                  {source.kind === 'mcp' && rotatingSourceId === source._id ? (
                    <form
                      onSubmit={(event) => void onRotate(event, source._id)}
                      className="flex gap-2"
                    >
                      <label className="sr-only" htmlFor={`rotate-${source._id}`}>
                        New connection secret
                      </label>
                      <input
                        id={`rotate-${source._id}`}
                        name="credential"
                        type="password"
                        autoComplete="new-password"
                        required
                        placeholder="New connection secret"
                        className="text-xs px-3 py-1.5 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                      />
                      <button
                        disabled={busySourceId === source._id}
                        className="text-xs border border-[var(--color-border)] rounded px-3 py-1.5 disabled:opacity-50"
                      >
                        {busySourceId === source._id ? 'Rotating...' : 'Save'}
                      </button>
                    </form>
                  ) : null}
                  {source.kind === 'mcp' && source.credentialId ? (
                    <>
                      <button
                        type="button"
                        onClick={() => setRotatingSourceId(source._id)}
                        className="text-xs border border-[var(--color-border)] rounded px-3 py-1.5"
                      >
                        Rotate
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          void revokeCredential({ credentialId: source.credentialId! })
                        }
                        className="text-xs border border-[var(--color-danger)]/40 text-[var(--color-danger)] rounded px-3 py-1.5"
                      >
                        Revoke
                      </button>
                    </>
                  ) : null}
                  <button
                    type="button"
                    onClick={() => void resync({ sourceId: source._id })}
                    className="text-xs border border-[var(--color-border)] rounded px-3 py-1.5"
                  >
                    Re-sync
                  </button>
                  <button
                    type="button"
                    onClick={() => void unlink({ sourceId: source._id })}
                    className="text-xs border border-[var(--color-danger)]/40 text-[var(--color-danger)] rounded px-3 py-1.5"
                  >
                    Unlink
                  </button>
                </div>
              </article>
            ))}
            {sources?.length === 0 ? (
              <p className="text-sm text-[var(--color-muted)]">No locations linked yet.</p>
            ) : null}
          </section>

          <section className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-xl p-5">
            <h2 className="font-semibold mb-4">Link a documentation location</h2>
            <form onSubmit={onSubmit} className="grid gap-3">
              <select
                value={kind}
                onChange={(event) => setKind(event.target.value as SourceKind)}
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              >
                <option value="folder">Folder of Markdown</option>
                <option value="git">Git repository</option>
                <option value="urls">List of URLs</option>
                <option value="mcp">MCP server</option>
              </select>
              <input
                value={label}
                onChange={(event) => setLabel(event.target.value)}
                placeholder="Location label"
                className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
              />
              <textarea
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
                  <select
                    value={serverKind}
                    onChange={(event) => setServerKind(event.target.value as typeof serverKind)}
                    className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                  >
                    <option value="notion">Notion</option>
                    <option value="confluence">Confluence</option>
                    <option value="drive">Google Drive</option>
                    <option value="generic">Generic resources</option>
                  </select>
                  <input
                    name="credential"
                    type="password"
                    autoComplete="new-password"
                    required
                    placeholder="Connection secret"
                    className="px-3 py-2 bg-[var(--color-bg)] border border-[var(--color-border)] rounded"
                  />
                </div>
              ) : null}
              <SourceKindHelp kind={kind} serverKind={serverKind} />
              {error ? <p className="text-xs text-[var(--color-danger)]">{error}</p> : null}
              <button
                disabled={busy}
                className="justify-self-start px-4 py-2 rounded bg-[var(--color-accent)] text-[var(--color-bg)] font-medium disabled:opacity-50"
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
